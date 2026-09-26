import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);

export async function buildProcessSampler(directory) {
  if (process.platform !== 'darwin') throw new Error('The process observer requires macOS.');
  const executable = path.join(directory, 'sample-mac-processes');
  await exec('/usr/bin/clang', [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-mmacosx-version-min=14.0',
    'scripts/sample-mac-processes.c',
    '-o',
    executable,
  ]);
  return executable;
}

export class ProcessSampler {
  constructor(executable, rootPid, intervalMs = 200) {
    this.executable = executable;
    this.rootPid = rootPid;
    this.intervalMs = intervalMs;
    this.samples = [];
    this.processes = new Map();
    this.cpuNs = 0n;
    this.phase = 'startup';
    this.stopped = false;
    this.started = performance.now();
  }
  async take() {
    const started = performance.now();
    const { stdout } = await exec(this.executable, [String(this.rootPid)], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const value = JSON.parse(stdout);
    const root = value.processes.find((row) => row.pid === this.rootPid);
    if (!root || (this.rootBirth && root.birthAbstime !== this.rootBirth))
      throw new Error('The observed application exited or its PID was reused.');
    this.rootBirth = root.birthAbstime;
    this.firstAbstime ??= BigInt(value.atAbstime);
    for (const row of value.processes) {
      const key = `${row.pid}:${row.birthAbstime}`;
      // rusage CPU counters use Mach absolute-time units on Apple silicon.
      // Keep integer arithmetic until converting the accumulated delta to seconds.
      const total =
        ((BigInt(row.userTicks) + BigInt(row.systemTicks)) * BigInt(value.timebase.numer)) /
        BigInt(value.timebase.denom);
      const known = this.processes.get(key);
      const previous = known?.cpuNs ?? (BigInt(row.birthAbstime) < this.firstAbstime ? total : 0n);
      if (total < previous) throw new Error('A process CPU counter moved backwards.');
      this.cpuNs += total - previous;
      this.processes.set(key, {
        pid: row.pid,
        name: row.name,
        birthAbstime: row.birthAbstime,
        cpuNs: total,
      });
    }
    const sample = {
      atMs: started - this.started,
      phase: this.phase,
      collectionMs: performance.now() - started,
      ...value,
      observedCpuSeconds: Number(this.cpuNs) / 1e9,
      summedRssBytes: value.processes.reduce((sum, row) => sum + row.rssBytes, 0),
      summedFootprintBytes: value.processes.reduce((sum, row) => sum + row.footprintBytes, 0),
    };
    this.samples.push(sample);
    return sample;
  }
  async start() {
    await this.take();
    this.schedule();
  }
  schedule() {
    if (this.stopped || this.paused) return;
    this.timer = setTimeout(() => {
      this.pending = this.take()
        .catch((error) => {
          this.error = error;
          this.stopped = true;
        })
        .finally(() => this.schedule());
    }, this.intervalMs);
  }
  async mark(phase) {
    this.paused = true;
    clearTimeout(this.timer);
    await this.pending;
    if (this.error) throw this.error;
    this.phase = phase;
    const sample = await this.take();
    this.paused = false;
    this.schedule();
    return sample;
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
    if (this.error) throw this.error;
  }
}
