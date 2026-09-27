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
import { compilerStorageTree, compilerInstallationBudget } from '../electron/core/compiler-storage';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext, extraFiles: Record<string, string> = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-runtime-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle'),
    data = path.join(root, 'runtimes');
  await fs.mkdir(bundle);
  const executable = process.platform === 'win32' ? 'tectonic.exe' : 'tectonic';
  await fs.writeFile(path.join(bundle, executable), 'Synthetic engine', { mode: 0o700 });
  await fs.writeFile(path.join(bundle, 'bundle.zip'), 'Resources version one');
  for (const [name, content] of Object.entries(extraFiles)) {
    await fs.mkdir(path.dirname(path.join(bundle, name)), { recursive: true });
    await fs.writeFile(path.join(bundle, name), content);
  }
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    version: '0.17.0',
    bundle: 'folio-core-v1',
    platform: `${process.platform}-${process.arch}`,
    files: {
      [executable]: hash('Synthetic engine'),
      'bundle.zip': hash('Resources version one'),
      ...Object.fromEntries(
        Object.entries(extraFiles).map(([name, content]) => [name, hash(content)]),
      ),
    },
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

const nestedResources = {
  'extras/deep/a.txt': 'First nested resource',
  'extras/deep/b.txt': 'Second nested resource',
  'extras/sibling/c.txt': 'Sibling resource',
};

test('recovery gets its exact compiler identity while preparation is still blocked, but execution waits for verification', async (t) => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.after(() => release());
  const manager = new RuntimeManager(f.bundle, path.join(f.root, 'fresh-runtime'), {
    probe: async () => {
      entered();
      await held;
    },
  });
  const startup = await manager.startupStatus();
  assert.equal(startup.ready, false);
  assert.equal(startup.preparing, true);
  assert.equal(startup.canRepair, false);
  assert.deepEqual(startup.pin, f.pin);
  const store = new ProjectStore(
    path.join(f.root, 'early-workspace'),
    undefined,
    () => manager.defaultPin,
  );
  const project = {
    id: 'early-project',
    name: 'Recovered draft',
    revision: 2,
    mainFile: 'main.tex',
    files: [{ path: 'main.tex', content: 'Keep my early edits' }],
  };
  await store.recover(project);
  const recovered = await store.loadRecovery();
  assert.deepEqual(recovered?.files, project.files);
  assert.deepEqual(recovered?.runtime, f.pin);
  await probing;
  let acquired = false;
  const lease = manager.acquire(f.pin).then((value) => {
    acquired = true;
    return value;
  });
  const recorded = { ...f.pin, id: 'a'.repeat(64) };
  assert.deepEqual((await manager.startupStatus(recorded)).pin, recorded);
  assert.equal(acquired, false);
  release();
  const ready = await lease;
  assert.equal(ready.status.ready, true);
  await ready.release();
  assert.equal((await manager.status(f.pin)).ready, true);
});

test('failed background preparation never reports readiness or replaces a recorded compiler choice', async (t) => {
  const f = await fixture(t);
  const manager = new RuntimeManager(f.bundle, path.join(f.root, 'failed-runtime'), {
    probe: async () => {
      throw new Error('Offline preparation failed');
    },
  });
  const startup = await manager.startupStatus();
  assert.deepEqual(startup.pin, f.pin);
  const status = await manager.status();
  assert.equal(status.ready, false);
  assert.equal(status.preparing, undefined);
  assert.match(status.message, /Offline preparation failed/);
  await assert.rejects(manager.acquire());
  await fs.writeFile(path.join(f.bundle, 'manifest.json'), 'Damaged manifest');
  const invalid = new RuntimeManager(f.bundle, path.join(f.root, 'invalid-runtime'));
  const recorded = (await invalid.startupStatus(f.pin)).pin;
  assert.deepEqual(recorded, f.pin);
  assert.equal((await invalid.status(f.pin)).ready, false);
});

test('staging flushes every file and nested directory before readiness, with one bottom-up directory pass', async (t) => {
  const f = await fixture(t, nestedResources);
  const events: { name: string; directory: boolean }[] = [];
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      if (typeof args[0] === 'string' && args[0].startsWith(f.data + path.sep))
        events.push({ name: args[0], directory: (await handle.stat()).isDirectory() });
    };
    return handle;
  });
  const before = await f.pointer();
  let checked = false;
  const manager = new RuntimeManager(f.bundle, f.data, {
    probe: async (runtime) => {
      checked = true;
      assert.deepEqual(await f.pointer(), before);
      await assert.rejects(fs.access(path.join(path.dirname(runtime), 'ready.json')));
      const inside = events.filter(
        (e) => e.name === runtime || e.name.startsWith(runtime + path.sep),
      );
      const directories = inside.filter((e) => e.directory).map((e) => e.name);
      const expected = ['', 'extras', 'extras/deep', 'extras/sibling'].map((name) =>
        path.join(runtime, name),
      );
      assert.deepEqual([...directories].sort(), expected.sort());
      assert.equal(
        inside.filter((e) => !e.directory).length,
        Object.keys(f.manifest.files).length + 1,
      );
      const firstDirectory = inside.findIndex((e) => e.directory);
      assert.ok(inside.every((event, index) => event.directory || index < firstDirectory));
      for (const name of directories.filter((name) => name !== runtime))
        assert.ok(directories.indexOf(name) < directories.indexOf(path.dirname(name)));
      await verifyRuntime(runtime, f.pin);
    },
  });
  await manager.repair(f.pin);
  assert.equal(checked, true);
  assert.notEqual((await f.pointer()).generation, before.generation);
  await verifyRuntime(await f.active(), f.pin);
});

