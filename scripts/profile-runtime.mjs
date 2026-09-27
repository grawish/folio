import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { observeSubprocess } from './lib/subprocess-timeline.mjs';
import { buildProcessSampler, ProcessSampler } from './mac-process-sampler.mjs';
import { RuntimeManager } from '../electron/core/runtime-manager.ts';
import { Compiler } from '../electron/core/compiler.ts';

// Developer-only measurement. Use the real installer, verifier, fsync and
// sandboxed compiler; do not run alongside native tests or other benchmarks.
const samples = Number(process.argv[2] ?? 3);
if (!Number.isInteger(samples) || samples < 1 || samples > 10)
  throw new Error('Choose 1–10 samples.');
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This profile targets the Apple silicon Mac app.');
const root = await fs.mkdtemp(path.resolve('test-results/runtime-profile-'));
const bundled = path.resolve('resources/runtime/mac-arm64');
const comparison = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
if (comparison && samples > 5) throw new Error('Choose 1–5 comparison pairs.');
const totalSamples = comparison ? samples * 2 : samples;
const processObserver = comparison ? await buildProcessSampler(root) : undefined;
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const sourceFiles = [
  'electron/core/runtime-manager.ts',
  'electron/core/runtime.ts',
  'electron/core/compiler.ts',
  'scripts/profile-runtime.mjs',
  'scripts/lib/subprocess-timeline.mjs',
  'electron/core/compiler-limits.ts',
  'electron/core/compiler-storage.ts',
  'electron/core/save-io.ts',
  'resources/runtime/mac-arm64/manifest.json',
  ...(comparison
    ? [
        path.relative(process.cwd(), path.join(comparison, 'manifest.json')),
        'scripts/mac-process-sampler.mjs',
        'scripts/sample-mac-processes.c',
      ]
    : []),
];
const report = {
  schemaVersion: 3,
  sourceCommit: childProcess
    .execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
    .trim(),
  startedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: os.version(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
  },
  sources: Object.fromEntries(
    await Promise.all(sourceFiles.map(async (file) => [file, await hash(file)])),
  ),
  scope:
    'Production backend invoked from Node with fresh isolated app data. Not renderer or full-app startup timing.',
  ...(comparison
    ? {
        comparison: {
          baseline: path.relative(process.cwd(), bundled),
          candidate: path.relative(process.cwd(), comparison),
          pairs: samples,
          order: 'AB, BA, AB, BA, AB (truncated to the requested pairs)',
          observerSha256: await hash(processObserver),
          observerIntervalMs: 100,
          scope:
            'Complete runtime variants: library relocation, signatures and file sizes may also differ. This is not isolation of one launcher instruction.',
        },
      }
    : {}),
  limits: [
    'OS disk caches are not purged; fresh profile means new managed runtime and TeX cache, not cold physical storage.',
    'Operation sums overlap because four files copy concurrently; sums are not additive wall-clock shares.',
    'Instrumentation adds timing overhead. Memory/CPU here describe the Node host, not the native compiler process tree.',
    'Subprocess events time stdout/stderr receipt in the parent. Buffered output can delay a marker; marker gaps are not pure engine CPU time.',
    ...(comparison
      ? [
          'Native process counters are sampled at 100 ms, not traced continuously. Short-lived work and final CPU between the last sample and exit may be missed; process receipt intervals are not pure CPU time.',
          'The sampler observes this Node host and its descendants, including its own short-lived observer. Biber analysis must select Biber process identities and not use the aggregate as Biber CPU.',
        ]
      : []),
    'Raw samples are retained; three samples do not establish population p95 or supported-device performance.',
  ],
  samples: [],
};
let phase = 'setup',
  io = new Map(),
  peakRss = 0;
const recordIo = (method, elapsed) => {
  const key = phase + '/' + method;
  let durations = io.get(key);
  if (!durations) io.set(key, (durations = []));
  durations.push(elapsed);
};
const originalOpen = fs.open;
const originals = new Map();
for (const method of ['lstat', 'readdir', 'mkdir', 'rename', 'rm']) {
  const original = fs[method];
  originals.set(method, original);
  fs[method] = async function (...args) {
    const start = performance.now();
    try {
      return await original.apply(this, args);
    } finally {
      recordIo(method, performance.now() - start);
    }
  };
}
fs.open = async function (...args) {
  const start = performance.now();
  const handle = await originalOpen.apply(this, args);
  recordIo('open', performance.now() - start);
  for (const method of ['readFile', 'writeFile', 'sync']) {
    const original = handle[method];
    handle[method] = async function (...values) {
      const start = performance.now();
      try {
        return await original.apply(this, values);
      } finally {
        recordIo(
          method === 'sync' ? (args[1] === 'wx' ? 'fileSync' : 'directorySync') : method,
          performance.now() - start,
        );
      }
    };
  }
  return handle;
};
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 100);
sampler.unref();
const summarizeIo = () =>
  Object.fromEntries(
    [...io].map(([key, values]) => {
      values.sort((a, b) => a - b);
      return [
        key,
        {
          count: values.length,
          sumMs: values.reduce((a, b) => a + b, 0),
          medianMs: values[Math.floor(values.length / 2)],
          maxMs: values.at(-1),
        },
      ];
    }),
  );
