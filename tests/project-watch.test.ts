import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectStore } from '../electron/core/project';
import { ProjectScanner, ProjectWatcher } from '../electron/core/project-scan';
import { SaveTransactions } from '../electron/core/save-transactions';
import type { ProjectDiskChanges } from '../src/shared/types';

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-watch-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project'),
    data = path.join(root, 'app');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'main.tex'), 'Original source');
  await fs.writeFile(path.join(directory, 'notes.txt'), 'Original notes');
  await fs.writeFile(path.join(directory, 'photo.png'), Buffer.from([0, 1, 2]));
  const store = new ProjectStore(data),
    project = await store.open(directory);
  return { root, directory, data, store, project };
}
const timeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
  const end = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Watcher condition timed out');
    await timeout(20);
  }
}

test('disk reconciliation ignores own saves, detects source/assets/project data and atomic replacements', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.store.inspectChanges(f.project.id))!.changes, []);
  await f.store.save(f.project);
  assert.deepEqual((await f.store.inspectChanges(f.project.id))!.changes, []);
  await fs.writeFile(path.join(f.directory, '.replacement'), 'Outside source');
  await fs.rename(path.join(f.directory, '.replacement'), path.join(f.directory, 'main.tex'));
  await fs.unlink(path.join(f.directory, 'notes.txt'));
  await fs.mkdir(path.join(f.directory, 'sections'));
  await fs.writeFile(path.join(f.directory, 'sections/new.tex'), 'New source');
  await fs.writeFile(path.join(f.directory, 'photo.png'), Buffer.from([2, 1, 0]));
  await fs.writeFile(path.join(f.directory, 'resume.trash'), 'changed metadata');
  await fs.writeFile(path.join(f.directory, 'ignored.log'), 'not an input');
  const report = (await f.store.inspectChanges(f.project.id))!;
  assert.deepEqual(report.changes, [
    { path: 'main.tex', kind: 'source', change: 'modified' },
    { path: 'notes.txt', kind: 'source', change: 'removed' },
    { path: 'photo.png', kind: 'asset', change: 'modified' },
    { path: 'resume.trash', kind: 'project', change: 'modified' },
    { path: 'sections/new.tex', kind: 'source', change: 'added' },
  ]);
  await assert.rejects(f.store.requireReviewedDisk(f.project.id), /Review the changes/);
});

test('reload preserves every differing editor buffer, acknowledges assets and survives restart without writing the project', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'main.tex'), '\ufeffOutside source');
  await fs.unlink(path.join(f.directory, 'notes.txt'));
  await fs.writeFile(path.join(f.directory, 'photo.png'), 'new image');
  const edited = {
    ...f.project,
    files: f.project.files.map((file) => ({ ...file, content: file.content + ' unsaved' })),
  };
  const report = (await f.store.inspectChanges(f.project.id))!;
  const next = await f.store.useDiskSource(edited, report.token, 'main.tex');
  assert.equal(next.files[0].content, '\ufeffOutside source');
  assert.deepEqual(next.removedFiles!.map((copy) => copy.content).sort(), [
    'Original notes unsaved',
    'Original source unsaved',
  ]);
  assert.ok(next.removedFiles!.every((copy) => copy.reason === 'editor-copy'));
  assert.equal(
    await fs.readFile(path.join(f.directory, 'main.tex'), 'utf8'),
    '\ufeffOutside source',
  );
  await assert.rejects(fs.access(path.join(f.directory, 'resume.trash')), { code: 'ENOENT' });
  const restarted = new ProjectStore(f.data),
    recovered = await restarted.loadRecovery();
  assert.deepEqual(recovered, next);
  assert.deepEqual((await restarted.inspectChanges(next.id))!.changes, []);
  assert.equal((await restarted.save(next)).conflict, false);
});

test('a stale review token, missing main and full copy archive reject before changing recovery or baseline', async (t) => {
  const f = await fixture(t);
  await f.store.recover(f.project);
  const original = await fs.readFile(path.join(f.data, 'recovery.json'));
  await fs.writeFile(path.join(f.directory, 'main.tex'), 'Outside one');
  const report = (await f.store.inspectChanges(f.project.id))!;
  await fs.writeFile(path.join(f.directory, 'main.tex'), 'Outside two');
  await assert.rejects(f.store.useDiskSource(f.project, report.token, 'main.tex'), /changed again/);
  const latest = (await f.store.inspectChanges(f.project.id))!;
  await assert.rejects(
    f.store.useDiskSource(f.project, latest.token, 'missing.tex'),
    /Choose a .tex/,
  );
  const full = {
    ...f.project,
    removedFiles: Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      path: 'old.txt',
      content: String(index),
      removedAt: new Date().toISOString(),
      reason: 'removed' as const,
    })),
  };
  await assert.rejects(f.store.useDiskSource(full, latest.token, 'main.tex'), /100 copies/);
  assert.deepEqual(await fs.readFile(path.join(f.data, 'recovery.json')), original);
  assert.equal((await f.store.inspectChanges(f.project.id))!.changes.length, 1);
});

test('a failed recovery write cannot acknowledge or replace editor source', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.data, 'recovery.json'));
  await fs.writeFile(path.join(f.directory, 'main.tex'), 'Outside');
  const report = (await f.store.inspectChanges(f.project.id))!;
  await assert.rejects(f.store.useDiskSource(f.project, report.token, 'main.tex'));
  assert.equal(
    f.project.files.find((file) => file.path === 'main.tex')!.content,
    'Original source',
  );
  assert.equal((await f.store.inspectChanges(f.project.id))!.changes.length, 1);
});

