import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { ProjectStore } from '../electron/core/project';
import { SaveTransactions, fileDigest, readTarget } from '../electron/core/save-transactions';
import { WorkspaceStore } from '../electron/core/workspace';
import { emptyWorkspace } from '../src/shared/ai';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-save-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'resume'),
    data = path.join(root, 'app');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'main.tex'), 'Original source');
  await fs.writeFile(path.join(folder, 'second.tex'), 'Original section');
  const store = new ProjectStore(data),
    project = await store.open(folder);
  await store.save(project, undefined, false, async () => Buffer.from('Original history'));
  const read = (name: string) => fs.readFile(path.join(folder, name), 'utf8');
  return { root, folder, data, store, project, read };
}
const exists = async (name: string) =>
  fs.access(name).then(
    () => true,
    () => false,
  );
const edit = (p: Awaited<ReturnType<typeof fixture>>['project']) => ({
  ...p,
  revision: p.revision + 1,
  files: p.files.map((f) => ({ ...f, content: `${f.content} updated` })),
});

async function crash(f: Awaited<ReturnType<typeof fixture>>, stage = 'applying') {
  const input = path.join(f.root, 'changes.json');
  await fs.writeFile(
    input,
    JSON.stringify([
      { path: 'main.tex', content: 'New source' },
      { path: 'sections/new.tex', content: 'New file' },
      { path: 'resume.folio', content: 'New history' },
    ]),
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/save-crash.ts', f.data, f.folder, input, stage],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Crash fixture did not reach journal boundary: ' + stderr));
    }, 15_000);
    child.on('error', reject);
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
      if (output.includes('READY-TO-KILL')) child.kill('SIGKILL');
    });
    child.on('exit', (_code, signal) => {
      clearTimeout(timeout);
      if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
      else reject(new Error('Crash fixture exited unexpectedly: ' + stderr));
    });
  });
}

test('history preparation failure changes no source, manifest, history or Save As identity', async (t) => {
  const f = await fixture(t),
    originalManifest = await f.read('resume.project.json');
  await assert.rejects(
    f.store.save(edit(f.project), undefined, false, async () => {
      throw new Error('History unavailable');
    }),
    /History unavailable/,
  );
  assert.equal(await f.read('main.tex'), 'Original source');
  assert.equal(await f.read('resume.folio'), 'Original history');
  assert.equal(await f.read('resume.project.json'), originalManifest);
  const copy = path.join(f.root, 'copy');
  await fs.mkdir(copy);
  await assert.rejects(
    f.store.save(edit(f.project), copy, false, async () => {
      throw new Error('History unavailable');
    }),
  );
  assert.deepEqual(await fs.readdir(copy), []);
  assert.equal(f.store.directory(f.project.id), f.folder);
});

test('a write failure rolls back every changed source and keeps the original conflict baseline', async (t) => {
  const f = await fixture(t),
    originalManifest = await f.read('resume.project.json');
  const transaction = new SaveTransactions(f.data, {
    afterApply: async (index) => {
      if (index === 1) throw new Error('Injected disk failure');
    },
  });
  const store = new ProjectStore(f.data, transaction),
    p = await store.open(f.folder);
  await assert.rejects(
    store.save(edit(p), undefined, false, async () => Buffer.from('New history')),
    /previous files were restored/,
  );
  assert.equal(await f.read('main.tex'), 'Original source');
  assert.equal(await f.read('second.tex'), 'Original section');
  assert.equal(await f.read('resume.folio'), 'Original history');
  assert.equal(await f.read('resume.project.json'), originalManifest);
  assert.equal(await new SaveTransactions(f.data).recover(f.folder), 'none');
  assert.equal((await store.save(p)).conflict, false);
});

test('a killed process is rolled back before the project is reopened, including newly created files', async (t) => {
  const f = await fixture(t);
  await crash(f);
  assert.equal(await f.read('main.tex'), 'New source');
  assert.equal(await f.read('sections/new.tex'), 'New file');
  const reopened = await new ProjectStore(f.data).open(f.folder);
  assert.equal(reopened.files.find((file) => file.path === 'main.tex')!.content, 'Original source');
  assert.equal(await exists(path.join(f.folder, 'sections/new.tex')), false);
  assert.equal(await f.read('resume.folio'), 'Original history');
});

