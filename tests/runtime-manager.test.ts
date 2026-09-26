import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { zipSync } from 'fflate';
import { RuntimeManager } from '../electron/core/runtime-manager';
import { runtimePin, verifyRuntime, type RuntimeManifest } from '../electron/core/runtime';
import { validateRuntimePin, adoptRuntime } from '../src/shared/runtime';
import { ProjectStore, fingerprint, validateProject } from '../electron/core/project';
import { ProjectImporter } from '../electron/core/project-import';
import { WorkspaceStore } from '../electron/core/workspace';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-runtime-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle'),
    data = path.join(root, 'runtimes');
  await fs.mkdir(bundle);
  const executable = process.platform === 'win32' ? 'tectonic.exe' : 'tectonic';
  await fs.writeFile(path.join(bundle, executable), 'Synthetic engine', { mode: 0o700 });
  await fs.writeFile(path.join(bundle, 'bundle.zip'), 'Resources version one');
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    version: '0.17.0',
    bundle: 'folio-core-v1',
    platform: `${process.platform}-${process.arch}`,
    files: { [executable]: hash('Synthetic engine'), 'bundle.zip': hash('Resources version one') },
  };
  await fs.writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
  const pin = runtimePin(manifest);
  const manager = new RuntimeManager(bundle, data, { probe: async () => {} });
  await manager.initialize();
  const pointer = async () =>
    JSON.parse(await fs.readFile(path.join(data, pin.id!, 'active.json'), 'utf8'));
  const active = async () =>
    path.join(data, pin.id!, 'copies', (await pointer()).generation, 'runtime');
  return { root, bundle, data, executable, manifest, pin, manager, pointer, active };
}

test('runtime identity pins contents, normalizes field order and strictly validates paths and choices', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    runtimePin({
      ...f.manifest,
      files: Object.fromEntries(Object.entries(f.manifest.files).reverse()),
    }),
    f.pin,
  );
  const reordered = {
    platform: f.pin.platform,
    id: f.pin.id,
    bundle: f.pin.bundle,
    engine: 'tectonic' as const,
    version: f.pin.version,
  };
  await verifyRuntime(f.bundle, reordered);
  assert.notEqual(
    runtimePin({ ...f.manifest, files: { ...f.manifest.files, 'bundle.zip': hash('changed') } }).id,
    f.pin.id,
  );
  for (const value of [
    { ...f.pin, id: '../outside' },
    { ...f.pin, platform: '/tmp' },
    { ...f.pin, engine: 'shell' },
    { ...f.pin, biberVersion: 12 },
  ])
    assert.throws(() => validateRuntimePin(value), /invalid/);
  const legacy = { engine: 'tectonic' as const, version: '0.16.0', bundle: 'older' };
  assert.deepEqual(adoptRuntime(legacy, f.pin), legacy);
  assert.deepEqual(
    adoptRuntime({ engine: 'tectonic', version: f.pin.version, bundle: f.pin.bundle }, f.pin),
    f.pin,
  );
  for (const name of ['../outside', '/absolute', 'folder\\escape', 'a/./b']) {
    await fs.writeFile(
      path.join(f.bundle, 'manifest.json'),
      JSON.stringify({ ...f.manifest, files: { ...f.manifest.files, [name]: hash('x') } }),
    );
    await assert.rejects(verifyRuntime(f.bundle), /path/);
  }
});

test('verification refuses symlinks, extra executable resources and modified manifest identities', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.bundle, 'extra.pm'), 'Unexpected executable dependency');
  await assert.rejects(verifyRuntime(f.bundle, f.pin), /Unexpected compiler resource/);
  await fs.unlink(path.join(f.bundle, 'extra.pm'));
  await fs.rename(path.join(f.bundle, 'bundle.zip'), path.join(f.root, 'outside.zip'));
  await fs.symlink(path.join(f.root, 'outside.zip'), path.join(f.bundle, 'bundle.zip'));
  await assert.rejects(verifyRuntime(f.bundle, f.pin), /regular files|links/);
  await fs.unlink(path.join(f.bundle, 'bundle.zip'));
  await fs.rename(path.join(f.root, 'outside.zip'), path.join(f.bundle, 'bundle.zip'));
  await fs.writeFile(
    path.join(f.bundle, 'manifest.json'),
    JSON.stringify({ ...f.manifest, version: '0.18.0' }),
  );
  await assert.rejects(verifyRuntime(f.bundle, f.pin), /does not match/);
});

