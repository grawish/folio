import { test, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitService } from '../electron/core/git';

let supported = true;
before(() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
  } catch {
    supported = false;
  }
});

// One shared service instance backed by a projectId -> directory map so tests
// register whichever temp repos they need without spinning up ProjectStore.
const dirs = new Map<string, string>();
const service = new GitService({
  directory: (id) => dirs.get(id),
  progress: () => {},
});

function git(root: string, ...args: string[]) {
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
}

async function fixture(t: TestContext, name: string): Promise<{ id: string; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `folio-git-${name}-`));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Folio Test');
  git(root, 'config', 'user.email', 'test@folio.local');
  const id = `${name}-${Math.random().toString(36).slice(2)}`;
  dirs.set(id, root);
  t.after(async () => {
    dirs.delete(id);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { id, root };
}

const write = (root: string, name: string, content: string) => fs.writeFile(path.join(root, name), content);
const read = (root: string, name: string) => fs.readFile(path.join(root, name), 'utf8');
test('gitAvailability reports installed git and any configured identity', { skip: !supported }, async () => {
  const availability = await service.gitAvailability();
  assert.equal(availability.installed, true);
  assert.match(availability.version ?? '', /^\d+\.\d+/);
});

test('unregistered projectId is rejected before touching git', { skip: !supported }, async () => {
  await assert.rejects(service.gitStatus('no-such-project'), /Save this project before using Git/);
});

test('status is null before init, then reflects an empty repo after init', { skip: !supported }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-git-init-'));
  const id = `init-${Math.random().toString(36).slice(2)}`;
  dirs.set(id, root);
  t.after(async () => {
    dirs.delete(id);
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(await service.gitStatus(id), null);
  const status = await service.gitInit(id);
  assert.equal(status.branch, (await service.gitStatus(id))!.branch);
  assert.equal(status.state, 'clean');
  assert.deepEqual(status.files, []);
});

test('stage/unstage transitions cover added, modified and untracked files', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'stage');
  await service.gitInit(id);
  await write(root, 'tracked.txt', 'v1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  await write(root, 'tracked.txt', 'v2\n');
  await write(root, 'new.txt', 'brand new\n');
  const dirty = await service.gitStatus(id);
  assert.deepEqual(
    dirty!.files.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: 'new.txt', staged: null, unstaged: 'untracked', conflicted: false },
      { path: 'tracked.txt', staged: null, unstaged: 'modified', conflicted: false },
    ],
  );
  const staged = await service.gitStage(id, ['tracked.txt', 'new.txt']);
  assert.deepEqual(
    staged.files.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: 'new.txt', staged: 'added', unstaged: null, conflicted: false },
      { path: 'tracked.txt', staged: 'modified', unstaged: null, conflicted: false },
    ],
  );
  const unstaged = await service.gitUnstage(id, ['tracked.txt']);
  const trackedRow = unstaged.files.find((f) => f.path === 'tracked.txt');
  assert.deepEqual(trackedRow, { path: 'tracked.txt', staged: null, unstaged: 'modified', conflicted: false });
});

test('unstaged diff parses multiple hunks and per-hunk patch applies cached and reverses', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'diff');
  await service.gitInit(id);
  const lines = Array.from({ length: 20 }, (_, i) => String(i + 1));
  await write(root, 'f.txt', lines.join('\n') + '\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  const changed = [...lines];
  changed[1] = 'CHANGED2';
  changed[18] = 'CHANGED19';
  await write(root, 'f.txt', changed.join('\n') + '\n');

  const diff = await service.gitDiff(id, { kind: 'unstaged' });
  assert.equal(diff.length, 1);
  assert.equal(diff[0].path, 'f.txt');
  assert.equal(diff[0].hunks.length, 2);
  assert.deepEqual(
    diff[0].hunks.map((h) => h.header),
    ['@@ -1,5 +1,5 @@', '@@ -16,5 +16,5 @@'],
  );

  const [firstHunk] = diff[0].hunks;
  const staged = await service.gitApplyPatch(id, firstHunk.patch, { cached: true, reverse: false });
  const row = staged.files.find((f) => f.path === 'f.txt')!;
  assert.equal(row.staged, 'modified');
  assert.equal(row.unstaged, 'modified');

  const unstagedAgain = await service.gitApplyPatch(id, firstHunk.patch, { cached: true, reverse: true });
  const rowAfterReverse = unstagedAgain.files.find((f) => f.path === 'f.txt')!;
  assert.equal(rowAfterReverse.staged, null);
  assert.equal(rowAfterReverse.unstaged, 'modified');
});

test('working-tree reverse apply discards a hunk without touching the index', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'diff-reverse');
  await service.gitInit(id);
  await write(root, 'work.txt', 'orig\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  await write(root, 'work.txt', 'modified\n');
  const [diffFile] = await service.gitDiff(id, { kind: 'unstaged' });
  await service.gitApplyPatch(id, diffFile.hunks[0].patch, { cached: false, reverse: true });
  assert.equal(await read(root, 'work.txt'), 'orig\n');
});