let activeSample;
let activeProcessSampler;
const originalSpawn = childProcess.spawn;
const originalRun = Compiler.prototype.run;
const originalCompile = Compiler.prototype.compile;
childProcess.spawn = function (...args) {
  const child = originalSpawn.apply(this, args);
  if (activeSample) {
    const { sample, sampleStart } = activeSample;
    sample.processes.push(
      Object.assign(
        observeSubprocess(child, () => performance.now() - sampleStart),
        { phase, command: args[0] },
      ),
    );
  }
  return child;
};
syncBuiltinESMExports();
Compiler.prototype.compile = function (...args) {
  const context = activeSample;
  const project = args[0];
  const result = originalCompile.apply(this, args);
  if (!comparison || !context) return result;
  return result.then((value) => {
    if (value.status !== 'success' || !value.pdf || value.pdf.length > 256 * 1024)
      throw new Error('The measured synthetic document did not produce a bounded successful PDF.');
    const bytes = Buffer.from(value.pdf);
    const file = `pdfs/${context.sample.index}-${context.sample.compilations.length + 1}.pdf`;
    context.pdfs.push({ file, bytes });
    context.sample.compilations.push({
      projectId: project.id,
      revision: project.revision,
      files: project.files,
      sourceSha256: createHash('sha256').update(JSON.stringify(project.files)).digest('hex'),
      status: value.status,
      pdf: { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    });
    return value;
  });
};
Compiler.prototype.run = async function (...args) {
  const sample = activeSample?.sample;
  const index = sample?.processes.length;
  const result = await originalRun.apply(this, args);
  if (!sample || sample.processes.length !== index + 1)
    throw new Error('Expected one observed compiler subprocess.');
  const trace = sample.processes[index];
  const log = trace.chunks.map((chunk) => Buffer.from(chunk.base64, 'base64').toString()).join('');
  if (trace.truncated || trace.error || log !== result.log || trace.exitCode !== result.code)
    throw new Error('Subprocess trace differs from the compiler result.');
  trace.compilerLogSha256 = createHash('sha256').update(result.log).digest('hex');
  trace.matchesCompilerResult = true;
  return result;
};
try {
  for (let index = 0; index < totalSamples; index++) {
    const sampleRoot = path.join(root, String(index + 1));
    await fs.mkdir(sampleRoot);
    io = new Map();
    peakRss = process.memoryUsage().rss;
    const sample = {
      index: index + 1,
      steps: [],
      checkpoints: [],
      methods: [],
      processes: [],
      passed: false,
    };
    report.samples.push(sample);
    const sampleStart = performance.now();
    const candidate =
      comparison && (Math.floor(index / 2) % 2 === 0 ? index % 2 === 1 : index % 2 === 0);
    const selectedBundle = candidate ? comparison : bundled;
    sample.runtimeRoot = path.relative(process.cwd(), selectedBundle);
    if (comparison) {
      sample.pair = Math.floor(index / 2) + 1;
      sample.variant = candidate ? 'comparison' : 'baseline';
      sample.compilations = [];
      activeProcessSampler = new ProcessSampler(processObserver, process.pid, 100);
      const take = activeProcessSampler.take.bind(activeProcessSampler);
      activeProcessSampler.take = () => {
        activeProcessSampler.phase = phase;
        return take();
      };
      sample.nativeProcessObserver = {
        startOffsetMs: activeProcessSampler.started - sampleStart,
        samples: activeProcessSampler.samples,
      };
      await activeProcessSampler.start();
    }
    activeSample = { sample, sampleStart, pdfs: [] };
    const cpuStart = process.cpuUsage();
    const instrument = (object, method) => {
      const original = object[method];
      if (typeof original !== 'function') throw new Error('Profile method changed: ' + method);
      object[method] = async function (...args) {
        const start = performance.now(),
          previous = phase;
        if (method === 'probe') phase = 'offlineSelfTest';
        try {
          return await original.apply(this, args);
        } finally {
          sample.methods.push({
            method,
            phase,
            startedAtMs: start - sampleStart,
            elapsedMs: performance.now() - start,
          });
          if (method === 'probe') phase = previous;
        }
      };
    };
    const step = async (name, operation) => {
      const previous = phase;
      phase = name;
      const start = performance.now(),
        cpu = process.cpuUsage();
      try {
        const result = await operation();
        if (result?.ready === false || result?.status === 'error')
          throw new Error(result.message ?? result.log ?? 'Operation failed');
        return result;
      } finally {
        const used = process.cpuUsage(cpu);
        sample.steps.push({
          name,
          startedAtMs: start - sampleStart,
          elapsedMs: performance.now() - start,
          cpuUserMs: used.user / 1000,
          cpuSystemMs: used.system / 1000,
        });
        phase = previous;
      }
    };
    const managed = path.join(sampleRoot, 'runtimes');
    const manager = new RuntimeManager(selectedBundle, managed, {
      checkpoint: async (name) => {
        sample.checkpoints.push({ name, atMs: performance.now() - sampleStart });
        if (name === 'staged') phase = 'verifyStagedAndRecordReady';
        if (name === 'tested') phase = 'publishPointer';
        if (name === 'published') phase = 'cleanup';
      },
    });
    for (const method of ['install', 'probe', 'publish', 'cleanup', 'acquire'])
      instrument(manager, method);
    await step('freshInitialize', () => manager.initialize());
    const status = await step('freshStatus', () => manager.status());
    sample.runtimePin = status.pin;
    const compiler = new Compiler(manager, path.join(sampleRoot, 'builds'));
    instrument(compiler, 'run');
    const project = {
      id: 'performance-project',
      name: 'Performance sample',
      mainFile: 'main.tex',
      revision: 0,
      runtime: status.pin,
      files: [
        {
          path: 'main.tex',
          content:
            '\\documentclass{article}\\usepackage[margin=1in]{geometry}\\begin{document}\\section*{Taylor Example}A synthetic performance resume.\\end{document}',
        },
      ],
    };
    const first = await step('firstArticleCompile', () => compiler.compile(project));
    if (!first.pdf?.length) throw new Error('Measured compilation produced no PDF.');
    sample.pdfBytes = first.pdf.length;
    for (let revision = 1; revision <= 3; revision++) {
      const changed = {
        ...project,
        revision,
        files: [{ path: 'main.tex', content: project.files[0].content + '\n% edit ' + revision }],
      };
      await step('warmChangedCompile' + revision, () => compiler.compile(changed));
    }
    const reopened = new RuntimeManager(selectedBundle, managed);
    await step('subsequentInitialize', () => reopened.initialize());
    await step('subsequentStatus', () => reopened.status());
    if (activeProcessSampler) {
      await activeProcessSampler.stop();
      activeProcessSampler = undefined;
    }
    sample.elapsedMs = performance.now() - sampleStart;
    const cpu = process.cpuUsage(cpuStart);
    sample.cpuUserMs = cpu.user / 1000;
    sample.cpuSystemMs = cpu.system / 1000;
    sample.peakHostRssBytes = peakRss;
    sample.io = summarizeIo();
    sample.passed = true;
    if (comparison) {
      await fs.mkdir(path.join(root, 'pdfs'), { recursive: true });
      for (const pdf of activeSample.pdfs) await fs.writeFile(path.join(root, pdf.file), pdf.bytes);
      if (sample.compilations.length !== 5)
        throw new Error('Expected five measured PDFs per runtime.');
    }
    await fs.writeFile(
      path.join(root, 'measurements.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(
      'Sample ' +
        (index + 1) +
        ': ' +
        sample.steps.map((step) => step.name + '=' + Math.round(step.elapsedMs) + 'ms').join(', '),
    );
  }
  report.finishedAt = new Date().toISOString();
  if (report.samples.length !== totalSamples || report.samples.some((sample) => !sample.passed))
    throw new Error('Missing or incomplete profile samples.');
  report.passed = true;
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.passed = false;
  report.error = error.message;
  throw error;
} finally {
  clearInterval(sampler);
  if (activeProcessSampler) {
    try {
      await activeProcessSampler.stop();
    } catch (error) {
      report.passed = false;
      report.observerError = error.message;
      process.exitCode = 1;
    }
  }
  activeSample = undefined;
  Compiler.prototype.run = originalRun;
  Compiler.prototype.compile = originalCompile;
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  fs.open = originalOpen;
  for (const [method, original] of originals) fs[method] = original;
  await fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence: ' + root);
}
