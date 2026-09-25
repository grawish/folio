import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import { ProjectStore, readRemovedFileArchive, removedFileArchive } from '../electron/core/project';
import { SaveTransactions, readTarget } from '../electron/core/save-transactions';
import { ProjectImporter } from '../electron/core/project-import';
import {
  addSource,
  renameSource,
  removeSource,
  restoreSource,
  validateRemovedFiles,
} from '../src/shared/project-files';

async function fixture(t: TestContext, hooks = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-files-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project'),
    data = path.join(root, 'app');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'main.tex'), 'Main source');
  await fs.writeFile(path.join(directory, 'section.tex'), '\ufeffOriginal section');
  const store = new ProjectStore(data, new SaveTransactions(data, hooks));
  const project = await store.open(directory);
  return { root, directory, data, store, project };
}
const absent = async (filename: string) => assert.rejects(fs.access(filename), { code: 'ENOENT' });

test('new source names reject portable collisions and project capacity before changing state', async (t) => {
  const { project } = await fixture(t);
  const nested = addSource(project, 'Café.tex/details.txt');
  assert.throws(() => addSource(nested, 'Cafe\u0301.tex'), /folder or file/);
  assert.throws(() => addSource(nested, 'café.tex/other.txt'), /folder spelling/);
  assert.throws(() => addSource(nested, 'Cafe\u0301.tex/details.txt'), /already exists/);
  assert.throws(() => addSource(project, 'aux.tex'), /relative/);
  const full = {
    ...project,
    files: Array.from({ length: 100 }, (_, i) => ({ path: `${i}.tex`, content: '' })),
  };
  assert.throws(() => addSource(full, 'extra.tex'), /100 source/);
  assert.equal(full.files.length, 100);
});

test('rename updates the main entry, rejects collisions and retains both active and earlier bytes', async (t) => {
  const f = await fixture(t);
  assert.throws(() => renameSource(f.project, 'main.tex', 'section.tex'), /already exists/);
  assert.throws(() => renameSource(f.project, 'main.tex', '../evil.tex'), /relative/);
  assert.throws(() => renameSource(f.project, 'main.tex', 'MAIN.tex'), /different name/);
  assert.throws(() => renameSource(f.project, 'main.tex', 'main.sty'), /main document/);
  const edited = {
    ...f.project,
    files: f.project.files.map((file) =>
      file.path === 'main.tex' ? { ...file, content: 'Unsaved main changes' } : file,
    ),
  };
  const renamed = renameSource(edited, 'main.tex', 'resume.tex');
  const saved = await f.store.save(renamed);
  assert.equal(saved.conflict, false);
  await absent(path.join(f.directory, 'main.tex'));
  assert.equal(
    await fs.readFile(path.join(f.directory, 'resume.tex'), 'utf8'),
    'Unsaved main changes',
  );
  const opened = await f.store.open(f.directory);
  assert.equal(opened.mainFile, 'resume.tex');
  assert.equal(
    opened.removedFiles?.find((copy) => copy.path === 'main.tex')?.content,
    'Main source',
  );
});

test('removal and restore preserve unsaved text, original BOM, disk bytes and recovery across restart', async (t) => {
  const f = await fixture(t);
  const edited = {
    ...f.project,
    files: f.project.files.map((file) =>
      file.path === 'section.tex' ? { ...file, content: 'Unsaved section' } : file,
    ),
  };
  const removed = removeSource(edited, 'section.tex');
  await f.store.recover(removed);
  assert.equal(
    (await new ProjectStore(f.data).loadRecovery())!.removedFiles![0].content,
    'Unsaved section',
  );
  const saved = await f.store.save(removed);
  assert.equal(saved.removedFiles?.length, 2);
  await absent(path.join(f.directory, 'section.tex'));
  const reopened = await new ProjectStore(f.data).open(f.directory);
  assert.deepEqual(
    reopened.removedFiles?.map((file) => file.content).sort(),
    ['Unsaved section', '\ufeffOriginal section'].sort(),
  );
  const copy = reopened.removedFiles!.find((file) => file.content === 'Unsaved section')!;
  assert.throws(() => restoreSource(reopened, copy.id, 'main.tex'), /already exists/);
  const restored = restoreSource(reopened, copy.id, 'section.tex');
  await f.store.save(restored);
  assert.equal(await fs.readFile(path.join(f.directory, 'section.tex'), 'utf8'), 'Unsaved section');
  assert.equal((await f.store.open(f.directory)).removedFiles?.length, 1);
});

test('last-main protection and copy limits fail before losing any source', async (t) => {
  const f = await fixture(t);
  assert.throws(() => removeSource(f.project, 'main.tex'), /at least one/);
  const next = removeSource(f.project, 'main.tex', 'section.tex');
  assert.equal(next.mainFile, 'section.tex');
  assert.throws(() => removeSource(next, 'section.tex'), /at least one/);
  assert.throws(
    () => validateRemovedFiles(Array.from({ length: 101 }, (_, i) => ({ id: String(i) }))),
    /100 copies/,
  );
  assert.throws(
    () => validateRemovedFiles([{ ...next.removedFiles![0], path: '../outside.tex' }]),
    /relative/,
  );
  const over = Array.from({ length: 6 }, (_, i) => ({
    ...next.removedFiles![0],
    id: String(i),
    content: 'x'.repeat(2 * 1024 * 1024),
  }));
  assert.throws(() => validateRemovedFiles(over), /10 MB/);
  assert.equal(await fs.readFile(path.join(f.directory, 'main.tex'), 'utf8'), 'Main source');
});

