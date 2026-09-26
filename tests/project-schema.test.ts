import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { zipSync } from 'fflate';
import { ProjectStore } from '../electron/core/project';
import { WorkspaceStore } from '../electron/core/workspace';
import { SaveTransactions } from '../electron/core/save-transactions';
import { inspectProjectArchive } from '../electron/core/project-import';
import type { RuntimePin } from '../src/shared/runtime';

const pin: RuntimePin = {
  engine: 'tectonic',
  version: '0.17.0',
  bundle: 'folio-core-v1',
  id: 'a'.repeat(64),
  platform: 'darwin-arm64',
  biberVersion: '2.17',
};
const oldManifest = {
  schemaVersion: 1,
  id: 'older-project',
  name: 'Older project',
  revision: 7,
  mainFile: 'main.tex',
  templateId: 'classic',
  templateVersion: 1,
  engine: 'tectonic@0.17.0',
  bundle: 'folio-core-v1',
};
const source = String.raw`\documentclass{article}\begin{document}Older resume\end{document}`;
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-schema-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'project'),
    data = path.join(root, 'app');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'main.tex'), source);
  await fs.writeFile(path.join(folder, 'section.tex'), '% Original section');
  await fs.writeFile(
    path.join(folder, 'resume.project.json'),
    JSON.stringify(oldManifest, null, 2),
  );
  const unopened = await tree(folder);
  const store = new ProjectStore(data, undefined, () => pin);
  const project = await store.open(folder);
  assert.deepEqual(await tree(folder), unopened, 'Opening must not rewrite the legacy project.');
  const workspace = new WorkspaceStore(data);
  await workspace.checkpoint(
    project,
    Buffer.from('%PDF-1.4\nOriginal storage fixture'),
    'Original',
  );
  await fs.writeFile(path.join(folder, 'resume.folio'), await workspace.archive(project.id));
  const before = await tree(folder);
  return { root, folder, data, store, project, workspace, before };
}
async function tree(folder: string) {
  return Object.fromEntries(
    await Promise.all(
      (await fs.readdir(folder))
        .sort()
        .map(async (name) => [
          name,
          (await fs.readFile(path.join(folder, name))).toString('base64'),
        ]),
    ),
  );
}

test('folder and ZIP opening reject unsupported manifest versions without rewriting project files', async (t) => {
  const f = await fixture(t);
  for (const schemaVersion of [99, '2', null, 0, 1.5]) {
    const bytes = Buffer.from(
      JSON.stringify({ ...oldManifest, schemaVersion, futureData: { keep: true } }),
    );
    await fs.writeFile(path.join(f.folder, 'resume.project.json'), bytes);
    const before = await tree(f.folder);
    const store = new ProjectStore(path.join(f.root, `invalid-${String(schemaVersion)}`));
    await assert.rejects(store.open(f.folder), /project format.*not supported/);
    assert.deepEqual(await tree(f.folder), before);
    assert.deepEqual(await store.recent(), []);
    assert.throws(
      () =>
        inspectProjectArchive(
          zipSync({
            'main.tex': Buffer.from(source),
            'resume.project.json': bytes,
          }),
          'newer.zip',
        ),
      /project format.*not supported/,
    );
  }
});

test('present manifests must be bounded UTF-8 JSON objects with an explicit supported version', async (t) => {
  const f = await fixture(t);
  const invalid = [
    Buffer.from('null'),
    Buffer.from('[]'),
    Buffer.from('"text"'),
    Buffer.from('{broken'),
    Buffer.from('{}'),
    Buffer.from(JSON.stringify({ ...oldManifest, schemaVersion: undefined })),
    Buffer.from('{"schemaVersion":2,"name":"\ufffd"}'.replace('\ufffd', '\u0000')),
    Buffer.concat([
      Buffer.from('{"schemaVersion":2,"name":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]),
    Buffer.from(JSON.stringify({ ...oldManifest, padding: 'x'.repeat(64 * 1024) })),
  ];
  for (const bytes of invalid) {
    await fs.writeFile(path.join(f.folder, 'resume.project.json'), bytes);
    const before = await tree(f.folder);
    await assert.rejects(new ProjectStore(f.data).open(f.folder), /manifest|project format/);
    assert.deepEqual(await tree(f.folder), before);
    assert.throws(
      () =>
        inspectProjectArchive(
          zipSync({
            'main.tex': Buffer.from(source),
            'resume.project.json': bytes,
          }),
          'invalid.zip',
        ),
      /manifest|project format/,
    );
  }
});

test('legacy project opening is read-only and the first save upgrades metadata with matching history', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await tree(f.folder), f.before);
  const imported = inspectProjectArchive(
    zipSync({
      'main.tex': Buffer.from(source),
      'resume.project.json': Buffer.from(JSON.stringify(oldManifest)),
    }),
    'legacy.zip',
  );
  assert.equal(imported.project.templateId, oldManifest.templateId);
  assert.deepEqual(imported.project.runtime, {
    engine: 'tectonic',
    version: '0.17.0',
    bundle: 'folio-core-v1',
  });
  assert.deepEqual(f.project.runtime, pin);
  assert.equal(f.project.id, oldManifest.id);
  const result = await f.store.save(f.project, undefined, false, (id) => f.workspace.archive(id));
  assert.equal(result.conflict, false);
  const manifest = JSON.parse(
    await fs.readFile(path.join(f.folder, 'resume.project.json'), 'utf8'),
  );
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.id, oldManifest.id);
  assert.equal(manifest.revision, oldManifest.revision);
  assert.deepEqual(manifest.runtime, pin);
  assert.equal(manifest.templateId, oldManifest.templateId);
  assert.equal(manifest.templateVersion, oldManifest.templateVersion);
  assert.equal(await fs.readFile(path.join(f.folder, 'main.tex'), 'utf8'), source);
  const reopened = await new ProjectStore(path.join(f.root, 'fresh'), undefined, () => ({
    ...pin,
    id: 'b'.repeat(64),
  })).open(f.folder);
  assert.deepEqual(reopened.runtime, pin);
  const importedHistory = new WorkspaceStore(path.join(f.root, 'fresh'));
  await importedHistory.importFrom(reopened.id, f.folder);
  assert.equal((await importedHistory.load(reopened.id)).versions.length, 1);
});

