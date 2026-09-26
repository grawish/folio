import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { readSafeZip, crc32, type ZipLimits } from '../electron/core/safe-zip';
import { inspectProjectArchive, ProjectImporter } from '../electron/core/project-import';
import { ProjectStore } from '../electron/core/project';
import { WorkspaceStore } from '../electron/core/workspace';
import { emptyWorkspace } from '../src/shared/ai';

const MB = 1024 * 1024;
const limits: ZipLimits = { compressed: MB, expanded: MB, entries: 100, entryBytes: () => MB };
const tex = '\\documentclass{article}\n\\begin{document}Imported resume\\end{document}';
const zip = (files: Record<string, string> = { 'main.tex': tex }) =>
  Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]))),
  );
const central = (data: Buffer) => data.readUInt32LE(data.length - 6);
const mutate = (change: (data: Buffer, central: number) => void, base = zip()) => {
  const result = Buffer.from(base);
  change(result, central(result));
  return result;
};
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-zip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'resume.zip');
  await fs.writeFile(filename, zip());
  const parent = path.join(root, 'destination');
  await fs.mkdir(parent);
  return { root, filename, parent };
}

test('ZIP reader accepts stored/deflated files, folders, UTF-8 and standard data descriptors', () => {
  const data = Buffer.from(
    zipSync({ 'résumé/': new Uint8Array(), 'résumé/main.tex': strToU8(tex) }),
  );
  assert.equal(readSafeZip(data, limits).get('résumé/main.tex')?.toString(), tex);
  assert.equal(
    readSafeZip(zipSync({ 'main.tex': strToU8(tex) }, { level: 0 }), limits)
      .get('main.tex')
      ?.toString(),
    tex,
  );
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const original = zip(),
    c = central(original),
    descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50);
  original.copy(descriptor, 4, 14, 26);
  const streamed = Buffer.concat([original.subarray(0, c), descriptor, original.subarray(c)]);
  streamed.writeUInt16LE(8, 6);
  streamed.fill(0, 14, 26);
  streamed.writeUInt16LE(8, c + 16 + 8);
  streamed.writeUInt32LE(c + 16, streamed.length - 6);
  assert.equal(readSafeZip(streamed, limits).get('main.tex')?.toString(), tex);
});

test('ZIP reader rejects traversal, absolute/device/ambiguous paths and file-folder collisions', () => {
  for (const name of [
    '../x.tex',
    '/x.tex',
    'C:/x.tex',
    'a\\x.tex',
    'a//x.tex',
    'a/./x.tex',
    'a/../x.tex',
    'nul.tex',
    'COM1.tex',
    'a /x.tex',
    'a./x.tex',
    'a\0.tex',
  ])
    assert.throws(() => readSafeZip(zip({ [name]: tex }), limits), /unsafe|UTF-8/, name);
  const collisions: Record<string, string>[] = [
    { 'main.tex': tex, 'MAIN.tex': tex },
    { a: 'file', 'a/main.tex': tex },
    { 'A/main.tex': tex, 'a/other.tex': tex },
    { 'café.tex': tex, 'café.tex': tex },
  ];
  for (const files of collisions)
    assert.throws(() => readSafeZip(zip(files), limits), /duplicate|conflict/);
  const duplicate = mutate(
    (data, c) => {
      const next = c + 46 + 5;
      Buffer.from('a.tex').copy(data, next + 46);
      const local = data.readUInt32LE(next + 42);
      Buffer.from('a.tex').copy(data, local + 30);
    },
    zip({ 'a.tex': 'a', 'b.tex': 'b' }),
  );
  assert.throws(() => readSafeZip(duplicate, limits), /duplicate/);
});

test('ZIP reader rejects symlinks, devices, encryption, ZIP64 and unsupported compression', () => {
  for (const mode of [0o120777, 0o020666, 0o060666, 0o010666])
    assert.throws(
      () =>
        readSafeZip(
          mutate((data, c) => data.writeUInt32LE((mode << 16) >>> 0, c + 38)),
          limits,
        ),
      /links|special/,
    );
  for (const changed of [
    mutate((d, c) => d.writeUInt16LE(1, c + 8)),
    mutate((d, c) => d.writeUInt16LE(99, c + 10)),
    mutate((d, c) => d.writeUInt16LE(45, c + 6)),
    mutate((d) => d.writeUInt16LE(1, d.length - 18)),
  ])
    assert.throws(() => readSafeZip(changed, limits), /encrypted|unsupported|split/);
});

