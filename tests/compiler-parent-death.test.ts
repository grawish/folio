import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Compiler } from '../electron/core/compiler';

const native = { skip: process.platform !== 'darwin', timeout: 25_000 };
const processInfo = (pid: number) => {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,ppid=,stat='], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/);
  } catch (error) {
    if ((error as { status: number }).status === 1) return [];
    throw error;
  }
};
function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function until(check: () => boolean, message: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await delay(25);
  assert.ok(check(), message);
}

async function fixture(t: { after(fn: () => Promise<void>): void }, mode: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-parent-death-'));
  const worker = fork(
    new URL('./fixtures/compiler-parent-worker.ts', import.meta.url),
    [root, mode],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  const messages: Array<{ type: string; pid?: number; code?: number; log?: string }> = [];
  let output = '';
  let ownedGroup: number | undefined;
  worker.on('message', (message) => messages.push(message as (typeof messages)[number]));
  worker.stdout!.on('data', (chunk) => (output += chunk.toString()));
  worker.stderr!.on('data', (chunk) => (output += chunk.toString()));
  const stopped = () => worker.exitCode !== null || worker.signalCode !== null;
  t.after(async () => {
    // Ask the still-owned parent to cancel first. Kill only a group whose leader
    // was positively identified as this worker's child, never a guessed PID.
    if (!stopped()) worker.kill('SIGTERM');
    const deadline = Date.now() + 2000;
    while (!stopped() && Date.now() < deadline) await delay(25);
    if (ownedGroup && groupAlive(ownedGroup)) process.kill(-ownedGroup, 'SIGKILL');
    if (!stopped()) worker.kill('SIGKILL');
    await until(stopped, 'Test worker must stop');
    if (ownedGroup) await until(() => !groupAlive(ownedGroup!), 'Test compiler group must stop');
    await fs.rm(root, { recursive: true, force: true });
  });
  await until(
    () => messages.some((m) => m.type === 'spawned') || stopped(),
    'Compiler must launch',
  );
  const pid = messages.find((m) => m.type === 'spawned')?.pid;
  assert.ok(pid && Number.isInteger(pid) && pid > 1, output);
  const fields = processInfo(pid);
  assert.deepEqual(fields.slice(0, 3).map(Number), [pid, pid, worker.pid], output);
  ownedGroup = pid;
  await until(
    () => messages.some((m) => m.type === 'ready') || stopped(),
    'Compiler must become ready',
  );
  assert.ok(
    messages.some((m) => m.type === 'ready'),
    output,
  );
  const info = JSON.parse(await fs.readFile(path.join(root, 'native.json'), 'utf8'));
  assert.equal(info.pid, pid);
  const helper = processInfo(info.helperPid);
  assert.deepEqual(helper.slice(0, 3).map(Number), [info.helperPid, pid, pid]);
  if (mode === 'success') await fs.writeFile(path.join(root, 'native.json.finish'), 'finish');
  const gone = () => !groupAlive(pid);
  const result = async () => {
    await until(
      () => messages.some((m) => m.type === 'result') || stopped(),
      'Compile must finish',
    );
    const result = messages.find((m) => m.type === 'result');
    assert.ok(result, output);
    return result;
  };
  return { worker, gone, result, stopped };
}

for (let attempt = 1; attempt <= 3; attempt++) {
  test(
    `parent SIGKILL stops the compiler and log-holding helper (attempt ${attempt})`,
    native,
    async (t) => {
      const { worker, gone, stopped } = await fixture(t, 'parent-death');
      assert.equal(worker.kill('SIGKILL'), true);
      await until(stopped, 'Application parent must have exited');
      await until(gone, 'Compiler group survived its application parent', 2000);
    },
  );
}

test(
  'successful compiler exit also stops helpers without waiting for the wall timer',
  native,
  async (t) => {
    const { result, gone } = await fixture(t, 'success');
    assert.equal((await result()).code, 0);
    await until(gone, 'Successful build left a compiler helper', 2000);
  },
);

for (const mode of ['cancel', 'timeout']) {
  test(
    `${mode} stops both compiler and watcher and preserves its diagnostic`,
    native,
    async (t) => {
      const { worker, result, gone } = await fixture(t, mode);
      if (mode === 'cancel') worker.send('cancel');
      const finished = await result();
      assert.equal(finished.code, 1);
      assert.match(
        finished.log!,
        mode === 'cancel' ? /Compilation cancelled/ : /2-second time limit/,
      );
      await until(gone, 'Cancelled or timed-out build left a process', 2000);
    },
  );
}

test('the native executable cannot retain the parent-watch descriptor', native, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-parent-fd-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const compiler = new Compiler(root, root);
  const result = await compiler['run'](
    '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      'if [[ -e /dev/fd/3 ]]; then exit 73; fi; printf descriptor-closed',
    ],
    root,
    root,
    root,
    new AbortController().signal,
    root,
  );
  assert.equal(result.code, 0, result.log);
  assert.equal(result.log, 'descriptor-closed');
});