test('a failed staged directory flush cannot publish readiness or replace the active compiler', async (t) => {
  const f = await fixture(t, nestedResources),
    before = await f.pointer();
  let failurePath = '',
    failures = 0,
    probes = 0;
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args),
      sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (
        typeof args[0] === 'string' &&
        args[0].startsWith(f.data + path.sep) &&
        args[0].endsWith(path.join('runtime', failurePath)) &&
        (await handle.stat()).isDirectory()
      ) {
        failures++;
        throw new Error('Injected staged directory flush failure');
      }
      await sync();
    };
    return handle;
  });
  const manager = new RuntimeManager(f.bundle, f.data, {
    probe: async () => {
      probes++;
    },
  });
  for (failurePath of ['extras/deep', 'extras', '']) {
    await assert.rejects(manager.repair(f.pin), /staged directory flush failure/);
    assert.deepEqual(await f.pointer(), before);
    await verifyRuntime(await f.active(), f.pin);
    assert.deepEqual(await fs.readdir(path.join(f.data, f.pin.id!, 'copies')), [before.generation]);
  }
  assert.equal(failures, 3);
  assert.equal(probes, 0);
});

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

test('process interruption before directory flush, after staging, testing and pointer publication preserves an exact recoverable compiler', async (t) => {
  const f = await fixture(t);
  for (const boundary of ['copied', 'staged', 'tested', 'published']) {
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

async function updatedFixture(t: TestContext) {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.bundle, 'manifest.json'),
    JSON.stringify({ ...f.manifest, version: '0.18.0' }),
  );
  const manager = new RuntimeManager(f.bundle, f.data, { probe: async () => {} });
  await manager.initialize();
  const entry = async () =>
    (await manager.storage()).entries.find((entry) => entry.key === f.pin.id)!;
  return { ...f, updated: manager, entry };
}

test('compiler storage totals include self-test/unknown data; protected and leased identities cannot be removed', async (t) => {
  const f = await updatedFixture(t);
  await fs.mkdir(path.join(f.data, 'self-test'));
  await fs.writeFile(path.join(f.data, 'self-test', 'retained'), 'check');
  await fs.writeFile(path.join(f.data, 'keep.txt'), 'Unrecognized data');
  const storage = await f.updated.storage(f.pin);
  assert.equal(storage.bytes, (await compilerStorageTree(f.data)).bytes);
  assert.equal(storage.installationBudgetBytes, compilerInstallationBudget);
  assert.equal(storage.entries.length, 2);
  const included = storage.entries.find((entry) => entry.key === f.updated.defaultPin!.id)!;
  await assert.rejects(f.updated.removeStoredCompiler(included.key, included.token), /Included/);
  const old = await f.entry();
  await assert.rejects(
    f.updated.removeStoredCompiler(old.key, old.token, f.pin),
    /current project/,
  );
  if (process.platform === 'darwin') {
    const lease = await f.updated.acquire(f.pin);
    try {
      await assert.rejects(f.updated.removeStoredCompiler(old.key, old.token), /PDF build/);
    } finally {
      await lease.release();
    }
  }
  await verifyRuntime(await f.active(), f.pin);
  assert.equal(await fs.readFile(path.join(f.data, 'keep.txt'), 'utf8'), 'Unrecognized data');
});

test('reviewed removal deletes only an old identity and preserves saved project pins, source and the included compiler', async (t) => {
  const f = await updatedFixture(t);
  const projectRoot = path.join(f.root, 'project');
  const store = new ProjectStore(path.join(f.root, 'project-data'));
  const project = {
    id: 'old-project',
    name: 'Old resume',
    revision: 1,
    mainFile: 'main.tex',
    runtime: f.pin,
    files: [{ path: 'main.tex', content: 'Keep this source' }],
  };
  await fs.mkdir(projectRoot);
  await store.save(project, projectRoot, false);
  const before = await fs.readFile(path.join(projectRoot, 'resume.project.json'));
  const old = await f.entry();
  await f.updated.removeStoredCompiler(old.key, old.token);
  await assert.rejects(fs.access(path.join(f.data, old.key)));
  await assert.rejects(f.updated.removeStoredCompiler(old.key, old.token), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.data, old.key)));
  assert.deepEqual(await fs.readFile(path.join(projectRoot, 'resume.project.json')), before);
  assert.equal(await fs.readFile(path.join(projectRoot, 'main.tex'), 'utf8'), 'Keep this source');
  assert.equal((await f.updated.status()).ready, process.platform === 'darwin');
  const absent = await f.updated.status(f.pin);
  assert.equal(absent.ready, false);
  assert.deepEqual(absent.pin, f.pin);
  assert.match(absent.message, /matching Folio version/);
});