test('ZIP reader checks headers, checksums, truncation and overlapping records', () => {
  for (const changed of [
    mutate((d) => {
      d[30] = 120;
    }),
    mutate((d, c) => {
      d.writeUInt32LE(2, 14);
      d.writeUInt32LE(2, c + 16);
    }),
    mutate((d, c) => d.writeUInt32LE(1, c + 42)),
    zip().subarray(0, -1),
    Buffer.concat([zip(), Buffer.from('junk')]),
  ])
    assert.throws(() => readSafeZip(changed, limits), /headers|checksum|header|incomplete/);
});

test('ZIP reader enforces compressed, expanded, entry and actual inflation bounds', () => {
  const data = zip({ 'main.tex': 'x'.repeat(100_000) });
  for (const custom of [
    { ...limits, compressed: 50 },
    { ...limits, expanded: 1000 },
    { ...limits, entries: 0 },
    { ...limits, entryBytes: () => 1000 },
  ])
    assert.throws(() => readSafeZip(data, custom), /limit/);
  const lying = mutate((d, c) => {
    d.writeUInt32LE(10, 22);
    d.writeUInt32LE(10, c + 24);
  }, data);
  assert.throws(() => readSafeZip(lying, limits), /declared size/);
});

test('project ZIP inspection handles a wrapper folder, main choices, assets and skipped files', () => {
  const result = inspectProjectArchive(
    zip({
      'resume/main.tex': tex,
      'resume/cover.tex': tex,
      'resume/assets/photo.png': 'image',
      'resume/README.md': 'Instructions',
      '__MACOSX/._main.tex': 'metadata',
      'resume/resume.project.json': JSON.stringify({
        schemaVersion: 2,
        id: 'untrusted-original',
        name: 'My imported resume',
        mainFile: 'cover.tex',
      }),
    }),
    'resume.zip',
  );
  assert.deepEqual(result.preview.mainFiles, ['cover.tex', 'main.tex']);
  assert.equal(result.preview.suggestedMain, 'cover.tex');
  assert.equal(result.preview.name, 'My imported resume');
  assert.equal(result.preview.sourceCount, 2);
  assert.equal(result.preview.assetCount, 1);
  assert.equal(result.preview.skipped.length, 2);
  assert.notEqual(result.project.id, 'untrusted-original');
  assert.equal(result.files.get('assets/photo.png')?.toString(), 'image');
});

test('project ZIP rejects invalid manifests, non-UTF8 source and source/file size limits', () => {
  for (const metadata of ['{broken', 'null', JSON.stringify({ schemaVersion: 99 })])
    assert.throws(
      () =>
        inspectProjectArchive(zip({ 'main.tex': tex, 'resume.project.json': metadata }), 'x.zip'),
      /manifest|project format/,
    );
  assert.throws(() => inspectProjectArchive(zip({ 'readme.md': 'hello' }), 'x.zip'), /\.tex/);
  assert.throws(
    () => inspectProjectArchive(zipSync({ 'main.tex': new Uint8Array([255, 254]) }), 'x.zip'),
    /UTF-8/,
  );
  assert.throws(
    () => inspectProjectArchive(zip({ 'main.tex': 'x'.repeat(2 * MB + 1) }), 'x.zip'),
    /2 MB/,
  );
  assert.throws(
    () =>
      inspectProjectArchive(
        zip(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`file-${i}.tex`, tex]))),
        'x.zip',
      ),
    /100-file/,
  );
});

test('import creates an independent copy, preserves binary assets and never overwrites a sibling', async (t) => {
  const f = await fixture(t),
    importer = new ProjectImporter(path.join(f.root, 'import-app'));
  const data = zipSync({
    'main.tex': strToU8(tex),
    'other.tex': strToU8(tex),
    'photo.png': new Uint8Array([0, 255, 1]),
  });
  await fs.writeFile(f.filename, data);
  const sibling = path.join(f.parent, 'resume');
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'main.tex'), 'existing');
  const preview = await importer.prepare(f.filename);
  await assert.rejects(importer.finish(preview.token, '../evil.tex', f.parent), /main document/);
  await assert.rejects(importer.finish('wrong-token', 'main.tex', f.parent), /expired/);
  const directory = await importer.finish(preview.token, 'other.tex', f.parent);
  const store = new ProjectStore(path.join(f.root, 'app')),
    project = await store.open(directory);
  assert.equal(project.mainFile, 'other.tex');
  assert.deepEqual(await fs.readFile(path.join(directory, 'photo.png')), Buffer.from([0, 255, 1]));
  assert.equal(await fs.readFile(path.join(sibling, 'main.tex'), 'utf8'), 'existing');
  assert.deepEqual(await fs.readFile(f.filename), Buffer.from(data));
  await assert.rejects(importer.finish(preview.token, 'other.tex', f.parent), /expired/);
});

