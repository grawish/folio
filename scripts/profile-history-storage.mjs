import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { unzipSync } from 'fflate';
import { WorkspaceStore } from '../electron/core/workspace.ts';

// Developer-only matched storage measurements. Run without other benchmarks,
// compilation or native suites. Retain every sample, including the first one.
const [corpus, repetitions = '3'] = process.argv.slice(2);
const samples = Number(repetitions);
assert.ok(corpus && Number.isInteger(samples) && samples >= 1 && samples <= 5);
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const baselineCommit = 'e03cdfbc8430c139a3fa0ad6db129f4b93d74761';
const root = await fs.mkdtemp(path.resolve('test-results/history-storage-profile-'));
const original = execFileSync('git', ['show', `${baselineCommit}:electron/core/workspace.ts`]);
// Only relocate import specifiers. The baseline module body stays byte-identical.
// Check its runtime dependencies against the recorded baseline before measuring.
const dependencies = [
  'electron/core/safe-zip.ts',
  'electron/core/history-archive.ts',
  'electron/core/history-archive-limits.json',
  'electron/core/history-zip-worker.cjs',
  'electron/core/project.ts',
  'package-lock.json',
];
for (const file of dependencies)
  assert.deepEqual(
    await fs.readFile(file),
    execFileSync('git', ['show', `${baselineCommit}:${file}`]),
  );
// Shared AI/type changes in this comparison add interfaces and optional fields;
// emptyWorkspace, the baseline module's sole shared runtime import, is unchanged.
const shared = 'src/shared/ai.ts';
const emptyFunction = (text) => {
  const match = text.match(/export const emptyWorkspace = [\s\S]+?\n\}\);/);
  assert.ok(match, 'Expected the actual emptyWorkspace helper');
  return match[0];
};
assert.equal(
  emptyFunction(await fs.readFile(shared, 'utf8')),
  emptyFunction(execFileSync('git', ['show', `${baselineCommit}:${shared}`], { encoding: 'utf8' })),
);
const relocated = original
  .toString()
  .replace(
    /from '(\.[^']+)'/g,
    (_, name) => `from '${path.resolve('electron/core', name).replaceAll('\\', '/')}'`,
  );
const baselineFile = path.join(root, 'baseline-workspace.ts');
await fs.writeFile(baselineFile, relocated);
const { WorkspaceStore: BaselineStore } = await import(pathToFileURL(baselineFile).href);
const verification = JSON.parse(await fs.readFile(path.join(corpus, 'verification.json'), 'utf8'));
assert.equal(verification.passed, true);
const fixture = verification.variants.find((v) => v.name === 'classic-a4');
assert.ok(fixture);
const source = await fs.readFile(path.join(corpus, 'classic-a4.tex'), 'utf8');
const pdf = await fs.readFile(path.join(corpus, 'classic-a4.pdf'));
assert.equal(sha(source), fixture.sourceHash);
assert.equal(sha(pdf), fixture.pdfHash);
const inputFiles = [
  ...dependencies,
  shared,
  'src/shared/types.ts',
  'electron/core/workspace.ts',
  'electron/core/save-io.ts',
  'electron/core/save-transactions.ts',
  'scripts/profile-history-storage.mjs',
];
const report = {
  startedAt: new Date().toISOString(),
  baselineCommit,
  baselineOriginalSha256: sha(original),
  baselineRelocatedSha256: sha(relocated),
  sources: Object.fromEntries(
    await Promise.all(inputFiles.map(async (f) => [f, sha(await fs.readFile(f))])),
  ),
  host: {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    node: process.version,
  },
  fixture: {
    name: fixture.name,
    sourceSha256: sha(source),
    pdfSha256: sha(pdf),
    pdfBytes: pdf.length,
    versions: 100,
    samples,
  },
  scope:
    'Alternating paired backend runs in isolated profiles; 100 distinct source-comment versions reuse one real compiled PDF. No renderer, compiler or AI requests during timing. OS caches are not purged. Timer lateness is Node event-loop evidence, not UI latency or a population/worst-case guarantee.',
  baselineMethod:
    'Exact recorded WorkspaceStore with only relative imports relocated. Listed common dependencies and the emptyWorkspace runtime helper are checked against that commit. Current SaveTransactions adds recovery journaling; all direct input hashes are retained.',
  runs: [],
};
const write = () =>
  fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
