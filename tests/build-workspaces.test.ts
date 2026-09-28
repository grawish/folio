import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BuildWorkspaces, cleanupBuildWorkspaces } from '../electron/core/build-workspaces';
import { Compiler } from '../electron/core/compiler';
import { macSandboxProfile } from '../electron/core/runtime';

const ownedRoot = (root: string) => path.join(root, '.folio-build-jobs-v1');
const exists = async (file: string) =>
  fs.lstat(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-build-jobs-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function worker(t: { after(fn: () => Promise<void>): void }, root: string, mode = 'create') {
  const child = fork(
    new URL('./fixtures/build-workspace-worker.ts', import.meta.url),
    [root, mode],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  const stopped = () => child.exitCode !== null || child.signalCode !== null;
  const stop = async () => {
    if (!stopped()) child.kill('SIGKILL');
    for (let n = 0; n < 200 && !stopped(); n++) await delay(10);
    assert.ok(stopped(), 'Owned test worker must exit');
  };
  t.after(stop);
  let output = '';
  child.stderr!.on('data', (b) => (output += b.toString()));
  const message = await new Promise<{ phase: string; payload?: string }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Worker did not reach checkpoint: ' + output)),
      10000,
    );
    child.once('message', (value) => {
      clearTimeout(timer);
      resolve(value as { phase: string; payload?: string });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Worker exited before checkpoint: ' + output));
    });
  });
  assert.equal(message.phase, mode === 'create' ? 'created' : mode);
  return { child, stop, payload: message.payload! };
}

test('ownership stays above compiler writes; ordinary release removes only its own payload', async (t) => {
  const root = await fixture(t);
  const manager = new BuildWorkspaces(root);
  const a = await manager.create(),
    b = await manager.create();
  const record = JSON.parse(
    await fs.readFile(path.join(path.dirname(a.path), 'owner.json'), 'utf8'),
  );
  assert.equal(record.pid, process.pid);
  await fs.writeFile(path.join(a.path, 'source.tex'), 'keep source private');
  assert.deepEqual(await cleanupBuildWorkspaces(root), {
    removed: 0,
    active: 2,
    unrecognized: 0,
    failed: 0,
  });
  assert.equal(await a.release(), true);
  assert.equal(await exists(path.dirname(a.path)), false);
  assert.equal(await exists(b.path), true);
  assert.equal(await b.release(), true);
  assert.deepEqual(await fs.readdir(ownedRoot(root)), []);
});

test('compiler initialization reclaims repeated killed snapshots and preserves cache and legacy data', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'build-legacy'));
  await fs.writeFile(path.join(root, 'build-legacy', 'source.tex'), 'unmarked source');
  await fs.mkdir(path.join(root, 'engine-cache'));
  await fs.writeFile(path.join(root, 'engine-cache', 'warm'), 'cache');
  const staged = [await worker(t, root), await worker(t, root)];
  await Promise.all(staged.map((item) => item.stop()));
  const compiler = new Compiler('unused-runtime', root);
  const report = await compiler['workspaces']?.recovery;
  for (const { payload } of staged)
    assert.equal(
      await exists(path.dirname(payload)),
      false,
      'Killed snapshot survived compiler initialization',
    );
  assert.equal(report?.removed, 2);
  assert.equal(
    await fs.readFile(path.join(root, 'build-legacy', 'source.tex'), 'utf8'),
    'unmarked source',
  );
  assert.equal(await fs.readFile(path.join(root, 'engine-cache', 'warm'), 'utf8'), 'cache');
  assert.deepEqual(await fs.readdir(ownedRoot(root)), []);
});

test('another live process keeps its staged source through repeated cleanup', async (t) => {
  const root = await fixture(t),
    active = await worker(t, root);
  const before = await fs.readFile(path.join(active.payload, 'source', 'main.tex'));
  for (let n = 0; n < 3; n++) assert.equal((await cleanupBuildWorkspaces(root)).active, 1);
  assert.deepEqual(await fs.readFile(path.join(active.payload, 'source', 'main.tex')), before);
  await active.stop();
  assert.equal((await cleanupBuildWorkspaces(root)).removed, 1);
});

for (const checkpoint of ['before-files', 'after-files', 'after-owner']) {
  test(`cleanup resumes after a real process kill at ${checkpoint}`, async (t) => {
    const root = await fixture(t),
      staged = await worker(t, root);
    await staged.stop();
    const cleanup = await worker(t, root, checkpoint);
    const entries = await fs.readdir(ownedRoot(root));
    assert.equal(entries.length, 1);
    assert.ok(entries[0].startsWith('removing-'));
    await cleanup.stop();
    assert.equal((await cleanupBuildWorkspaces(root)).removed, 1);
    assert.deepEqual(await fs.readdir(ownedRoot(root)), []);
    assert.equal((await cleanupBuildWorkspaces(root)).removed, 0);
  });
}

test('nested payload links are unlinked without touching their outside targets', async (t) => {
  const root = await fixture(t),
    staged = await worker(t, root);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep'), 'outside');
  await fs.symlink(outside, path.join(staged.payload, 'linked'));
  await staged.stop();
  assert.equal((await cleanupBuildWorkspaces(root)).removed, 1);
  assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'outside');
});