test('untracked files surface in the unstaged diff as an added-against-/dev/null hunk', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'diff-untracked');
  await service.gitInit(id);
  await write(root, 'new.txt', 'hello\n');
  const diff = await service.gitDiff(id, { kind: 'unstaged' });
  assert.equal(diff.length, 1);
  assert.equal(diff[0].path, 'new.txt');
  assert.equal(diff[0].kind, 'untracked');
});

test('commit records the message and the log paginates newest-first', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'log');
  await service.gitInit(id);
  await write(root, 'f.txt', 'v0\n');
  await service.gitStage(id, ['f.txt']);
  const status = await service.gitCommit(id, 'first commit');
  assert.deepEqual(status.files, []);
  for (let i = 1; i <= 4; i++) {
    await write(root, 'f.txt', `v${i}\n`);
    await service.gitStage(id, ['f.txt']);
    await service.gitCommit(id, `commit ${i}`);
  }
  const page1 = await service.gitLog(id, { skip: 0, limit: 3 });
  const page2 = await service.gitLog(id, { skip: 3, limit: 3 });
  assert.deepEqual(
    page1.map((c) => c.subject),
    ['commit 4', 'commit 3', 'commit 2'],
  );
  assert.deepEqual(
    page2.map((c) => c.subject),
    ['commit 1', 'first commit'],
  );
  assert.equal(page1[0].parents.length, 1);
  assert.equal(page2[1].parents.length, 0);
});

test('restore from an earlier commit rewrites the working file and leaves it unstaged', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'restore');
  await service.gitInit(id);
  await write(root, 'f.txt', 'v1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'c1');
  const [{ hash: c1 }] = await service.gitLog(id);
  await write(root, 'f.txt', 'v2\n');
  git(root, 'commit', '-aq', '-m', 'c2');
  const status = await service.gitRestoreFiles(id, c1, ['f.txt']);
  assert.equal(await read(root, 'f.txt'), 'v1\n');
  const row = status.files.find((f) => f.path === 'f.txt')!;
  assert.equal(row.unstaged, 'modified');
});

test('reverting a commit with no downstream dependents applies cleanly', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'revert-clean');
  await service.gitInit(id);
  await write(root, 'a.txt', 'a\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'c1');
  await write(root, 'b.txt', 'b\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'c2 adds b');
  const [{ hash: c2 }] = await service.gitLog(id);
  const result = await service.gitRevertCommit(id, c2);
  assert.deepEqual(result, { merged: true, conflicts: [] });
  await assert.rejects(fs.access(path.join(root, 'b.txt')));
});

test('reverting a commit whose change was overwritten surfaces the conflicted file', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'revert-conflict');
  await service.gitInit(id);
  await write(root, 'f.txt', 'line1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'c1');
  await write(root, 'f.txt', 'line1\nline2\n');
  git(root, 'commit', '-aq', '-m', 'c2 adds line2');
  await write(root, 'f.txt', 'line1\nline2\nline3\n');
  git(root, 'commit', '-aq', '-m', 'c3 depends on line2');
  const log = await service.gitLog(id);
  const c2 = log.find((c) => c.subject === 'c2 adds line2')!.hash;
  const result = await service.gitRevertCommit(id, c2);
  assert.equal(result.merged, false);
  assert.deepEqual(result.conflicts, ['f.txt']);
  const status = await service.gitStatus(id);
  assert.equal(status!.state, 'reverting');
  assert.equal(status!.files.find((f) => f.path === 'f.txt')!.conflicted, true);
});

test('branch create/switch/rename/delete round-trip through status.branch', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'branches');
  await service.gitInit(id);
  await write(root, 'f.txt', 'v1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');

  const created = await service.gitCreateBranch(id, 'topic', true);
  assert.equal(created.branch, 'topic');
  await service.gitSwitchBranch(id, (await service.gitBranches(id)).find((b) => !b.current)!.name);
  await service.gitSwitchBranch(id, 'topic');
  const renamed = await service.gitRenameBranch(id, 'topic', 'topic2');
  assert.equal(renamed.branch, 'topic2');
  const otherBranch = (await service.gitBranches(id)).find((b) => b.name !== 'topic2')!.name;
  await service.gitSwitchBranch(id, otherBranch);
  await service.gitDeleteBranch(id, 'topic2', false);
  assert.ok(!(await service.gitBranches(id)).some((b) => b.name === 'topic2'));
});

test('merge fast-forwards when there is no divergence', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'merge-ff');
  await service.gitInit(id);
  await write(root, 'f.txt', 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = (await service.gitStatus(id))!.branch!;
  await service.gitCreateBranch(id, 'feature', true);
  await write(root, 'f.txt', 'feature change\n');
  git(root, 'commit', '-aq', '-m', 'feature commit');
  await service.gitSwitchBranch(id, base);
  const result = await service.gitMerge(id, 'feature');
  assert.deepEqual(result, { merged: true, fastForward: true, conflicts: [] });
});

