import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ProjectStore } from '../electron/core/project';
import { fileDigest, readTarget } from '../electron/core/save-transactions';
import { WorkspaceStore } from '../electron/core/workspace';
import { emptyWorkspace } from '../src/shared/ai';
import { unzipSync, strFromU8 } from 'fflate';

async function killed(script: string, args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '',
    errors = '';
  child.stdout.on('data', (data) => {
    text += data;
    if (text.includes('READY-TO-KILL')) child.kill('SIGKILL');
  });
  child.stderr.on('data', (data) => {
    errors += data;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(errors || 'No crash boundary'));
    }, 15_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (_code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL' && text.includes('READY-TO-KILL')) resolve();
      else reject(new Error(errors));
    });
  });
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-review-store-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'),
    data = path.join(base, 'data');
  await fs.mkdir(root);
  await fs.mkdir(data);
  await fs.writeFile(path.join(root, 'main.tex'), 'Before source');
  await fs.writeFile(path.join(root, 'section.tex'), 'Before section');
  const store = new ProjectStore(data),
    workspaces = new WorkspaceStore(data);
  const project = await store.open(root);
  await workspaces.save({ ...emptyWorkspace(project.id), draft: 'Saved conversation draft' });
  await store.save(project, undefined, false, (id) => workspaces.archive(id));
  const draft = {
    ...project,
    revision: 9,
    files: project.files.map((file) => ({
      ...file,
      content: file.path === 'main.tex' ? 'Unsaved editor draft' : file.content,
    })),
  };
  await store.recover(draft);
  await workspaces.save({ ...emptyWorkspace(project.id), draft: 'Unsaved conversation draft' });
  const recovery = (await readTarget(data, 'recovery.json'))!;
  const input = path.join(base, 'changes.json');
  await fs.writeFile(
    input,
    JSON.stringify([
      { path: 'main.tex', content: 'Attempted source' },
      { path: 'section.tex', content: 'Attempted section' },
    ]),
  );
  await killed('tests/fixtures/save-crash.ts', [data, root, input, 'applying']);
  await fs.writeFile(path.join(root, 'main.tex'), 'Outside edit');
  return { base, root, data, store, workspaces, project, draft, recovery, id: fileDigest(root) };
}

test('store discovers only owned records and retains source, recovery and local conversation before replacing selected files', async (t) => {
  const f = await fixture(t);
  const items = await f.store.interruptedSaves();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, f.id);
  await assert.rejects(f.store.reviewSave('../outside'), /Unknown interrupted save/);
  const review = (await f.store.reviewSave(f.id))!;
  const reply = await f.store.resolveSave(
    f.id,
    review.token,
    review.files.map((file) => ({ path: file.path, version: 'before' })),
    (id) => f.workspaces.archive(id),
  );
  assert.equal(reply.project?.files[0].content, 'Before source');
  const copies = await f.store.recoveryFolder(reply.copyId, 'copies');
  assert.deepEqual(await readTarget(copies, `draft-${fileDigest(f.recovery)}.json`), f.recovery);
  const folder = (await fs.readdir(copies)).find((name) => /^draft-[a-f0-9]{24}$/.test(name))!;
  assert.equal(
    (await readTarget(copies, `${folder}/main.tex`))?.toString(),
    'Unsaved editor draft',
  );
  const history = unzipSync((await readTarget(copies, `${folder}/resume.folio`))!);
  assert.equal(JSON.parse(strFromU8(history['state.json'])).draft, 'Unsaved conversation draft');
  await assert.rejects(f.store.recover(f.draft), /Reopen save recovery/);
  await assert.rejects(f.store.save(f.draft), /Reopen save recovery/);
  await assert.rejects(f.store.clearRecovery(), /Reopen save recovery/);
  const reopened = await new ProjectStore(f.data).loadRecovery();
  assert.equal(reopened?.files[0].content, 'Before source');
  assert.equal((await f.store.interruptedSaves())[0].copyId, reply.copyId);
  await f.store.finishResolvedRecovery(reply.project!);
  assert.deepEqual(await f.store.interruptedSaves(), []);
});