test('legacy compiler labels that differ from the included runtime are preserved through upgrade', async (t) => {
  const f = await fixture(t);
  const older = { ...oldManifest, engine: 'tectonic@0.16.0', bundle: 'older-resources' };
  await fs.writeFile(path.join(f.folder, 'resume.project.json'), JSON.stringify(older));
  const store = new ProjectStore(f.data, undefined, () => pin),
    project = await store.open(f.folder);
  const expected = { engine: 'tectonic', version: '0.16.0', bundle: 'older-resources' };
  assert.deepEqual(project.runtime, expected);
  assert.equal((await store.save(project)).conflict, false);
  const manifest = JSON.parse(
    await fs.readFile(path.join(f.folder, 'resume.project.json'), 'utf8'),
  );
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.runtime, expected);
});

async function killAt(f: Awaited<ReturnType<typeof fixture>>, stage: string) {
  const config = path.join(f.root, 'input.json');
  await fs.writeFile(config, JSON.stringify({ pin }));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/project-schema-crash.ts', f.data, f.folder, config, stage],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Schema upgrade did not reach its boundary: ' + stderr));
    }, 15_000);
    child.stdout.on('data', (bytes) => {
      stdout += bytes;
      if (stdout.includes('READY-TO-KILL')) child.kill('SIGKILL');
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (_code, signal) => {
      clearTimeout(timeout);
      if (signal === 'SIGKILL' && stdout.includes('READY-TO-KILL')) resolve();
      else reject(new Error('Schema upgrade exited before interruption: ' + stderr));
    });
  });
}

for (const stage of ['main.tex', 'resume.project.json', 'resume.folio', 'committed', 'rollback']) {
  test(`schema upgrade interrupted at ${stage} reopens a complete old or committed project`, async (t) => {
    const f = await fixture(t);
    await killAt(f, stage === 'rollback' ? 'resume.project.json' : stage);
    if (stage === 'rollback') await killAt(f, 'rollback');
    const store = new ProjectStore(f.data, undefined, () => pin);
    const reopened = await store.open(f.folder);
    const after = await tree(f.folder);
    const manifest = JSON.parse(
      await fs.readFile(path.join(f.folder, 'resume.project.json'), 'utf8'),
    );
    if (stage === 'committed') {
      assert.equal(manifest.schemaVersion, 2);
      assert.deepEqual(manifest.runtime, pin);
      assert.equal(manifest.revision, oldManifest.revision + 1);
      assert.ok(reopened.files.every((file) => file.content.endsWith('\n% Upgraded edit')));
      assert.notEqual(after['resume.folio'], f.before['resume.folio']);
    } else {
      assert.deepEqual(after, f.before);
      assert.equal(manifest.schemaVersion, 1);
      assert.equal(reopened.revision, oldManifest.revision);
    }
    assert.equal(reopened.id, oldManifest.id);
    const fresh = new WorkspaceStore(path.join(f.root, 'history-check'));
    await fresh.importFrom(reopened.id, f.folder);
    const history = await fresh.load(reopened.id);
    assert.equal(history.versions.length, stage === 'committed' ? 2 : 1);
    assert.deepEqual(
      (await fresh.version(reopened.id, history.versions.at(-1)!.id)).files,
      reopened.files,
    );
    assert.equal(await new SaveTransactions(f.data).recover(f.folder), 'none');
    const repeated = await new ProjectStore(f.data, undefined, () => pin).open(f.folder);
    assert.deepEqual(repeated.files, reopened.files);
    assert.deepEqual(await tree(f.folder), after);
  });
}