test('source reload leaves outside history and saved-copy conflicts pending', async (t) => {
  const f = await fixture(t);
  await f.store.save(f.project);
  await fs.writeFile(path.join(f.directory, 'resume.folio'), 'outside history');
  await fs.writeFile(path.join(f.directory, 'resume.trash'), 'outside saved copies');
  await fs.writeFile(path.join(f.directory, 'main.tex'), 'Outside');
  const report = (await f.store.inspectChanges(f.project.id))!;
  const next = await f.store.useDiskSource(f.project, report.token, 'main.tex');
  assert.deepEqual(
    (await f.store.inspectChanges(next.id))!.changes.map((change) => change.path),
    ['resume.folio', 'resume.trash'],
  );
  assert.equal((await f.store.save(next)).conflict, true);
  assert.equal(
    await fs.readFile(path.join(f.directory, 'resume.folio'), 'utf8'),
    'outside history',
  );
});

test('explicit replacement retains external source and fails safely for non-UTF8 bytes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'main.tex'), 'Outside kept copy');
  assert.equal((await f.store.save(f.project)).conflict, true);
  const result = await f.store.save(f.project, undefined, true);
  assert.equal(result.removedFiles![0].content, 'Outside kept copy');
  assert.deepEqual((await f.store.inspectChanges(f.project.id))!.changes, []);
  await fs.writeFile(path.join(f.directory, 'main.tex'), Buffer.from([255, 254, 255]));
  await assert.rejects(f.store.save(f.project, undefined, true), /not UTF-8/);
  assert.deepEqual(
    await fs.readFile(path.join(f.directory, 'main.tex')),
    Buffer.from([255, 254, 255]),
  );
});

test('scanner rejects invalid source, links, oversized files and excessive traversal without following them', async (t) => {
  const f = await fixture(t),
    scanner = new ProjectScanner();
  await fs.writeFile(path.join(f.directory, 'notes.txt'), Buffer.from([255]));
  await assert.rejects(scanner.scan(f.directory), /UTF-8/);
  await fs.unlink(path.join(f.directory, 'notes.txt'));
  await fs.symlink(path.join(f.root, 'unrelated'), path.join(f.directory, 'linked.tex'));
  await assert.rejects(scanner.scan(f.directory), /symbolic link/);
  await fs.unlink(path.join(f.directory, 'linked.tex'));
  await fs.writeFile(path.join(f.directory, 'large.tex'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(scanner.scan(f.directory), /size limit/);
  await fs.unlink(path.join(f.directory, 'large.tex'));
  await fs.mkdir(path.join(f.directory, 'a/b/c/d/e/f/g/h/i'), { recursive: true });
  await assert.rejects(scanner.scan(f.directory), /too deeply/);
});

test('watcher reports nested edits, clears a reverted edit, and reports a missing/restored root', async (t) => {
  const f = await fixture(t),
    events: ProjectDiskChanges[] = [];
  const watcher = new ProjectWatcher(
    (id) => f.store.inspectChanges(id),
    (report) => events.push(report),
    50,
  );
  t.after(() => watcher.stop());
  await watcher.start(f.project.id, f.directory);
  await fs.mkdir(path.join(f.directory, 'nested'));
  await fs.writeFile(path.join(f.directory, 'nested/new.txt'), 'new');
  await until(() =>
    events.some((event) => event.changes.some((change) => change.path === 'nested/new.txt')),
  );
  await fs.unlink(path.join(f.directory, 'nested/new.txt'));
  await until(() => events.at(-1)?.changes.length === 0);
  const moved = f.directory + '-moved';
  await fs.rename(f.directory, moved);
  await until(() => !!events.at(-1)?.error);
  await fs.rename(moved, f.directory);
  await until(() => !events.at(-1)?.error);
});

test('switching or stopping a watcher suppresses results from an earlier in-flight scan', async (t) => {
  const f = await fixture(t),
    events: ProjectDiskChanges[] = [];
  let release!: (value: ProjectDiskChanges) => void;
  const old = new Promise<ProjectDiskChanges>((resolve) => {
    release = resolve;
  });
  const current = { projectId: 'new', token: 'token', changes: [], mainFiles: [] };
  const watcher = new ProjectWatcher(
    (id) => (id === 'old' ? old : Promise.resolve(current)),
    (event) => events.push(event),
    50,
  );
  t.after(() => watcher.stop());
  const pending = watcher.start('old', f.directory);
  await watcher.start('new', f.directory);
  release({ ...current, projectId: 'old' });
  assert.equal(await pending, null);
  assert.deepEqual(
    events.map((event) => event.projectId),
    ['new'],
  );
  watcher.stop();
  assert.equal(await watcher.check(), null);
});

test('inspection waits for a full save transaction instead of reporting intermediate writes', async (t) => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = new ProjectStore(
    f.data,
    new SaveTransactions(f.data, {
      afterApply: async (index) => {
        if (!index) {
          entered();
          await resume;
        }
      },
    }),
  );
  const project = await store.open(f.directory);
  const save = store.save({
    ...project,
    revision: 1,
    files: project.files.map((file) => ({ ...file, content: file.content + ' edited' })),
  });
  await paused;
  let completed = false;
  const inspection = store.inspectChanges(project.id).then((report) => {
    completed = true;
    return report;
  });
  await timeout(30);
  assert.equal(completed, false);
  release();
  await save;
  assert.deepEqual((await inspection)!.changes, []);
});
