import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ProjectStore } from '../electron/core/project.ts';
import { WorkspaceStore } from '../electron/core/workspace.ts';

// Developer-only, real storage operations in a new app-owned directory.
// Do not run concurrently with another local benchmark or native test suite.
const [corpusDirectory, count = '3', ...extra] = process.argv.slice(2);
const samples = Number(count);
if (!corpusDirectory || extra.length || !Number.isInteger(samples) || samples < 1 || samples > 5)
  throw new Error(
    'Usage: node --import tsx scripts/profile-storage.mjs <template-corpus-dir> [1–5 samples]',
  );
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Run on an Apple silicon Mac.');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const input = path.resolve(corpusDirectory);
const verificationBytes = await fs.readFile(path.join(input, 'verification.json'));
const verification = JSON.parse(verificationBytes);
assert.equal(verification.passed, true, 'Use a passing template comparison corpus.');
const fixture = verification.variants.find((variant) => variant.name === 'classic-a4');
assert.ok(fixture);
const source = await fs.readFile(path.join(input, 'classic-a4.tex'), 'utf8');
const pdf = await fs.readFile(path.join(input, 'classic-a4.pdf'));
assert.equal(hash(source), fixture.sourceHash);
assert.equal(hash(pdf), fixture.pdfHash);
assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/storage-profile-'));
const files = execFileSync(
  'git',
  ['ls-files', 'electron/core', 'src/shared', 'package-lock.json'],
  {
    encoding: 'utf8',
  },
)
  .trim()
  .split('\n');
files.push('scripts/profile-storage.mjs');
const report = {
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sources: Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, hash(await fs.readFile(file))])),
  ),
  host: {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
  },
  fixture: {
    name: fixture.name,
    sourceBytes: Buffer.byteLength(source),
    pdfBytes: pdf.length,
    sourceSha256: fixture.sourceHash,
    pdfSha256: fixture.pdfHash,
    verificationSha256: hash(verificationBytes),
    historyLengths: [1, 25, 100],
    samples,
  },
  scope:
    'Real ProjectStore and WorkspaceStore operations with synthetic one-file resumes and new isolated profiles; no renderer, compiler, network or AI requests.',
  limits: [
    'Each version adds a distinct TeX comment and reuses the same previously compiled PDF. These are unverified storage fixtures, not new compiler or AI acceptance.',
    'OS caches are not purged. Ordered stages reuse files; memory can remain allocated between cases in this Node process.',
    'Save includes regenerating the history archive. Separate archive and save stages overlap in work and must not be added or subtracted as independent components.',
    '10 ms timer lateness measures observed Node event-loop stalls, not renderer frame rate. RSS sampling can miss synchronous peaks; values exclude Electron and child processes.',
    'Small sample sets are descriptive observations, not population p95, worst-case limits or a supported-device memory budget.',
  ],
  runs: [],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = () =>
  fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');

async function measure(run, name, action) {
  const metric = {
    name,
    passed: false,
    maxTimerLatenessMs: 0,
    peakSampledRssBytes: process.memoryUsage().rss,
  };
  run.stages.push(metric);
  let expected = performance.now() + 10;
  const timer = setInterval(() => {
    const now = performance.now();
    metric.maxTimerLatenessMs = Math.max(metric.maxTimerLatenessMs, now - expected);
    metric.peakSampledRssBytes = Math.max(metric.peakSampledRssBytes, process.memoryUsage().rss);
    expected = now + 10;
  }, 10);
  const start = performance.now();
  const cpu = process.cpuUsage();
  metric.rssBeforeBytes = process.memoryUsage().rss;
  try {
    const value = await action();
    metric.passed = true;
    return value;
  } finally {
    metric.wallMs = performance.now() - start;
    metric.cpuMicroseconds = process.cpuUsage(cpu);
    metric.rssAfterBytes = process.memoryUsage().rss;
    metric.peakSampledRssBytes = Math.max(metric.peakSampledRssBytes, metric.rssAfterBytes);
    // Let an overdue timer observe synchronous archive work before stopping it.
    await sleep(15);
    clearInterval(timer);
  }
}

async function treeSize(directory) {
  let bytes = 0,
    fileCount = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink());
    if (entry.isDirectory()) {
      const child = await treeSize(filename);
      bytes += child.bytes;
      fileCount += child.fileCount;
    } else {
      bytes += (await fs.stat(filename)).size;
      fileCount++;
    }
  }
  return { bytes, fileCount };
}

try {
  for (let sample = 1; sample <= samples; sample++) {
    for (const versions of report.fixture.historyLengths) {
      const run = { sample, versions, stages: [], passed: false };
      report.runs.push(run);
      const caseRoot = path.join(root, `sample-${sample}-versions-${versions}`);
      const projectDirectory = path.join(caseRoot, 'project');
      await fs.mkdir(projectDirectory, { recursive: true });
      const data = path.join(caseRoot, 'profile');
      const store = new ProjectStore(data);
      const workspace = new WorkspaceStore(data);
      const project = {
        id: `sample-${sample}-versions-${versions}`,
        name: 'Synthetic storage sample',
        revision: 0,
        mainFile: 'main.tex',
        templateId: 'classic',
        templateVersion: 1,
        files: [{ path: 'main.tex', content: source }],
      };
      const checkpoint = async (revision) => {
        project.revision = revision;
        project.files[0].content = source + `\n% Synthetic storage revision ${revision}\n`;
        return workspace.checkpoint(project, pdf, `Storage revision ${revision}`, false);
      };
      await measure(run, 'create-prior-history', async () => {
        for (let revision = 1; revision < versions; revision++) await checkpoint(revision);
      });
      const latest = await measure(run, 'checkpoint-one', () => checkpoint(versions));
      const archive = await measure(run, 'archive-history', () => workspace.archive(project.id));
      run.archiveBytes = archive.length;
      const result = await measure(run, 'save-project-with-history', () =>
        store.save(project, projectDirectory, false, (id) => workspace.archive(project.id, id)),
      );
      assert.equal(result.conflict, false);
      assert.equal(result.projectId, project.id);
      const reopenedStore = new ProjectStore(path.join(caseRoot, 'reopened-profile'));
      const reopenedWorkspace = new WorkspaceStore(path.join(caseRoot, 'reopened-profile'));
      const reopened = await measure(run, 'open-saved-project', () =>
        reopenedStore.open(projectDirectory),
      );
      assert.equal(reopened.id, project.id);
      assert.deepEqual(reopened.files, project.files);
      await measure(run, 'import-saved-history', () =>
        reopenedWorkspace.importFrom(project.id, projectDirectory),
      );
      const recovered = await measure(run, 'read-latest-version', () =>
        reopenedWorkspace.version(project.id, latest.id),
      );
      assert.deepEqual(recovered.files, project.files);
      assert.equal(hash(recovered.pdf), fixture.pdfHash);
      const state = await reopenedWorkspace.load(project.id);
      assert.equal(state.versions.length, versions);
      assert.ok(state.versions.every((version) => !version.verified));
      run.workspaceStorage = await treeSize(path.join(data, 'workspaces', project.id));
      run.projectStorage = await treeSize(projectDirectory);
      run.passed = true;
      await write();
      console.log(
        `Sample ${sample}, ${versions} versions: ` +
          run.stages.map((stage) => `${stage.name} ${stage.wallMs.toFixed(1)} ms`).join(', '),
      );
    }
  }
  for (const [file, expected] of Object.entries(report.sources))
    assert.equal(hash(await fs.readFile(file)), expected, `${file} changed during measurement`);
  report.completedAt = new Date().toISOString();
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  await write();
  console.log(`Evidence: ${root}`);
}