test('cancelled imports create nothing and a failed write removes only its new folder', async (t) => {
  const f = await fixture(t),
    cancelled = new ProjectImporter(path.join(f.root, 'import-app'));
  const originalArchive = await fs.readFile(f.filename);
  const preview = await cancelled.prepare(f.filename);
  cancelled.cancel(preview.token);
  await assert.rejects(cancelled.finish(preview.token, 'main.tex', f.parent), /expired/);
  assert.deepEqual(await fs.readdir(f.parent), []);
  let writes = 0;
  const broken = new ProjectImporter(path.join(f.root, 'import-app'), async (filename, data) => {
    if (++writes === 2) throw new Error('Injected disk failure');
    await fs.writeFile(filename, data, { flag: 'wx' });
  });
  const pending = await broken.prepare(f.filename);
  await assert.rejects(broken.finish(pending.token, 'main.tex', f.parent), /Injected disk failure/);
  assert.deepEqual(await fs.readdir(f.parent), []);
  assert.deepEqual(await fs.readFile(f.filename), originalArchive);
});

test('exported conversation and PDF history round-trip under a fresh import identity', async (t) => {
  const f = await fixture(t),
    workspace = new WorkspaceStore(path.join(f.root, 'original-app'));
  const project = {
    id: 'original-project',
    name: 'Resume',
    mainFile: 'main.tex',
    revision: 0,
    files: [{ path: 'main.tex', content: tex }],
  };
  const version = await workspace.checkpoint(
    project,
    Buffer.from('%PDF-1.4\nExample'),
    'Before import',
  );
  await workspace.save({ ...emptyWorkspace(project.id), draft: 'Keep this draft' });
  await fs.writeFile(
    f.filename,
    zipSync({
      'main.tex': strToU8(tex),
      'resume.folio': await workspace.archive(project.id),
      'resume.project.json': strToU8(JSON.stringify({ ...project, schemaVersion: 2 })),
    }),
  );
  const importer = new ProjectImporter(path.join(f.root, 'import-app')),
    preview = await importer.prepare(f.filename);
  assert.equal(preview.hasHistory, true);
  const directory = await importer.finish(preview.token, 'main.tex', f.parent);
  const imported = await new ProjectStore(path.join(f.root, 'imported-app')).open(directory);
  assert.notEqual(imported.id, project.id);
  const archive = unzipSync(await fs.readFile(path.join(directory, 'resume.folio')));
  assert.equal(JSON.parse(Buffer.from(archive['state.json']).toString()).projectId, imported.id);
  const importedWorkspace = new WorkspaceStore(path.join(f.root, 'imported-app'));
  await importedWorkspace.importFrom(imported.id, directory);
  assert.equal((await importedWorkspace.load(imported.id)).draft, 'Keep this draft');
  assert.equal((await importedWorkspace.version(imported.id, version.id)).files[0].content, tex);
  assert.equal((await workspace.load(project.id)).draft, 'Keep this draft');
});

test('damaged nested history is rejected before extraction', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    f.filename,
    zipSync({ 'main.tex': strToU8(tex), 'resume.folio': strToU8('bad history') }),
  );
  await assert.rejects(
    new ProjectImporter(path.join(f.root, 'import-app')).prepare(f.filename),
    /ZIP/,
  );
  assert.deepEqual(await fs.readdir(f.parent), []);
});

test(
  'selected archives must be regular files, without following links or waiting on pipes',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t),
      importer = new ProjectImporter(path.join(f.root, 'import-app'));
    const link = path.join(f.root, 'linked.zip'),
      pipe = path.join(f.root, 'pipe.zip');
    await fs.symlink(f.filename, link);
    await assert.rejects(importer.prepare(link));
    execFileSync('/usr/bin/mkfifo', [pipe]);
    await assert.rejects(importer.prepare(pipe), /Choose a ZIP file/);
    await assert.rejects(importer.prepare(f.parent), /Choose a ZIP file/);
    assert.deepEqual(await fs.readdir(f.parent), []);
  },
);
