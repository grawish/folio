import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { buildProcessSampler, ProcessSampler } from '../scripts/mac-process-sampler.mjs';

test(
  'native process observer measures a nested allocation and CPU work without counting a sibling',
  {
    skip: process.platform !== 'darwin',
    timeout: 30_000,
  },
  async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-observer-'));
    const executable = await buildProcessSampler(folder);
    const leaf = `process.send({ready:true,pid:process.pid}); process.on('message',()=>{globalThis.bytes=Buffer.alloc(64*1024*1024,37);const before=process.cpuUsage();const end=performance.now()+10000;while(true){const used=process.cpuUsage(before);if(used.user+used.system>=800000)break;if(performance.now()>end)throw new Error("CPU control starved");};process.send({worked:true,cpu:process.cpuUsage(before)});});`;
    const middle = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:['ignore','ignore','ignore','ipc']}); c.on('message',x=>process.send({...x,child:process.pid}));process.on('message',x=>c.send(x));`;
    const parent = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:['ignore','ignore','ignore','ipc']}); c.on('message',x=>process.send(x));process.on('message',x=>c.send(x));`;
    const target = spawn(process.execPath, ['-e', parent], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
    });
    const sampler = new ProcessSampler(executable, target.pid!, 50);
    t.after(async () => {
      await sampler.stop().catch(() => {});
      if (target.pid) {
        try {
          process.kill(-target.pid, 'SIGKILL');
        } catch {}
      }
      sibling.kill('SIGKILL');
      await fs.rm(folder, { recursive: true, force: true });
    });
    const [ready] = await once(target, 'message');
    await sampler.start();
    const initial = sampler.samples[0];
    const initialLeaf = initial.processes.find((row) => row.pid === ready.pid)!;
    assert.ok(initialLeaf);
    const worked = once(target, 'message');
    target.send('work');
    const [done] = await worked;
    assert.equal(done.worked, true);
    await sampler.mark('allocated');
    await sampler.stop();
    const after = sampler.samples.at(-1)!;
    const lastLeaf = after.processes.find((row) => row.pid === ready.pid)!;
    assert.ok(
      lastLeaf.rssBytes - initialLeaf.rssBytes > 32 * 1024 * 1024,
      'Touched allocation must be visible',
    );
    assert.ok(
      after.observedCpuSeconds > 0.6,
      'CPU counters must be scaled by the Mach timebase before conversion to seconds',
    );
    const measuredLeafCpu =
      Number(
        ((BigInt(lastLeaf.userTicks) +
          BigInt(lastLeaf.systemTicks) -
          BigInt(initialLeaf.userTicks) -
          BigInt(initialLeaf.systemTicks)) *
          BigInt(after.timebase.numer)) /
          BigInt(after.timebase.denom),
      ) / 1e9;
    const reportedLeafCpu = (done.cpu.user + done.cpu.system) / 1e6;
    assert.ok(
      Math.abs(measuredLeafCpu - reportedLeafCpu) < 0.3,
      'Native counters agree with the child CPU measurement',
    );
    assert.ok(
      after.processes.some((row) => row.pid === ready.child),
      'Grandchild traversal includes its parent',
    );
    assert.ok(
      sampler.samples.every((sample) => sample.processes.every((row) => row.pid !== sibling.pid)),
    );
    assert.ok(sampler.samples.every((sample) => sample.processes.length === 3));
    assert.ok(
      sampler.samples.every(
        (sample, i) => !i || sample.observedCpuSeconds >= sampler.samples[i - 1].observedCpuSeconds,
      ),
    );
    t.diagnostic(
      `Observed ${measuredLeafCpu.toFixed(3)} CPU seconds and ${((lastLeaf.rssBytes - initialLeaf.rssBytes) / 1024 / 1024).toFixed(1)} MiB RSS growth in the grandchild; excluded sibling PID.`,
    );
  },
);