try {
  for (let sample = 1; sample <= samples; sample++) {
    const order = sample % 2 ? ['baseline', 'current'] : ['current', 'baseline'];
    for (const variant of order) {
      const Store = variant === 'baseline' ? BaselineStore : WorkspaceStore;
      const store = new Store(path.join(root, `${sample}-${variant}`));
      const run = {
        sample,
        variant,
        checkpointMs: [],
        maxTimerLatenessMs: 0,
        passed: false,
        storageMeasurementMs: 0,
        journalCommitMs: 0,
      };
      if (variant === 'current') {
        for (const [object, method, field] of [
          [store, 'measure', 'storageMeasurementMs'],
          [store.transactions, 'commit', 'journalCommitMs'],
        ]) {
          const originalMethod = object[method].bind(object);
          object[method] = async (...args) => {
            const start = performance.now();
            try {
              return await originalMethod(...args);
            } finally {
              run[field] += performance.now() - start;
            }
          };
        }
      }
      report.runs.push(run);
      const project = {
        id: 'synthetic',
        name: 'Synthetic history sample',
        mainFile: 'main.tex',
        revision: 0,
        files: [],
      };
      let expected = performance.now() + 10;
      const timer = setInterval(() => {
        const now = performance.now();
        run.maxTimerLatenessMs = Math.max(run.maxTimerLatenessMs, now - expected);
        expected = now + 10;
      }, 10);
      const begin = performance.now();
      const cpu = process.cpuUsage();
      try {
        for (let revision = 1; revision <= 100; revision++) {
          project.revision = revision;
          project.files = [
            { path: 'main.tex', content: source + `\n% Synthetic history revision ${revision}\n` },
          ];
          const start = performance.now();
          await store.checkpoint(project, pdf, `Version ${revision}`, false);
          run.checkpointMs.push(performance.now() - start);
        }
        run.totalCheckpointMs = performance.now() - begin;
        run.cpuMicroseconds = process.cpuUsage(cpu);
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 15));
        clearInterval(timer);
      }
      // Verification is outside the checkpoint timing window.
      const state = await store.load(project.id);
      assert.equal(state.versions.length, 100);
      const entries = unzipSync(await store.archive(project.id));
      assert.equal(Object.keys(entries).length, 201);
      let indexedBytes = 0;
      for (let index = 0; index < state.versions.length; index++) {
        const id = state.versions[index].id;
        const sourceBytes = entries[`versions/${id}/source.json`];
        const pdfBytes = entries[`versions/${id}/resume.pdf`];
        assert.deepEqual(Buffer.from(pdfBytes), pdf);
        assert.deepEqual(JSON.parse(Buffer.from(sourceBytes).toString()).files, [
          { path: 'main.tex', content: source + `\n% Synthetic history revision ${index + 1}\n` },
        ]);
        indexedBytes += sourceBytes.length + pdfBytes.length;
      }
      if (variant === 'current') {
        const measuredDuringCheckpoints = run.storageMeasurementMs;
        assert.equal((await store.storage(project.id)).bytes, indexedBytes);
        run.storageMeasurementMs = measuredDuringCheckpoints;
      }
      run.indexedBytes = indexedBytes;
      run.passed = true;
      await write();
      console.log(
        `Sample ${sample} ${variant}: total ${run.totalCheckpointMs.toFixed(1)} ms, last ${run.checkpointMs.at(-1).toFixed(1)} ms, max timer lateness ${run.maxTimerLatenessMs.toFixed(1)} ms`,
      );
    }
  }
  for (const [file, expected] of Object.entries(report.sources))
    assert.equal(sha(await fs.readFile(file)), expected, `Changed while profiling: ${file}`);
  report.completedAt = new Date().toISOString();
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  await write();
  console.log(`Evidence: ${root}`);
}