test('external edits to a removed file require a choice and are retained on approved replacement', async (t) => {
  const f = await fixture(t),
    removed = removeSource(f.project, 'section.tex');
  await fs.writeFile(path.join(f.directory, 'section.tex'), 'Newer outside edit');
  assert.equal((await f.store.save(removed)).conflict, true);
  assert.equal(
    await fs.readFile(path.join(f.directory, 'section.tex'), 'utf8'),
    'Newer outside edit',
  );
  await absent(path.join(f.directory, 'resume.trash'));
  const saved = await f.store.save(removed, undefined, true);
  assert.ok(saved.removedFiles?.some((copy) => copy.content === 'Newer outside edit'));
  assert.ok(saved.removedFiles?.some((copy) => copy.content === '\ufeffOriginal section'));
  await absent(path.join(f.directory, 'section.tex'));
});

test('changed trash conflicts and malformed trash fails without deleting source', async (t) => {
  const f = await fixture(t);
  await f.store.save(f.project);
  const before = await fs.readFile(path.join(f.directory, 'resume.trash'));
  await fs.writeFile(path.join(f.directory, 'resume.trash'), 'outside change');
  assert.equal((await f.store.save(removeSource(f.project, 'section.tex'))).conflict, true);
  await assert.rejects(new ProjectStore(f.data).open(f.directory), /could not be read/);
  assert.equal(
    await fs.readFile(path.join(f.directory, 'section.tex'), 'utf8'),
    '\ufeffOriginal section',
  );
  await fs.writeFile(path.join(f.directory, 'resume.trash'), before);
});

test('a failure after deletion rolls back source, manifest and saved copies together', async (t) => {
  const f = await fixture(t);
  await f.store.save(f.project);
  const before = await fs.readFile(path.join(f.directory, 'resume.trash'));
  const transaction = new SaveTransactions(f.data, {
    afterApply: async () => {
      if (!(await readTarget(f.directory, 'section.tex')))
        throw new Error('Injected after removal');
    },
  });
  const store = new ProjectStore(f.data, transaction),
    project = await store.open(f.directory);
  await assert.rejects(
    store.save(removeSource(project, 'section.tex')),
    /previous files were restored/,
  );
  assert.equal(
    await fs.readFile(path.join(f.directory, 'section.tex'), 'utf8'),
    '\ufeffOriginal section',
  );
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'resume.trash')), before);
});

test('a process killed after a deletion restores the original file before reopening', async (t) => {
  const f = await fixture(t),
    input = path.join(f.root, 'changes.json');
  await fs.mkdir(f.data, { recursive: true });
  await fs.writeFile(
    input,
    JSON.stringify([
      { path: 'main.tex', content: 'Changed main' },
      { path: 'section.tex', content: null },
    ]),
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/save-crash.ts', f.data, f.directory, input, 'applying'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(stderr || 'Crash fixture timed out'));
    }, 15_000);
    child.stdout.on('data', (data) => {
      stdout += data;
      if (stdout.includes('READY-TO-KILL')) child.kill('SIGKILL');
    });
    child.once('error', reject);
    child.once('exit', (_code, signal) => {
      clearTimeout(timeout);
      if (signal === 'SIGKILL' && stdout.includes('READY-TO-KILL')) resolve();
      else reject(new Error(stderr));
    });
  });
  await absent(path.join(f.directory, 'section.tex'));
  const restored = await new ProjectStore(f.data).open(f.directory);
  assert.equal(
    restored.files.find((file) => file.path === 'section.tex')?.content,
    '\ufeffOriginal section',
  );
  assert.equal(restored.files.find((file) => file.path === 'main.tex')?.content, 'Main source');
});

test('Save As and ZIP import keep removed copies independent of the original', async (t) => {
  const f = await fixture(t),
    removed = removeSource(f.project, 'section.tex');
  const copy = path.join(f.root, 'copy');
  await fs.mkdir(copy);
  const saved = await f.store.save(removed, copy);
  assert.notEqual(saved.projectId, f.project.id);
  assert.equal(
    await fs.readFile(path.join(f.directory, 'section.tex'), 'utf8'),
    '\ufeffOriginal section',
  );
  assert.equal((await f.store.open(copy)).removedFiles?.length, 1);
  const archive = path.join(f.root, 'project.zip');
  await fs.writeFile(
    archive,
    zipSync({
      'main.tex': strToU8('Main source'),
      'resume.trash': removedFileArchive(removed.removedFiles),
    }),
  );
  const importer = new ProjectImporter(path.join(f.root, 'import-app')),
    preview = await importer.prepare(archive);
  assert.equal(preview.assetCount, 0);
  assert.equal(preview.skipped.length, 0);
  const imported = await importer.finish(preview.token, 'main.tex', f.root);
  assert.equal(
    (await new ProjectStore(path.join(f.root, 'import-app')).open(imported)).removedFiles?.[0]
      .content,
    '\ufeffOriginal section',
  );
  assert.equal(
    readRemovedFileArchive(await fs.readFile(path.join(imported, 'resume.trash'))).length,
    1,
  );
});
