import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

// Pass retained baseline/candidate bundles exporting verifyRuntime and Compiler.
// Each bundle must use the real production implementations. Run without other
// local native tests or benchmarks; never alter the selected runtime in this tool.
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This profile targets Apple silicon macOS.');
const [baseline, candidate] = process.argv.slice(2, 4).map((p) => path.resolve(p));
if (!baseline || !candidate) throw new Error('Pass baseline and candidate module paths.');
const runtime = path.resolve(process.argv[4] ?? 'resources/runtime/mac-arm64');
const pairs = Number(process.argv[5] ?? 5);
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 10) throw new Error('Choose 1–10 pairs.');
const root = await fs.mkdtemp(path.resolve('test-results/runtime-verification-pairs-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  schemaVersion: 1,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(),
  host: {
    cpu: os.cpus()[0]?.model,
    memoryBytes: os.totalmem(),
    osVersion: os.version(),
    node: process.version,
  },
  runtime,
  manifestSha256: hash(await fs.readFile(path.join(runtime, 'manifest.json'))),
  modules: {},
  warmups: [],
  samples: [],
  limits: [
    'Five default alternating pairs on one development Mac; not a supported-device or population p95 claim.',
    'Both implementations run in one Node host. Sampled host RSS is not isolated variant memory or whole-app/native-tree memory.',
    'One real warmup compile per variant precedes measurement. Separate work folders retain each variant’s TeX cache; OS caches are not purged.',
    'Each standalone verification rehashes the runtime. Each compile also does its own full verification, so these stage times must not be added as a single build duration.',
    'Complete production compiler/verifier bundles are supplied explicitly. Retain their source identities and build commands alongside this report.',
  ],
};
const variants = {};
const retainPdf = async (result, file) => {
  if (result.status !== 'success' || !result.pdf?.length || result.pdf.length > 256 * 1024)
    throw new Error('The synthetic compile did not return a bounded successful PDF: ' + result.log);
  const bytes = Buffer.from(result.pdf);
  await fs.writeFile(path.join(root, file), bytes);
  return {
    file,
    bytes: bytes.length,
    sha256: hash(bytes),
    buildFingerprint: result.buildFingerprint,
    log: result.log,
  };
};
const project = {
  id: 'verification-performance',
  name: 'Verification performance',
  mainFile: 'main.tex',
  revision: 0,
  files: [
    {
      path: 'main.tex',
      content:
        '\\documentclass{article}\\usepackage[margin=1in]{geometry}\\begin{document}\\section*{Taylor Example}A synthetic performance resume.\\end{document}',
    },
  ],
};
report.project = project;
const measure = async (operation) => {
  const started = performance.now(),
    cpu = process.cpuUsage();
  let peakHostRssBytes = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peakHostRssBytes = Math.max(peakHostRssBytes, process.memoryUsage().rss);
  }, 10);
  try {
    const result = await operation(),
      used = process.cpuUsage(cpu);
    return {
      result,
      metrics: {
        elapsedMs: performance.now() - started,
        cpuUserMs: used.user / 1000,
        cpuSystemMs: used.system / 1000,
        peakHostRssBytes,
      },
    };
  } finally {
    clearInterval(timer);
  }
};
try {
  for (const [name, file] of Object.entries({ baseline, candidate })) {
    const source = await fs.readFile(file);
    const module = await import(pathToFileURL(file));
    if (typeof module.verifyRuntime !== 'function' || typeof module.Compiler !== 'function')
      throw new Error('Both modules must export verifyRuntime and Compiler.');
    report.modules[name] = { file, bytes: source.length, sha256: hash(source) };
    const verified = await module.verifyRuntime(runtime);
    if (report.pin && JSON.stringify(report.pin) !== JSON.stringify(verified.pin))
      throw new Error('Runtime identities differ.');
    report.pin = verified.pin;
    const compiler = new module.Compiler(runtime, path.join(root, name, 'builds'));
    variants[name] = { module, compiler };
    const result = await compiler.compile({ ...project, runtime: report.pin });
    report.warmups.push({ variant: name, pdf: await retainPdf(result, name + '-warmup.pdf') });
  }
  for (let pair = 1; pair <= pairs; pair++) {
    for (const name of pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      const { module, compiler } = variants[name];
      const verification = await measure(() => module.verifyRuntime(runtime, report.pin));
      if (JSON.stringify(verification.result.pin) !== JSON.stringify(report.pin))
        throw new Error('Runtime identity changed.');
      const input = {
        ...project,
        runtime: report.pin,
        revision: pair,
        files: [
          { path: 'main.tex', content: project.files[0].content + '\n% measured edit ' + pair },
        ],
      };
      const compile = await measure(() => compiler.compile(input));
      const sample = {
        pair,
        variant: name,
        sourceSha256: hash(Buffer.from(JSON.stringify(input))),
        verification: verification.metrics,
        compile: compile.metrics,
        pdf: await retainPdf(compile.result, `${pair}-${name}.pdf`),
      };
      report.samples.push(sample);
      await fs.writeFile(
        path.join(root, 'measurements.json'),
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(
        `${pair} ${name}: verification ${sample.verification.elapsedMs.toFixed(1)} ms; compile ${sample.compile.elapsedMs.toFixed(1)} ms`,
      );
    }
  }
  if (hash(await fs.readFile(path.join(runtime, 'manifest.json'))) !== report.manifestSha256)
    throw new Error('Runtime manifest changed during measurement.');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence: ' + root);
}