test('merge conflict surfaces the file; resolve with pick then mergeContinue completes it', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'merge-conflict');
  await service.gitInit(id);
  await write(root, 'f.txt', 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = (await service.gitStatus(id))!.branch!;
  await service.gitCreateBranch(id, 'feature', true);
  await write(root, 'f.txt', 'feature change\n');
  git(root, 'commit', '-aq', '-m', 'feature commit');
  await service.gitSwitchBranch(id, base);
  await write(root, 'f.txt', 'main change\n');
  git(root, 'commit', '-aq', '-m', 'main commit');

  const merge = await service.gitMerge(id, 'feature');
  assert.deepEqual(merge, { merged: false, conflicts: ['f.txt'] });
  const versions = await service.gitConflict(id, 'f.txt');
  assert.equal(versions.ours, 'main change\n');
  assert.equal(versions.theirs, 'feature change\n');
  assert.equal(versions.base, 'base\n');

  await service.gitResolveConflict(id, 'f.txt', { pick: 'ours' });
  const continued = await service.gitMergeContinue(id);
  assert.deepEqual(continued, { merged: true, conflicts: [] });
  assert.equal(await read(root, 'f.txt'), 'main change\n');
});

test('merge conflict resolved with explicit content, then abort discards an unrelated conflict', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'merge-content-abort');
  await service.gitInit(id);
  await write(root, 'f.txt', 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = (await service.gitStatus(id))!.branch!;

  await service.gitCreateBranch(id, 'feature', true);
  await write(root, 'f.txt', 'feature\n');
  git(root, 'commit', '-aq', '-m', 'feature');
  await service.gitSwitchBranch(id, base);
  await write(root, 'f.txt', 'main\n');
  git(root, 'commit', '-aq', '-m', 'main');
  await service.gitMerge(id, 'feature');
  await service.gitResolveConflict(id, 'f.txt', { content: 'merged manually\n' });
  const continued = await service.gitMergeContinue(id);
  assert.deepEqual(continued, { merged: true, conflicts: [] });
  assert.equal(await read(root, 'f.txt'), 'merged manually\n');

  await service.gitCreateBranch(id, 'feature2', true);
  await write(root, 'f.txt', 'feature2 change\n');
  git(root, 'commit', '-aq', '-m', 'feature2');
  await service.gitSwitchBranch(id, base);
  await write(root, 'f.txt', 'main2 change\n');
  git(root, 'commit', '-aq', '-m', 'main2');
  const conflict = await service.gitMerge(id, 'feature2');
  assert.equal(conflict.merged, false);
  const aborted = await service.gitMergeAbort(id);
  assert.equal(aborted.state, 'clean');
  assert.deepEqual(aborted.files, []);
  assert.equal(await read(root, 'f.txt'), 'main2 change\n');
});

test('stash save/apply/pop/drop cover both the non-destructive and consuming paths', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'stash');
  await service.gitInit(id);
  await write(root, 'f.txt', 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  await write(root, 'f.txt', 'changed\n');
  await write(root, 'untracked.txt', 'also stashed\n');

  const saved = await service.gitStashSave(id, 'wip stash');
  assert.deepEqual(saved.files, []);
  const stashes = await service.gitStashes(id);
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0].index, 0);
  const stashDiff = await service.gitStashShow(id, 0);
  assert.ok(stashDiff.some((f) => f.path === 'f.txt'));
  assert.ok(stashDiff.some((f) => f.path === 'untracked.txt'));

  const applied = await service.gitStashApply(id, 0, false);
  assert.equal(applied.files.find((f) => f.path === 'f.txt')!.unstaged, 'modified');
  assert.equal((await service.gitStashes(id)).length, 1, 'apply keeps the stash entry');
  await service.gitStashDrop(id, 0);
  assert.deepEqual(await service.gitStashes(id), []);

  await write(root, 'f.txt', 'changed again\n');
  await service.gitStashSave(id, 'second stash');
  const popped = await service.gitStashApply(id, 0, true);
  assert.equal(popped.files.find((f) => f.path === 'f.txt')!.unstaged, 'modified');
  assert.deepEqual(await service.gitStashes(id), [], 'pop consumes the stash entry');
});

test('path validation rejects absolute, escaping, current-directory and .git paths', { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'path-validation');
  await service.gitInit(id);
  await write(root, 'f.txt', 'v1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  const rejectMessage = /repository-relative path/;
  await assert.rejects(service.gitStage(id, ['/etc/passwd']), rejectMessage);
  await assert.rejects(service.gitStage(id, ['../escape.txt']), rejectMessage);
  await assert.rejects(service.gitStage(id, ['a/../../../etc/passwd']), rejectMessage);
  await assert.rejects(service.gitStage(id, ['.git/config']), rejectMessage);
});

test("'-'-prefixed refs are rejected instead of being parsed as git options", { skip: !supported }, async (t) => {
  const { id, root } = await fixture(t, 'ref-validation');
  await service.gitInit(id);
  await write(root, 'f.txt', 'v1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  await assert.rejects(service.gitCreateBranch(id, '-evil', true), /Invalid branch name/);
  await assert.rejects(service.gitSwitchBranch(id, '--upload-pack=x'), /Invalid branch name/);
  await assert.rejects(service.gitRestoreFiles(id, '-x', ['f.txt']), /Invalid commit/);
});