test('stale reviews, unknown files, traversal, links and replaced identities cannot remove compiler storage', async (t) => {
  const f = await updatedFixture(t),
    old = await f.entry();
  await fs.writeFile(path.join(await f.active(), 'bundle.zip'), 'Changed after review');
  await assert.rejects(f.updated.removeStoredCompiler(old.key, old.token), /changed/);
  await fs.writeFile(path.join(f.data, old.key, 'notes.txt'), 'Keep unknown file');
  const unknown = await f.entry();
  assert.match(unknown.protectedReason!, /Unrecognized/);
  await assert.rejects(f.updated.removeStoredCompiler(old.key, unknown.token), /Unrecognized/);
  await assert.rejects(
    f.updated.removeStoredCompiler('../outside', old.token),
    /fresh storage review/,
  );
  await fs.unlink(path.join(f.data, old.key, 'notes.txt'));
  const outside = path.join(f.root, 'outside');
  await fs.writeFile(outside, 'Keep outside');
  const resource = path.join(await f.active(), 'bundle.zip');
  await fs.unlink(resource);
  await fs.symlink(outside, resource);
  await assert.rejects(f.updated.storage(), /link or special/);
  await assert.rejects(f.updated.removeStoredCompiler(old.key, old.token), /link or special/);
  await fs.unlink(resource);
  await fs.link(outside, resource);
  await assert.rejects(f.updated.removeStoredCompiler(old.key, old.token), /link or special/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'Keep outside');
});

test('an interrupted removal remains reviewable after restart; newly added files are not swept into deletion', async (t) => {
  const f = await updatedFixture(t),
    old = await f.entry();
  const unlink = fs.unlink.bind(fs);
  let injected = false;
  const mock = t.mock.method(fs, 'unlink', async (name: Parameters<typeof fs.unlink>[0]) => {
    if (!injected && typeof name === 'string' && name.includes('/removing-')) {
      injected = true;
      const target = name.slice(0, name.indexOf('/copies/'));
      await fs.writeFile(path.join(target, 'new-after-review.txt'), 'Preserve new file');
    }
    return unlink(name);
  });
  await assert.rejects(f.updated.removeStoredCompiler(old.key, old.token), /removal stopped/);
  mock.mock.restore();
  const restarted = new RuntimeManager(f.bundle, f.data, { probe: async () => {} });
  const remaining = (await restarted.storage()).entries.find((entry) => entry.unfinishedRemoval)!;
  assert.ok(remaining);
  assert.equal(
    await fs.readFile(path.join(f.data, remaining.key, 'new-after-review.txt'), 'utf8'),
    'Preserve new file',
  );
  assert.equal((await restarted.status()).ready, process.platform === 'darwin');
  await restarted.removeStoredCompiler(remaining.key, remaining.token);
  assert.equal(
    (await restarted.storage()).entries.some((entry) => entry.unfinishedRemoval),
    false,
  );
});

test('admission refuses low space and an over-budget compiler copy before writes or pointer replacement', async (t) => {
  const f = await fixture(t),
    before = await f.pointer();
  const statfs = t.mock.method(fs, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }));
  await assert.rejects(f.manager.repair(f.pin), /Not enough free disk space/);
  assert.deepEqual(await f.pointer(), before);
  assert.deepEqual(await fs.readdir(path.join(f.data, f.pin.id!, 'copies')), [before.generation]);
  statfs.mock.restore();
  // A sparse fixture exercises logical-byte admission without filling the disk.
  const sparse = await fs.open(path.join(f.data, 'budget-fixture'), 'wx');
  try {
    await sparse.truncate(compilerInstallationBudget);
  } finally {
    await sparse.close();
  }
  await assert.rejects(f.manager.repair(f.pin), /16 GiB installation budget/);
  assert.deepEqual(await f.pointer(), before);
  await fs.unlink(path.join(f.data, 'budget-fixture'));
  await f.manager.repair(f.pin);
  await verifyRuntime(await f.active(), f.pin);
});

test('killing the remover after a real unlink leaves a reviewable remainder and a usable included compiler', async (t) => {
  const f = await updatedFixture(t);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/runtime-storage-crash.ts', f.bundle, f.data, f.pin.id!],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    errors = '';
  child.stderr.on('data', (data) => {
    errors += data;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Removal checkpoint timeout: ' + errors));
    }, 15_000);
    child.stdout.on('data', (data) => {
      output += data;
      if (output.includes('READY-TO-KILL')) child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (_code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
      else reject(new Error(errors));
    });
  });
  const restarted = new RuntimeManager(f.bundle, f.data, { probe: async () => {} });
  const remainder = (await restarted.storage()).entries.find((entry) => entry.unfinishedRemoval)!;
  assert.ok(remainder);
  assert.equal((await restarted.status()).ready, process.platform === 'darwin');
  await restarted.removeStoredCompiler(remainder.key, remainder.token);
  assert.equal((await restarted.storage()).entries.length, 1);
});
