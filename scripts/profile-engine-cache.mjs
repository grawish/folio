import assert from 'node:assert/strict';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { acquireEngineCache, engineCachePolicy } from '../electron/core/engine-cache.ts';

// Developer-only metadata-cost measurement. Each fixture stays in this run's
// new directory; no existing app cache, project or process is modified.
if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.argv[2])
  throw new Error('Provide a test-generated LaTeX format on an Apple silicon Mac.');
const formatPath = path.resolve(process.argv[2]);
const repetitions = Number(process.argv[3] ?? 5);
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20)
  throw new Error('Choose 1–20 repetitions.');
const formatStat = await fs.lstat(formatPath);
assert(formatStat.isFile() && formatStat.size > 0 && formatStat.size < engineCachePolicy.bytes / 2);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = async (file) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 128 * 1024 }))
    digest.update(chunk);
  return digest.digest('hex');
};
const formatHash = await fileHash(formatPath);
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/engine-cache-profile-'));
const id = (value) => String(value).padStart(64, '0');
const tracked = ['scripts/profile-engine-cache.mjs', 'electron/core/engine-cache.ts'];
const inputs = Object.fromEntries(
  await Promise.all(tracked.map(async (f) => [f, await fileHash(f)])),
);
const definitions = [
  { name: 'warm-format', runtimes: 1, kind: 'format' },
  { name: 'two-warm-formats', runtimes: 2, kind: 'format' },
  { name: 'file-entry-limit', runtimes: 1, kind: 'files' },
  { name: 'directory-entry-limit', runtimes: 1, kind: 'directories' },
  { name: 'logical-byte-limit', runtimes: 1, kind: 'sparse' },
];
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  inputs,
  host: {
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    macos: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    ramBytes: os.totalmem(),
    node: process.version,
  },
  policy: engineCachePolicy,
  sourceFormat: { bytes: formatStat.size, sha256: formatHash },
  repetitions,
  fixtures: [],
  observations: [],
  passed: false,
  limits: [
    'Production cache metadata operations in Node, not a complete Electron build or a native compiler measurement.',
    'Synthetic runtime IDs and near-limit entries; ordinary fixtures copy an actual test-generated LaTeX format. The byte-limit file is sparse and does not fill a real disk.',
    'Fixture creation and final integrity reads are outside measurement. All fixtures exist before measurement; OS caches are not purged. Every recorded operation is retained, including the first.',
    'Five repetitions rotate fixture order. One check is timed per acquired lease; this does not reproduce the compiler’s periodic scheduling or contention with a native writer.',
    'CPU readings cover this Node process and timing overhead. They exclude filesystem service work in other processes; elapsed time includes I/O and scheduling.',
    'This is one development Mac with ordinary desktop activity. No population p95, whole-app budget, physical disk quota or UI latency claim.',
  ],
};
const inventory = async (work) => {
  const entries = [];
  let bytes = 0;
  const visit = async (folder, relative) => {
    for (const name of (await fs.readdir(folder)).sort()) {
      const file = path.join(folder, name);
      const stat = await fs.lstat(file);
      assert(!stat.isSymbolicLink());
      const rel = path.posix.join(relative, name);
      // Runtime directory mtimes are deliberately refreshed by admission.
      if (stat.isDirectory()) {
        if (relative) entries.push({ path: rel, kind: 'directory' });
        await visit(file, rel);
      } else {
        assert(stat.isFile() && stat.nlink === 1);
        bytes += stat.size;
        entries.push({ path: rel, kind: 'file', bytes: stat.size, sha256: await fileHash(file) });
      }
    }
  };
  const cache = path.join(work, 'engine-cache');
  await visit(cache, '');
  return {
    runtimes: (await fs.readdir(cache)).sort(),
    descendantEntries: entries.length,
    logicalFileBytes: bytes,
    payloadSha256: hash(JSON.stringify(entries)),
  };
};
const measure = async (fixture, repetition, operation, action) => {
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  try {
    return await action();
  } finally {
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    report.observations.push({
      fixture,
      repetition,
      operation,
      elapsedMs,
      userCpuMs: cpu.user / 1000,
      systemCpuMs: cpu.system / 1000,
    });
  }
};
try {
  for (const fixture of definitions) {
    const work = path.join(root, fixture.name);
    for (let runtime = 1; runtime <= fixture.runtimes; runtime++) {
      const folder = path.join(work, 'engine-cache', id(runtime));
      await fs.mkdir(folder, { recursive: true });
      if (fixture.kind === 'format') {
        await fs.mkdir(path.join(folder, 'formats'));
        await fs.copyFile(formatPath, path.join(folder, 'formats', 'latex.fmt'));
      } else if (fixture.kind === 'sparse') {
        const file = await fs.open(path.join(folder, 'logical-limit.fmt'), 'wx');
        try {
          await file.truncate(engineCachePolicy.bytes);
        } finally {
          await file.close();
        }
      } else {
        for (let n = 0; n < engineCachePolicy.entries; n++) {
          const entry = path.join(folder, `entry-${String(n).padStart(4, '0')}`);
          if (fixture.kind === 'directories') await fs.mkdir(entry);
          else await fs.writeFile(entry, 'x', { flag: 'wx' });
        }
      }
    }
    report.fixtures.push({ ...fixture, before: await inventory(work) });
  }
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const offset = (repetition - 1) % definitions.length;
    const order = [...definitions.slice(offset), ...definitions.slice(0, offset)];
    for (const fixture of order) {
      const work = path.join(root, fixture.name);
      const lease = await measure(fixture.name, repetition, 'acquire', () =>
        acquireEngineCache(work, id(1)),
      );
      try {
        await measure(fixture.name, repetition, 'check', () => lease.check());
      } finally {
        await measure(fixture.name, repetition, 'release', () => lease.release());
      }
    }
    console.log(`Recorded repetition ${repetition}/${repetitions}.`);
  }
  for (const fixture of report.fixtures) {
    fixture.after = await inventory(path.join(root, fixture.name));
    assert.deepEqual(fixture.after, fixture.before);
  }
  assert.equal(await fileHash(formatPath), formatHash);
  for (const file of tracked) assert.equal(await fileHash(file), inputs[file]);
  assert.equal(report.observations.length, repetitions * definitions.length * 3);
  report.passed = true;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${root}`);
}