for (const stage of ['prepared', 'applying', 'completed', 'archived'])
  test(`store startup after a kill at ${stage} loads the chosen disk files, not its unsaved draft`, async (t) => {
    const f = await fixture(t);
    await killed('tests/fixtures/save-review-store-crash.ts', [f.data, stage]);
    const nextStore = new ProjectStore(f.data),
      next = await nextStore.loadRecovery();
    assert.equal(next?.files.find((file) => file.path === 'main.tex')?.content, 'Before source');
    assert.ok(nextStore.resolvedSaveCopies);
    assert.deepEqual(
      await readTarget(nextStore.resolvedSaveCopies!, `draft-${fileDigest(f.recovery)}.json`),
      f.recovery,
    );
    await f.workspaces.importFrom(next!.id, next!.directory!, true);
    assert.equal((await f.workspaces.load(next!.id)).draft, 'Saved conversation draft');
    await nextStore.finishResolvedRecovery(next!);
    const again = new ProjectStore(f.data);
    assert.equal((await again.loadRecovery())?.files[0].content, 'Before source');
    assert.equal(again.resolvedSaveCopies, null);
  });

test('stale reviews and history preparation failures do not change the profile or target files', async (t) => {
  const f = await fixture(t),
    review = (await f.store.reviewSave(f.id))!;
  const choices = review.files.map((file) => ({ path: file.path, version: 'before' as const }));
  await fs.writeFile(path.join(f.root, 'main.tex'), 'Newer outside edit');
  await assert.rejects(f.store.resolveSave(f.id, review.token, choices), /changed/);
  assert.deepEqual(await readTarget(f.data, 'recovery.json'), f.recovery);
  const fresh = (await f.store.reviewSave(f.id))!;
  await assert.rejects(
    f.store.resolveSave(f.id, fresh.token, choices, async () => {
      throw new Error('History unreadable');
    }),
    /History unreadable/,
  );
  assert.deepEqual(await readTarget(f.data, 'recovery.json'), f.recovery);
  assert.equal((await readTarget(f.root, 'main.tex'))?.toString(), 'Newer outside edit');
});

test('malformed records remain revealable, parent links cannot grant access, and invalid selected manifests retain the durable marker', async (t) => {
  const f = await fixture(t);
  const badId = 'f'.repeat(64),
    bad = path.join(f.data, 'save-transactions', badId);
  await fs.mkdir(bad);
  await fs.writeFile(path.join(bad, 'journal.json'), '{}');
  assert.ok((await f.store.interruptedSaves()).find((item) => item.id === badId)?.issue);
  assert.equal(await f.store.recoveryFolder(badId, 'record'), bad);
  await assert.rejects(f.store.reviewSave(badId));
  // A valid record ID does not authorize reading a symlinked record folder.
  await fs.rm(bad, { recursive: true });
  await fs.symlink(f.root, bad);
  await assert.rejects(f.store.reviewSave(badId), /without symbolic links/);
  await fs.unlink(bad);
  await fs.writeFile(path.join(f.root, 'resume.project.json'), 'invalid json');
  const review = (await f.store.reviewSave(f.id))!;
  const reply = await f.store.resolveSave(
    f.id,
    review.token,
    review.files.map((file) => ({ path: file.path, version: 'current' })),
  );
  assert.equal(reply.project, null);
  assert.match(reply.warning!, /choices were saved/);
  assert.ok(await f.store.recoveryFolder(reply.copyId, 'copies'));
  await assert.rejects(new ProjectStore(f.data).loadRecovery(), /manifest could not be read/);
});

test('chosen history can replace newer cache only explicitly; its previous cache can be retained separately', async (t) => {
  const f = await fixture(t),
    review = (await f.store.reviewSave(f.id))!;
  const reply = await f.store.resolveSave(
    f.id,
    review.token,
    review.files.map((file) => ({ path: file.path, version: 'current' })),
  );
  await f.workspaces.importFrom(f.project.id, f.root);
  assert.equal((await f.workspaces.load(f.project.id)).draft, 'Unsaved conversation draft');
  const old = await f.workspaces.archive(f.project.id);
  await f.store.preserveResolvedWorkspace(reply.copyId, f.project.id, old);
  await f.workspaces.importFrom(f.project.id, f.root, true);
  assert.equal((await f.workspaces.load(f.project.id)).draft, 'Saved conversation draft');
  const copies = await f.store.recoveryFolder(reply.copyId, 'copies');
  assert.deepEqual(
    await readTarget(copies, `workspace-${f.project.id}-${fileDigest(old)}.folio`),
    Buffer.from(old),
  );
  await fs.unlink(path.join(f.root, 'resume.folio'));
  await f.workspaces.importFrom(f.project.id, f.root, true);
  assert.equal((await f.workspaces.load(f.project.id)).draft, '');
});