test('repair verifies and self-tests a replacement before publishing; a failed repair retains the original', async (t) => {
  const f = await fixture(t),
    original = await f.pointer();
  let tested = false;
  const failing = new RuntimeManager(f.bundle, f.data, {
    probe: async (root) => {
      tested = true;
      assert.notEqual(root, await f.active());
      assert.deepEqual(await f.pointer(), original);
      throw new Error('Synthetic offline check failed');
    },
  });
  await assert.rejects(failing.repair(f.pin), /offline check failed/);
  assert.equal(tested, true);
  assert.deepEqual(await f.pointer(), original);
  await verifyRuntime(await f.active(), f.pin);
  assert.equal((await fs.readdir(path.join(f.data, f.pin.id!, 'copies'))).length, 1);
  await fs.writeFile(path.join(await f.active(), 'bundle.zip'), 'Damaged installed resources');
  assert.equal((await f.manager.status(f.pin)).ready, false);
  await f.manager.repair(f.pin);
  assert.notEqual((await f.pointer()).generation, original.generation);
  await verifyRuntime(await f.active(), f.pin);
  assert.equal((await f.pointer()).previous, original.generation);
  const healthy = await f.pointer();
  await fs.writeFile(path.join(f.bundle, f.executable), 'Corrupted installer engine');
  await assert.rejects(f.manager.repair(f.pin), /integrity check/);
  assert.deepEqual(await f.pointer(), healthy);
  await verifyRuntime(await f.active(), f.pin);
});

test('an app update retains the exact old compiler even when version labels are reused', async (t) => {
  const f = await fixture(t),
    oldCopy = await f.active();
  await fs.writeFile(path.join(f.bundle, 'bundle.zip'), 'Resources version two');
  const changed = {
    ...f.manifest,
    files: { ...f.manifest.files, 'bundle.zip': hash('Resources version two') },
  };
  await fs.writeFile(path.join(f.bundle, 'manifest.json'), JSON.stringify(changed));
  const updated = new RuntimeManager(f.bundle, f.data, { probe: async () => {} });
  await updated.initialize();
  assert.notEqual(updated.defaultPin!.id, f.pin.id);
  assert.equal((await updated.status(f.pin)).pin?.id, f.pin.id);
  await verifyRuntime(oldCopy, f.pin);
  const unknown = { ...f.pin, id: 'e'.repeat(64) };
  assert.equal((await updated.status(unknown)).ready, false);
  await assert.rejects(updated.acquire(unknown));
  await assert.rejects(updated.repair(unknown), /No verified copy/);
  const incompatible = { engine: 'tectonic' as const, version: '0.16.0', bundle: 'older-core' };
  assert.equal((await updated.status(incompatible)).ready, false);
  await assert.rejects(updated.acquire(incompatible), /recorded choice has been kept/);
});

test(
  'repair retains leased compiler copies and bounds unreferenced copies',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = await fixture(t),
      lease = await f.manager.acquire(f.pin);
    await f.manager.repair(f.pin);
    await f.manager.repair(f.pin);
    await verifyRuntime(lease.root, f.pin);
    assert.equal((await fs.readdir(path.join(f.data, f.pin.id!, 'copies'))).length, 3);
    await lease.release();
    assert.equal((await fs.readdir(path.join(f.data, f.pin.id!, 'copies'))).length, 2);
    await lease.release();
    await verifyRuntime(await f.active(), f.pin);
  },
);

test('retained copies can repair an old compiler after its installer version is replaced', async (t) => {
  const f = await fixture(t);
  await f.manager.repair(f.pin);
  await fs.writeFile(path.join(await f.active(), f.executable), 'Damaged');
  await fs.writeFile(
    path.join(f.bundle, 'manifest.json'),
    JSON.stringify({ ...f.manifest, version: '0.18.0' }),
  );
  const updated = new RuntimeManager(f.bundle, f.data, { probe: async () => {} });
  await updated.initialize();
  assert.equal((await updated.status(f.pin)).canRepair, true);
  await updated.repair(f.pin);
  await verifyRuntime(await f.active(), f.pin);
});