test('a committed journal survives a killed cleanup without reverting a successful save', async (t) => {
  const f = await fixture(t);
  await crash(f, 'committed');
  assert.equal(await new SaveTransactions(f.data).recover(f.folder), 'committed');
  assert.equal(await f.read('main.tex'), 'New source');
  assert.equal(await f.read('resume.folio'), 'New history');
  assert.equal(await f.read('sections/new.tex'), 'New file');
});

test('recovery preserves newer external edits and all original backups', async (t) => {
  const f = await fixture(t);
  await crash(f);
  await fs.writeFile(path.join(f.folder, 'main.tex'), 'External edit after the crash');
  await assert.rejects(new ProjectStore(f.data).open(f.folder), /changed afterward/);
  assert.equal(await f.read('main.tex'), 'External edit after the crash');
  const journal = path.join(f.data, 'save-transactions', fileDigest(f.folder));
  assert.equal(await fs.readFile(path.join(journal, 'old-0'), 'utf8'), 'Original source');
  assert.equal(await exists(path.join(journal, 'journal.json')), true);
  assert.equal(await f.read('sections/new.tex'), 'New file');
});

test('damaged recovery backups fail before any file is restored', async (t) => {
  const f = await fixture(t);
  await crash(f);
  await fs.writeFile(
    path.join(f.data, 'save-transactions', fileDigest(f.folder), 'old-0'),
    'Tampered backup',
  );
  await assert.rejects(
    new SaveTransactions(f.data).recover(f.folder),
    /backup is missing or damaged/,
  );
  assert.equal(await f.read('main.tex'), 'New source');
  assert.equal(await f.read('sections/new.tex'), 'New file');
});

test('external deletion and manifest/history edits require the normal conflict choice', async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.folder, 'second.tex'));
  assert.equal((await f.store.save(edit(f.project))).conflict, true);
  assert.equal(await f.read('main.tex'), 'Original source');
  await fs.writeFile(path.join(f.folder, 'second.tex'), 'Original section');
  await fs.writeFile(path.join(f.folder, 'resume.folio'), 'External history');
  assert.equal(
    (await f.store.save(f.project, undefined, false, async () => Buffer.from('Current history')))
      .conflict,
    true,
  );
  assert.equal(await f.read('resume.folio'), 'External history');
  await fs.writeFile(path.join(f.folder, 'resume.project.json'), '{"name":"External title"}');
  assert.equal((await f.store.save(f.project)).conflict, true);
});

test('asset collision and dangling parent symlinks are rejected before any writes', async (t) => {
  const f = await fixture(t),
    copy = path.join(f.root, 'copy');
  await fs.mkdir(copy);
  await fs.writeFile(path.join(f.folder, 'a.png'), 'First asset');
  await fs.writeFile(path.join(f.folder, 'b.png'), 'Second asset');
  await fs.writeFile(path.join(copy, 'b.png'), 'Unrelated image');
  await assert.rejects(f.store.save(f.project, copy), /overwrite asset/);
  assert.deepEqual(await fs.readdir(copy), ['b.png']);
  const outside = path.join(f.root, 'must-not-be-created');
  await fs.symlink(outside, path.join(f.folder, 'sections'));
  await assert.rejects(
    f.store.save({
      ...edit(f.project),
      files: [...edit(f.project).files, { path: 'sections/new.tex', content: 'No escape' }],
    }),
    /without symbolic links/,
  );
  assert.equal(await exists(outside), false);
  assert.equal(await f.read('main.tex'), 'Original source');
});

test('a recent-list write failure reports a warning after a successful complete save', async (t) => {
  const f = await fixture(t);
  await fs.rm(path.join(f.data, 'recent.json'));
  await fs.mkdir(path.join(f.data, 'recent.json'));
  const result = await f.store.save(edit(f.project), undefined, false, async () =>
    Buffer.from('Updated history'),
  );
  assert.equal(result.conflict, false);
  assert.match(result.warning!, /Project saved/);
  assert.equal(await f.read('main.tex'), 'Original source updated');
  assert.equal(await f.read('resume.folio'), 'Updated history');
});

