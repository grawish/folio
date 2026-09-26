import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

// Developer-only instrumentation of the production compiler. No renderer, AI
// account, runtime bypass or change to cancellation behavior is involved.
const count = Number(process.argv[2] ?? 3);
if (!Number.isInteger(count) || count < 1 || count > 10)
  throw new Error('Choose 1–10 samples per scenario.');
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This profile requires an Apple silicon Mac.');
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/compiler-stop-'));
const runtime = await fs.realpath('resources/runtime/mac-arm64');
const originalSpawn = childProcess.spawn;
const originalKill = process.kill;
const execFile = promisify(childProcess.execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let active;
childProcess.spawn = function (...args) {
  const child = originalSpawn.apply(this, args);
  if (active && args[0] === '/usr/bin/sandbox-exec') {
    const sample = active;
    assert.equal(sample.group, undefined, 'Expected one compiler process per build.');
    sample.group = child.pid;
    sample.spawnAtMs = performance.now() - sample.started;
    child.once('close', (code, signal) => {
      sample.closeAtMs = performance.now() - sample.started;
      sample.exit = { code, signal };
    });
  }
  return child;
};
process.kill = function (pid, signal) {
  if (active?.group && pid === -active.group && signal === 'SIGKILL')
    active.killAtMs ??= performance.now() - active.started;
  return originalKill.call(this, pid, signal);
};
syncBuiltinESMExports();
const { Compiler } = await import('../electron/core/compiler.ts');

const digest = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
  },
  sources: Object.fromEntries(
    await Promise.all(
      [
        'electron/core/compiler.ts',
        'electron/core/runtime.ts',
        'scripts/profile-compiler-stop.mjs',
        'resources/runtime/mac-arm64/manifest.json',
        'resources/runtime-checks/resume-packages.tex',
      ].map(async (file) => [file, await digest(file)]),
    ),
  ),
  scope:
    'Real sandboxed Tectonic and Biber with isolated build/cache directories. Compiler.cancel and production timeout are unchanged.',
  limits: [
    'Single development Mac, no OS cache purge; not a p95 or supported-device guarantee.',
    'There is a 25 ms wait between ps scans; scans add latency. Group-absence times are upper bounds including polling and instrumentation overhead.',
    'RSS sums may double-count shared pages. CPU is ps lifetime percentage, not interval CPU; these are not application-wide budgets.',
    'Only the app-owned compiler process group is retained; other process names, arguments and environment are not recorded.',
    'A process escaping its original group is outside this sampler. This is not a hostile-process containment proof.',
  ],
  samples: [],
};
const processGroup = async (group) => {
  if (!group) return [];
  const { stdout } = await execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,rss=,pcpu=,comm='], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5000,
  });
  return stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!match || Number(match[3]) !== group) return [];
    return [
      {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        rssKiB: Number(match[4]),
        cpuPercent: Number(match[5]),
        name: path.basename(match[6].trim()),
      },
    ];
  });
};
const simple = '\\documentclass{article}\n\\begin{document}Stop sample\\end{document}';
const runaway = simple.replace('Stop sample', '\\loop\\iftrue\\repeat');
const bibliography = await fs.readFile('resources/runtime-checks/resume-packages.tex', 'utf8');
const scenarios = ['cancel-tex', 'cancel-biber', 'timeout-tex'];
let compiler;
try {
  for (let index = 1; index <= count; index++) {
    for (const scenario of scenarios) {
      compiler = new Compiler(
        runtime,
        path.join(root, `${index}-${scenario}`),
        scenario === 'timeout-tex' ? 1000 : 30_000,
      );
      const sample = {
        index,
        scenario,
        started: performance.now(),
        observations: [],
        passed: false,
      };
      active = sample;
      report.samples.push(sample);
      const project = {
        id: 'stop-profile',
        name: 'Synthetic stop profile',
        mainFile: 'main.tex',
        revision: index,
        files: [
          { path: 'main.tex', content: scenario === 'cancel-biber' ? bibliography : runaway },
        ],
      };
      let result,
        buildError,
        settled = false,
        cancellation;
      const pending = compiler
        .compile(project)
        .then(
          (value) => {
            result = value;
          },
          (error) => {
            buildError = error;
          },
        )
        .finally(() => {
          sample.settledAtMs = performance.now() - sample.started;
          settled = true;
        });
      while (!settled) {
        const processes = await processGroup(sample.group);
        const atMs = performance.now() - sample.started;
        if (sample.group) sample.observations.push({ atMs, processes });
        const targetSeen = processes.some((item) =>
          scenario === 'cancel-biber'
            ? /^(?:biber|perl)/i.test(item.name)
            : item.name === 'tectonic',
        );
        if (targetSeen) sample.targetFirstSeenAtMs ??= atMs;
        if (
          scenario !== 'timeout-tex' &&
          !cancellation &&
          targetSeen &&
          atMs - sample.targetFirstSeenAtMs >= 150
        ) {
          sample.cancelAtMs = performance.now() - sample.started;
          cancellation = compiler.cancel().then(() => {
            sample.cancelReturnedAtMs = performance.now() - sample.started;
          });
        }
        if (atMs > 35_000) throw new Error(`Observation deadline exceeded: ${scenario}`);
        if (!settled) await wait(25);
      }
      await pending;
      await cancellation;
      if (buildError) throw buildError;
      sample.result = { status: result.status, durationMs: result.durationMs };
      await fs.writeFile(path.join(root, `${index}-${scenario}.log`), result.log);
      assert.ok(
        sample.group && sample.targetFirstSeenAtMs !== undefined,
        `Target process was not observed: ${scenario}`,
      );
      assert.ok(
        sample.killAtMs !== undefined,
        'Production process-group SIGKILL was not observed.',
      );
      assert.equal(sample.exit.signal, 'SIGKILL');
      if (scenario === 'timeout-tex') {
        assert.equal(result.status, 'error');
        assert.match(result.log, /time limit/);
      } else assert.equal(result.status, 'cancelled');
      let remaining = await processGroup(sample.group);
      const absenceStart = performance.now();
      while (remaining.length && performance.now() - absenceStart < 2000) {
        await wait(25);
        remaining = await processGroup(sample.group);
      }
      sample.groupAbsentAtMs = performance.now() - sample.started;
      sample.remaining = remaining;
      assert.equal(remaining.length, 0, 'Compiler process group survived build completion.');
      sample.killToCloseMs = sample.closeAtMs - sample.killAtMs;
      sample.killToGroupAbsentMs = sample.groupAbsentAtMs - sample.killAtMs;
      sample.peakSampledGroupRssKiB = Math.max(
        0,
        ...sample.observations.map((entry) =>
          entry.processes.reduce((sum, item) => sum + item.rssKiB, 0),
        ),
      );
      sample.passed = true;
      delete sample.started;
      console.log(
        `PASS ${index} ${scenario}: close ${sample.killToCloseMs.toFixed(1)} ms; group absent ${sample.killToGroupAbsentMs.toFixed(1)} ms`,
      );
      active = undefined;
      await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    }
  }
} catch (error) {
  report.error = error.stack ?? String(error);
  throw error;
} finally {
  await compiler?.cancel();
  childProcess.spawn = originalSpawn;
  process.kill = originalKill;
  syncBuiltinESMExports();
  report.finishedAt = new Date().toISOString();
  report.passed =
    !report.error &&
    report.samples.length === count * scenarios.length &&
    report.samples.every((sample) => sample.passed);
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${root}`);
}