for (const kind of [
  'missing-owner',
  'malformed-owner',
  'large-owner',
  'foreign-inode',
  'owner-link',
  'owner-hardlink',
  'payload-link',
  'extra-file',
]) {
  test(`cleanup preserves ${kind} data`, async (t) => {
    const root = await fixture(t),
      staged = await worker(t, root);
    await staged.stop();
    const folder = path.dirname(staged.payload),
      record = path.join(folder, 'owner.json');
    const original = await fs.readFile(record);
    const target = path.join(root, 'outside.json');
    await fs.writeFile(target, original);
    if (kind === 'missing-owner') await fs.unlink(record);
    if (kind === 'malformed-owner') await fs.writeFile(record, '{"schema":');
    if (kind === 'large-owner') await fs.writeFile(record, Buffer.alloc(2049));
    if (kind === 'foreign-inode') {
      const data = JSON.parse(original.toString());
      data.jobInode = '0';
      await fs.writeFile(record, JSON.stringify(data));
    }
    if (kind === 'owner-link') {
      await fs.unlink(record);
      await fs.symlink(target, record);
    }
    if (kind === 'owner-hardlink') {
      await fs.unlink(target);
      await fs.link(record, target);
    }
    if (kind === 'payload-link') {
      await fs.rename(staged.payload, path.join(root, 'moved-payload'));
      await fs.symlink(path.join(root, 'moved-payload'), staged.payload);
    }
    if (kind === 'extra-file') await fs.writeFile(path.join(folder, 'unrecognized.txt'), 'keep me');
    assert.equal((await cleanupBuildWorkspaces(root)).removed, 0);
    assert.equal(await exists(folder), true);
    assert.equal(await exists(path.join(staged.payload, 'source', 'main.tex')), true);
    assert.deepEqual(await fs.readFile(target), original);
  });
}

test('unknown folders and a preexisting removal destination are preserved', async (t) => {
  const root = await fixture(t),
    staged = await worker(t, root);
  await staged.stop();
  const parent = path.dirname(staged.payload),
    name = path.basename(parent);
  const destination = path.join(ownedRoot(root), name.replace('job-', 'removing-'));
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'keep'), 'unknown');
  const unknown = path.join(ownedRoot(root), 'notes');
  await fs.mkdir(unknown);
  await fs.writeFile(path.join(unknown, 'keep'), 'notes');
  assert.equal((await cleanupBuildWorkspaces(root)).removed, 0);
  assert.equal(await exists(staged.payload), true);
  assert.equal(await fs.readFile(path.join(destination, 'keep'), 'utf8'), 'unknown');
  assert.equal(await fs.readFile(path.join(unknown, 'keep'), 'utf8'), 'notes');
});

test('a linked private store cannot redirect cleanup or a new build', async (t) => {
  const root = await fixture(t),
    outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep'), 'outside');
  await fs.symlink(outside, ownedRoot(root));
  await assert.rejects(cleanupBuildWorkspaces(root), /Unrecognized/);
  await assert.rejects(new BuildWorkspaces(root).create(), /Unrecognized/);
  assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'outside');
});

test('uncertain process ownership retains the job', async (t) => {
  const root = await fixture(t),
    staged = await worker(t, root);
  await staged.stop();
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === staged.child.pid && signal === 0)
      throw Object.assign(new Error('permission'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  assert.equal((await cleanupBuildWorkspaces(root)).active, 1);
  assert.equal(await exists(staged.payload), true);
});

test(
  'the actual compiler sandbox cannot overwrite the ownership record',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await fixture(t),
      job = await new BuildWorkspaces(root).create();
    const cache = path.join(root, 'cache');
    await fs.mkdir(cache);
    const record = path.join(path.dirname(job.path), 'owner.json'),
      before = await fs.readFile(record);
    const profile = macSandboxProfile('/bin/bash', root, job.path, cache);
    const permitted = path.join(job.path, 'permitted');
    execFileSync(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        profile,
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        'printf permitted > "$1"',
        'write-payload',
        permitted,
      ],
      { stdio: 'pipe' },
    );
    assert.equal(await fs.readFile(permitted, 'utf8'), 'permitted');
    assert.throws(() =>
      execFileSync(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          profile,
          '/bin/bash',
          '--noprofile',
          '--norc',
          '-c',
          'printf overwrite > "$1"',
          'write-owner',
          record,
        ],
        { stdio: 'pipe' },
      ),
    );
    assert.deepEqual(await fs.readFile(record), before);
    await job.release();
  },
);

test('empty interrupted-removal folders are removed only while they remain empty', async (t) => {
  const root = await fixture(t),
    manager = new BuildWorkspaces(root),
    job = await manager.create();
  await job.release();
  const empty = path.join(ownedRoot(root), `removing-${randomUUID()}`);
  await fs.mkdir(empty);
  const unknown = path.join(ownedRoot(root), `removing-${randomUUID()}`);
  await fs.mkdir(unknown);
  await fs.writeFile(path.join(unknown, 'keep'), 'unknown');
  assert.equal((await cleanupBuildWorkspaces(root)).removed, 1);
  assert.equal(await exists(empty), false);
  assert.equal(await fs.readFile(path.join(unknown, 'keep'), 'utf8'), 'unknown');
});

test('failed payload allocation clears the recognized empty job and preserves the error', async (t) => {
  const root = await fixture(t),
    manager = new BuildWorkspaces(root);
  const mkdir = fs.mkdir.bind(fs);
  t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    if (path.basename(String(args[0])) === 'files')
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return mkdir(...args);
  });
  await assert.rejects(manager.create(), { code: 'ENOSPC' });
  assert.deepEqual(await fs.readdir(ownedRoot(root)), []);
});