test('Save As commits matching project/history identities and reopens the archived conversation', async (t) => {
  const f = await fixture(t),
    workspace = new WorkspaceStore(f.data);
  await workspace.save({ ...emptyWorkspace(f.project.id), draft: 'Keep this draft' });
  const copy = path.join(f.root, 'copy');
  await fs.mkdir(copy);
  const result = await f.store.save(f.project, copy, false, (id) =>
    workspace.archive(f.project.id, id),
  );
  assert.notEqual(result.projectId, f.project.id);
  const reopened = await new ProjectStore(f.data).open(copy);
  assert.equal(reopened.id, result.projectId);
  await workspace.importFrom(reopened.id, copy);
  assert.equal((await workspace.load(reopened.id)).draft, 'Keep this draft');
  assert.equal((await workspace.load(f.project.id)).draft, 'Keep this draft');
  assert.ok(await readTarget(copy, 'resume.folio'));
});

test('an interrupted rollback is resumed even when its temporary replacement remains', async (t) => {
  const f = await fixture(t);
  await crash(f);
  const directory = path.join(f.data, 'save-transactions', fileDigest(f.folder));
  const journal = JSON.parse(await fs.readFile(path.join(directory, 'journal.json'), 'utf8'));
  const temporary = `${path.join(f.folder, 'main.tex')}.restore-${journal.nonce}.tmp`;
  await fs.writeFile(temporary, 'Partial restored bytes');
  assert.equal(await new SaveTransactions(f.data).recover(f.folder), 'rolled-back');
  assert.equal(await f.read('main.tex'), 'Original source');
  assert.equal(await exists(temporary), false);
});

test('recovery follows the canonical project directory when opened through an alias', async (t) => {
  const f = await fixture(t),
    alias = path.join(f.root, 'alias');
  await fs.symlink(f.folder, alias);
  const transaction = new SaveTransactions(f.data);
  await transaction.commit(alias, [
    {
      path: 'main.tex',
      before: Buffer.from('Original source'),
      data: Buffer.from('Through alias'),
    },
  ]);
  assert.equal(await f.read('main.tex'), 'Through alias');
  assert.equal(await transaction.recover(f.folder), 'none');
});

test('history export refuses corrupted snapshots and excessive version counts', async (t) => {
  const f = await fixture(t),
    workspace = new WorkspaceStore(f.data);
  const version = await workspace.checkpoint(f.project, Buffer.from('%PDF-1.4\nfixture'));
  const pdfFile = path.join(
    f.data,
    'workspaces',
    f.project.id,
    'versions',
    version.id,
    'resume.pdf',
  );
  await fs.appendFile(pdfFile, 'Modified');
  await assert.rejects(workspace.archive(f.project.id), /damaged/);
  const stateFile = path.join(f.data, 'workspaces', f.project.id, 'state.json');
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  state.versions = Array.from({ length: 1001 }, (_, i) => ({ ...version, id: `version-${i}` }));
  await fs.writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(workspace.archive(f.project.id), /1,000-version/);
});

test('a killed rollback cleanup does not require backups that were already deleted', async (t) => {
  const f = await fixture(t);
  await crash(f);
  await crash(f, 'rollback');
  assert.equal(await f.read('main.tex'), 'Original source');
  await fs.unlink(path.join(f.data, 'save-transactions', fileDigest(f.folder), 'old-0'));
  assert.equal(await new SaveTransactions(f.data).recover(f.folder), 'rolled-back');
  assert.equal(await f.read('main.tex'), 'Original source');
  assert.equal(await exists(path.join(f.folder, 'sections/new.tex')), false);
});

test('history import rejects duplicate and excessive version records before writing files', async (t) => {
  const f = await fixture(t),
    workspace = new WorkspaceStore(f.data);
  const version = await workspace.checkpoint(f.project, Buffer.from('%PDF-1.4\nfixture'));
  const archive = unzipSync(await workspace.archive(f.project.id));
  const state = JSON.parse(strFromU8(archive['state.json']));
  const imported = new WorkspaceStore(path.join(f.root, 'imported-data'));
  for (const [records, message] of [
    [Array(2).fill(version), /duplicate version/],
    [Array(1001).fill(version), /1,000-version/],
  ] as const) {
    archive['state.json'] = strToU8(JSON.stringify({ ...state, versions: records }));
    await fs.writeFile(path.join(f.folder, 'resume.folio'), zipSync(archive));
    await assert.rejects(imported.importFrom(f.project.id, f.folder), message);
    assert.equal(
      await exists(path.join(f.root, 'imported-data', 'workspaces', f.project.id)),
      false,
    );
  }
});
