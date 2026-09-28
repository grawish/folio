import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Compiler } from '../../electron/core/compiler';

const stopped = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
async function stop(child: ChildProcess) {
  if (!stopped(child)) child.kill('SIGKILL');
  for (let n = 0; n < 500 && !stopped(child); n++) await delay(10);
  assert.ok(stopped(child), 'Owned staging process must exit');
}

test(
  'real compiler snapshots recover after two killed owners, then build and release normally',
  {
    skip: process.platform !== 'darwin',
    timeout: 90_000,
  },
  async (t) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'folio-real-build-recovery-')),
    );
    const children: ChildProcess[] = [];
    t.after(async () => {
      await Promise.all(children.map(stop));
      await fs.rm(root, { recursive: true, force: true });
    });
    const work = path.join(root, 'builds');
    const runtime = path.resolve(`resources/runtime/mac-${process.arch}`);
    const content =
      '\\documentclass{article}\n\\begin{document}Recovered build\\end{document}\n%' +
      'x'.repeat(131072);
    const original = path.join(root, 'main.tex');
    await fs.writeFile(original, content);
    await fs.mkdir(path.join(work, 'build-legacy'), { recursive: true });
    await fs.writeFile(path.join(work, 'build-legacy', 'keep'), 'unmarked');
    await fs.mkdir(path.join(work, 'engine-cache'));
    await fs.writeFile(path.join(work, 'engine-cache', 'keep'), 'cache');
    const payloads: string[] = [];
    for (let n = 0; n < 2; n++) {
      const child = fork(
        new URL('../fixtures/build-workspace-worker.ts', import.meta.url),
        [work, 'compile', original, runtime],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      children.push(child);
      let stderr = '';
      child.stderr!.on('data', (bytes) => (stderr += bytes.toString()));
      const message = await new Promise<{ phase: string; payload: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Staging timed out: ' + stderr)), 30_000);
        child.once('message', (value) => {
          clearTimeout(timer);
          resolve(value as { phase: string; payload: string });
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Staging exited: ' + stderr));
        });
      });
      assert.equal(message.phase, 'compiled-snapshot', JSON.stringify(message));
      assert.ok(message.payload.startsWith(path.join(work, '.folio-build-jobs-v1') + path.sep));
      assert.equal(
        await fs.readFile(path.join(message.payload, 'source', 'main.tex'), 'utf8'),
        content,
      );
      payloads.push(message.payload);
    }
    assert.equal((await fs.readdir(path.join(work, '.folio-build-jobs-v1'))).length, 2);
    await Promise.all(children.map(stop));
    for (const payload of payloads) await fs.access(payload);
    const recovered = new Compiler(runtime, work);
    assert.equal((await recovered['workspaces'].recovery).removed, 2);
    for (const payload of payloads) await assert.rejects(fs.access(payload), { code: 'ENOENT' });
    const result = await recovered.compile({
      id: 'build-recovery',
      name: 'Crash recovery fixture',
      revision: 1,
      mainFile: 'main.tex',
      files: [{ path: 'main.tex', content }],
    });
    assert.equal(result.status, 'success', result.log);
    assert.ok(result.pdf && result.pdf.byteLength > 1000);
    assert.equal(Buffer.from(result.pdf).subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(await fs.readdir(path.join(work, '.folio-build-jobs-v1')), []);
    assert.equal(await fs.readFile(original, 'utf8'), content);
    assert.equal(await fs.readFile(path.join(work, 'build-legacy', 'keep'), 'utf8'), 'unmarked');
    assert.equal(await fs.readFile(path.join(work, 'engine-cache', 'keep'), 'utf8'), 'cache');
    t.diagnostic(
      `Two production snapshots (${Buffer.byteLength(content) * 2} source bytes) were reclaimed; original source, unmarked data and the cache guard survived. The restarted compiler built a real offline PDF and released its new job.`,
    );
  },
);