test('a compiler for another platform cannot be installed or offered as a repair', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.bundle, 'manifest.json'),
    JSON.stringify({
      ...f.manifest,
      platform: `${process.platform}-${process.arch === 'arm64' ? 'x64' : 'arm64'}`,
    }),
  );
  let probed = false;
  const other = new RuntimeManager(f.bundle, path.join(f.root, 'other-platform'), {
    probe: async () => {
      probed = true;
    },
  });
  await other.initialize();
  assert.equal(probed, false);
  const status = await other.status();
  assert.equal(status.ready, false);
  assert.equal(status.canRepair, false);
  assert.deepEqual(status.pin, other.defaultPin);
  await assert.rejects(other.repair(), /different platform/);
  await assert.rejects(other.acquire());
});

test('runtime pins survive source save, recovery, history, Save As and ZIP import without changing legacy fingerprints', async (t) => {
  const f = await fixture(t),
    data = path.join(f.root, 'project-data');
  const project = validateProject({
    id: 'pinned-project',
    name: 'Pinned',
    mainFile: 'main.tex',
    revision: 1,
    runtime: f.pin,
    files: [{ path: 'main.tex', content: 'Source' }],
  });
  const unpinned = { ...project, runtime: undefined };
  assert.equal(fingerprint(unpinned), hash(JSON.stringify([project.mainFile, project.files])));
  assert.notEqual(fingerprint(project), fingerprint(unpinned));
  const store = new ProjectStore(data),
    workspace = new WorkspaceStore(data);
  const folder = path.join(f.root, 'project'),
    copy = path.join(f.root, 'copy');
  await fs.mkdir(folder);
  await fs.mkdir(copy);
  const version = await workspace.checkpoint(project, Buffer.from('%PDF-1.4\nSynthetic'));
  await store.save(project, folder, false, (id) => workspace.archive(project.id, id));
  assert.deepEqual((await store.open(folder)).runtime, f.pin);
  await store.recover(project);
  assert.deepEqual((await new ProjectStore(data).loadRecovery())?.runtime, f.pin);
  assert.deepEqual((await workspace.version(project.id, version.id)).runtime, f.pin);
  await store.save(project, copy, false, (id) => workspace.archive(project.id, id));
  assert.deepEqual((await store.open(copy)).runtime, f.pin);
  const archive = path.join(f.root, 'project.zip');
  await fs.writeFile(
    archive,
    zipSync({
      'main.tex': Buffer.from('Source'),
      'resume.project.json': await fs.readFile(path.join(copy, 'resume.project.json')),
      'resume.folio': await fs.readFile(path.join(copy, 'resume.folio')),
    }),
  );
  const importer = new ProjectImporter(path.join(f.root, 'import-app')),
    preview = await importer.prepare(archive);
  const imported = await importer.finish(preview.token, 'main.tex', f.root);
  assert.deepEqual((await store.open(imported)).runtime, f.pin);
  const changed = { ...f.pin, id: 'a'.repeat(64) };
  const defaulted = new ProjectStore(path.join(f.root, 'new-app'), undefined, () => changed);
  assert.deepEqual((await defaulted.open(folder)).runtime, f.pin);
  await fs.writeFile(path.join(folder, 'resume.project.json'), '{ damaged');
  await assert.rejects(defaulted.open(folder), /manifest could not be read/);
});

test('process interruption at staging, testing and pointer publication preserves an exact recoverable compiler', async (t) => {
  const f = await fixture(t);
  for (const boundary of ['staged', 'tested', 'published']) {
    const before = await f.pointer();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/fixtures/runtime-crash.ts', f.bundle, f.data, boundary],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      error = '';
    child.stderr.on('data', (data) => {
      error += data;
    });
    await new Promise<void>((resolve, reject) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Runtime checkpoint timeout: ' + error));
      }, 15_000);
      child.stdout.on('data', (data) => {
        output += data;
        // A paused fixture must stay alive even when the parent is briefly busy.
        if (output.includes('READY-TO-KILL') && !killTimer)
          killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      });
      child.on('error', reject);
      child.on('exit', (_code, signal) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
        else reject(new Error(`Runtime fixture exited unexpectedly at ${boundary}: ` + error));
      });
    });
    const restarted = new RuntimeManager(f.bundle, f.data, { probe: async () => {} });
    await restarted.initialize();
    const after = await f.pointer();
    if (boundary === 'published') assert.notEqual(after.generation, before.generation);
    else assert.deepEqual(after, before);
    await verifyRuntime(await f.active(), f.pin);
    await restarted.repair(f.pin);
    await verifyRuntime(await f.active(), f.pin);
    assert.equal((await fs.readdir(path.join(f.data, f.pin.id!, 'copies'))).length, 2);
  }
});
