import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const sourceFiles = [
  'electron/core/runtime-manager.ts',
  'electron/core/runtime.ts',
  'electron/core/compiler.ts',
  'scripts/profile-runtime.mjs',
  'resources/runtime/mac-arm64/manifest.json',
];
const report = {
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
  limits: [
    'OS disk caches are not purged; fresh profile means new managed runtime and TeX cache, not cold physical storage.',
    'Operation sums overlap because four files copy concurrently; sums are not additive wall-clock shares.',
    'Instrumentation adds timing overhead. Memory/CPU here describe the Node host, not the native compiler process tree.',
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
try {
  for (let index = 0; index < samples; index++) {
    const sampleRoot = path.join(root, String(index + 1));
    await fs.mkdir(sampleRoot);
    io = new Map();
    peakRss = process.memoryUsage().rss;
    const sample = { index: index + 1, steps: [], checkpoints: [], methods: [] };
    const sampleStart = performance.now();
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
          sample.methods.push({ method, elapsedMs: performance.now() - start });
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
          elapsedMs: performance.now() - start,
          cpuUserMs: used.user / 1000,
          cpuSystemMs: used.system / 1000,
        });
        phase = previous;
      }
    };
    const managed = path.join(sampleRoot, 'runtimes');
    const manager = new RuntimeManager(bundled, managed, {
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
    const reopened = new RuntimeManager(bundled, managed);
    await step('subsequentInitialize', () => reopened.initialize());
    await step('subsequentStatus', () => reopened.status());
    sample.elapsedMs = performance.now() - sampleStart;
    const cpu = process.cpuUsage(cpuStart);
    sample.cpuUserMs = cpu.user / 1000;
    sample.cpuSystemMs = cpu.system / 1000;
    sample.peakHostRssBytes = peakRss;
    sample.io = summarizeIo();
    report.samples.push(sample);
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
  report.passed = true;
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.passed = false;
  report.error = error.message;
  throw error;
} finally {
  clearInterval(sampler);
  fs.open = originalOpen;
  for (const [method, original] of originals) fs[method] = original;
  await fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence: ' + root);
}
