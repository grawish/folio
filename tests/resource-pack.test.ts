import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { sign } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { unzipSync, zipSync } from 'fflate';
import { RuntimeManager } from '../electron/core/runtime-manager';
import { verifyRuntime } from '../electron/core/runtime';
import {
  assembleResourcePack,
  buildResourcePack,
  PACK_SIGNATURE_CONTEXT,
  resourcePackBytes,
  ResourcePackStore,
  ResourcePackVerifier,
} from '../electron/core/resource-pack';
import { CatalogVerifier, CATALOG_SIGNATURE_CONTEXT } from '../electron/core/pack-catalog';
import { hash, packFixture } from './fixtures/resource-pack';

const native = process.platform === 'darwin' && process.arch === 'arm64';
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-pack-install-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return packFixture(root);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

test('retired publisher keys cannot import or repair retained archives', async (t) => {
  const f = await fixture(t);
  const store = new ResourcePackStore(
    path.join(f.root, 'retired'),
    new ResourcePackVerifier({ fixture: f.pem }),
  );
  await store.retain(f.built.archive);
  const retired = new ResourcePackVerifier({ fixture: f.pem }, ['fixture']);
  assert.throws(() => retired.read(f.built.archive), /retired/);
  const reopened = new ResourcePackStore(store.root, retired);
  await assert.rejects(reopened.get(f.pack.target), /retired/);
  const list = await reopened.list();
  assert.equal(list.packs.length, 0);
  assert.equal(list.warnings.length, 1);
});
function envelope(f: Fixture, value: unknown, context = PACK_SIGNATURE_CONTEXT) {
  const payload = Buffer.from(JSON.stringify(value));
  return Buffer.from(
    JSON.stringify({
      keyId: 'fixture',
      payload: payload.toString('base64'),
      signature: sign(null, Buffer.concat([Buffer.from(context), payload]), f.privateKey).toString(
        'base64',
      ),
    }),
  );
}
function modify(f: Fixture, edit: (files: Record<string, Uint8Array>) => void) {
  const files = unzipSync(f.built.archive);
  edit(files);
  return Buffer.from(zipSync(files));
}
function pointer(data: string, id: string) {
  return fs.readFile(path.join(data, id, 'active.json'), 'utf8').then(JSON.parse);
}

test('publisher and offline assembly produce the same identity across time zones and protect authenticated bytes', async (t) => {
  const f = await fixture(t);
  const recipe = path.join(f.root, 'recipe.json');
  const { id, title, description, bundle, packages, keyId } = f.options;
  await fs.writeFile(recipe, JSON.stringify({ id, title, description, bundle, packages, keyId }));
  await fs.mkdir(path.join(f.root, 'resources'));
  await fs.writeFile(
    path.join(f.root, 'resources/folio-check.sty'),
    f.options.resources.get('folio-check.sty')!,
  );
  await fs.writeFile(path.join(f.root, 'NOTICES.txt'), f.options.notices);
  await fs.writeFile(path.join(f.root, 'probe.tex'), f.options.probe);
  const key = path.join(f.root, 'private.pem');
  await fs.writeFile(key, f.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  for (const [index, TZ] of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles'].entries()) {
    const output = path.join(f.root, `${index}.foliopack`);
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'scripts/build-resource-pack.ts', recipe, f.baseRoot, key, output],
      { env: { ...process.env, TZ } },
    );
    assert.deepEqual(await fs.readFile(output), f.built.archive);
  }
  const first = await assembleResourcePack(f.pack, f.baseRoot);
  assert.equal(first.manifest.files.tectonic, f.manifest.files.tectonic);
  assert.deepEqual(first.pin, f.pack.target);
  first.overrides.get('bundle.zip')!.fill(0);
  resourcePackBytes(f.pack).fill(0);
  assert.throws(() => {
    Object.assign(f.pack.target, { id: 'f'.repeat(64) });
  }, TypeError);
  assert.deepEqual((await assembleResourcePack(f.pack, f.baseRoot)).pin, f.built.target);
  await assert.rejects(
    assembleResourcePack(JSON.parse(JSON.stringify(f.pack)), f.baseRoot),
    /authenticated/,
  );
});

test('offline archives reject wrong keys, contexts, file tampering, extra files and unsupported resources', async (t) => {
  const f = await fixture(t);
  assert.throws(() => new ResourcePackVerifier({}).read(f.built.archive), /trusted/);
  for (const bytes of [
    modify(f, (files) => {
      files['metadata.json'] = envelope(f, f.built.description, CATALOG_SIGNATURE_CONTEXT);
    }),
    modify(f, (files) => {
      files['resources/folio-check.sty'] = Buffer.from('Tampered');
    }),
    modify(f, (files) => {
      files['NOTICES.txt'] = Buffer.from('Tampered');
    }),
    modify(f, (files) => {
      files['probe.tex'] = Buffer.from('Tampered');
    }),
    modify(f, (files) => {
      files['unexpected'] = Buffer.from('Extra');
    }),
    modify(f, (files) => {
      delete files['probe.tex'];
    }),
    modify(f, (files) => {
      files['resources/FOLIO-CHECK.sty'] = Buffer.from('Collision');
    }),
    modify(f, (files) => {
      files['../escape'] = Buffer.from('Traversal');
    }),
  ])
    assert.throws(() => f.verifier.read(bytes));
  await assert.rejects(
    buildResourcePack({
      ...f.options,
      packages: ['native.dylib'],
      resources: new Map([['native.dylib', Buffer.from('Bad')]]),
    }),
    /unsupported/,
  );
  await assert.rejects(buildResourcePack({ ...f.options, notices: '\0' }), /UTF-8/);
  await assert.rejects(
    buildResourcePack({
      ...f.options,
      resources: new Map([['folio-check.sty', Buffer.alloc(20 * 1024 * 1024 + 1)]]),
    }),
    /bounds/,
  );
});

test('catalog size, digest and descriptive metadata must match the authenticated offline archive', async (t) => {
  const f = await fixture(t);
  const { id, title, description, base, target, packages } = f.pack;
  const entry = {
    id,
    title,
    description,
    base,
    target,
    packages,
    artifact: {
      url: 'https://packs.test/check.foliopack',
      bytes: f.built.archive.length,
      sha256: hash(f.built.archive),
    },
  };
  const now = Date.now();
  const catalog = (pack = entry) =>
    new CatalogVerifier({ fixture: f.pem }, ['packs.test']).verify(
      envelope(
        f,
        {
          schemaVersion: 1,
          sequence: 1,
          issuedAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 3600_000).toISOString(),
          packs: [pack],
        },
        CATALOG_SIGNATURE_CONTEXT,
      ),
    ).packs[0];
  assert.deepEqual(f.verifier.read(f.built.archive, catalog()).target, f.pack.target);
  assert.throws(
    () => f.verifier.read(f.built.archive, catalog({ ...entry, title: 'Different' })),
    /metadata/,
  );
  assert.throws(
    () =>
      f.verifier.read(
        f.built.archive,
        catalog({ ...entry, artifact: { ...entry.artifact, sha256: 'f'.repeat(64) } }),
      ),
    /download/,
  );
  assert.throws(
    () => f.verifier.read(f.built.archive, JSON.parse(JSON.stringify(catalog()))),
    /verified catalog/,
  );
});

test('assembly rejects wrong target identities, changed bases, changed notices and case replacements', async (t) => {
  const f = await fixture(t);
  const wrong = modify(f, (files) => {
    files['metadata.json'] = envelope(f, {
      ...f.built.description,
      target: { ...f.pack.target, id: 'f'.repeat(64) },
    });
  });
  await assert.rejects(
    assembleResourcePack(f.verifier.read(wrong), f.baseRoot),
    /signed resource-pack identity/,
  );
  await assert.rejects(
    buildResourcePack({
      ...f.options,
      packages: ['Article.cls'],
      resources: new Map([['Article.cls', Buffer.from('Case changed')]]),
    }),
    /case/,
  );
  await fs.writeFile(path.join(f.baseRoot, 'THIRD_PARTY_NOTICES.md'), 'Changed base notice.');
  await assert.rejects(assembleResourcePack(f.pack, f.baseRoot), /signed resource-pack identity/);
  await fs.writeFile(path.join(f.baseRoot, 'tectonic'), 'Changed executable.');
  await assert.rejects(assembleResourcePack(f.pack, f.baseRoot), /integrity check/);
});

test('retained archives are authenticated again and must match the requested complete pin', async (t) => {
  const f = await fixture(t);
  const store = new ResourcePackStore(path.join(f.root, 'retained'), f.verifier);
  const input = Buffer.from(f.built.archive);
  const retained = store.retain(input);
  input.fill(0);
  assert.deepEqual((await retained).target, f.pack.target);
  assert.deepEqual((await store.get(f.pack.target))?.target, f.pack.target);
  await assert.rejects(
    store.get({ ...f.pack.target, bundle: 'different-label' }),
    /different compiler identity/,
  );
  await fs.writeFile(path.join(store.root, `${f.pack.target.id}.foliopack`), 'Tampered');
  await assert.rejects(store.get(f.pack.target));
});

test(
  'staged pack installation preserves base, native bytes, default selection and leased prior copies',
  { skip: !native },
  async (t) => {
    const f = await fixture(t),
      data = path.join(f.root, 'runtimes');
    let checks = 0;
    const manager = new RuntimeManager(f.baseRoot, data, {
      probe: async (root, pin) => {
        await verifyRuntime(root, pin);
        if (pin.id === f.pack.target.id) {
          checks++;
          assert.equal(
            await fs.readFile(path.join(root, 'pack-check.tex'), 'utf8'),
            f.options.probe,
          );
        }
      },
    });
    await manager.initialize();
    const before = await pointer(data, f.base.id!);
    assert.equal((await manager.installPack(f.pack)).ready, true);
    const lease = await manager.acquire(f.pack.target);
    await manager.installPack(f.pack);
    await manager.installPack(f.pack);
    assert.equal(checks, 3);
    assert.deepEqual(manager.defaultPin, f.base);
    assert.deepEqual(await pointer(data, f.base.id!), before);
    assert.equal(
      await fs.readFile(path.join(lease.root, 'tectonic'), 'utf8'),
      'Synthetic engine; never execute.',
    );
    assert.equal((await fs.readdir(path.join(data, f.pack.target.id!, 'copies'))).length, 3);
    await lease.release();
    assert.equal((await fs.readdir(path.join(data, f.pack.target.id!, 'copies'))).length, 2);
    await assert.rejects(manager.installPack(JSON.parse(JSON.stringify(f.pack))), /authenticated/);
  },
);

test(
  'failed checks, cancellation before publication and corrupt staging never replace the active copy',
  { skip: !native },
  async (t) => {
    const f = await fixture(t),
      data = path.join(f.root, 'runtimes');
    const manager = new RuntimeManager(f.baseRoot, data, { probe: async () => {} });
    await manager.installPack(f.pack);
    const before = await pointer(data, f.pack.target.id!);
    const failing = new RuntimeManager(f.baseRoot, data, {
      probe: async () => {
        throw new Error('Pack self-test failed');
      },
    });
    await assert.rejects(failing.installPack(f.pack), /self-test failed/);
    const abort = new AbortController();
    const cancelled = new RuntimeManager(f.baseRoot, data, {
      probe: async () => {},
      checkpoint: async (phase) => {
        if (phase === 'tested') abort.abort(new Error('Installation cancelled'));
      },
    });
    await assert.rejects(cancelled.installPack(f.pack, abort.signal), /cancelled/);
    let probed = false;
    const corrupted = new RuntimeManager(f.baseRoot, data, {
      probe: async () => {
        probed = true;
      },
      checkpoint: async (phase) => {
        if (phase !== 'staged') return;
        const copies = path.join(data, f.pack.target.id!, 'copies');
        const next = (await fs.readdir(copies)).find((name) => name !== before.generation)!;
        await fs.writeFile(path.join(copies, next, 'runtime/tectonic'), 'Changed during copy.');
      },
    });
    await assert.rejects(corrupted.installPack(f.pack), /integrity check/);
    assert.equal(probed, false);
    assert.deepEqual(await pointer(data, f.pack.target.id!), before);
    assert.equal((await manager.status(f.pack.target)).ready, true);
    assert.equal((await fs.readdir(path.join(data, f.pack.target.id!, 'copies'))).length, 1);
  },
);

test(
  'exact repair rebuilds from a signed retained archive and refuses damaged archives or missing bases',
  { skip: !native },
  async (t) => {
    const f = await fixture(t),
      data = path.join(f.root, 'runtimes');
    const packs = new ResourcePackStore(path.join(f.root, 'retained'), f.verifier);
    await packs.retain(f.built.archive);
    const manager = new RuntimeManager(f.baseRoot, data, { probe: async () => {}, packs });
    await manager.installPack(f.pack);
    const before = await pointer(data, f.pack.target.id!);
    await fs.writeFile(
      path.join(data, f.pack.target.id!, 'copies', before.generation, 'runtime/bundle.zip'),
      'Damaged',
    );
    const damaged = await manager.status(f.pack.target);
    assert.equal(damaged.ready, false);
    assert.equal(damaged.canRepair, true);
    const archivePath = path.join(packs.root, `${f.pack.target.id}.foliopack`);
    await fs.writeFile(archivePath, 'Invalid');
    assert.equal((await manager.status(f.pack.target)).canRepair, false);
    await assert.rejects(manager.repair(f.pack.target));
    assert.deepEqual(await pointer(data, f.pack.target.id!), before);
    await packs.retain(f.built.archive);
    const repaired = await manager.repair(f.pack.target);
    assert.equal(repaired.ready, true);
    assert.deepEqual(repaired.pin, f.pack.target);
    assert.deepEqual(manager.defaultPin, f.base);
    const absent = modify(f, (files) => {
      files['metadata.json'] = envelope(f, {
        ...f.built.description,
        base: { ...f.base, id: 'f'.repeat(64) },
      });
    });
    await assert.rejects(manager.installPack(f.verifier.read(absent)), /exact base compiler/);
  },
);

test(
  'a failure reported after pointer publication preserves the now-active verified runtime',
  { skip: !native },
  async (t) => {
    const f = await fixture(t),
      data = path.join(f.root, 'runtimes');
    await new RuntimeManager(f.baseRoot, data, { probe: async () => {} }).initialize();
    const manager = new RuntimeManager(f.baseRoot, data, {
      probe: async () => {},
      checkpoint: async (phase) => {
        if (phase === 'published') throw new Error('Post-publication failure');
      },
    });
    await assert.rejects(manager.installPack(f.pack), /Post-publication/);
    assert.equal((await manager.status(f.pack.target)).ready, true);
    assert.equal((await manager.status(f.base)).ready, true);
  },
);

test(
  'pre-cancelled installation and linked managed ancestors cannot create staged copies',
  { skip: !native },
  async (t) => {
    const f = await fixture(t);
    const cancelledRoot = path.join(f.root, 'cancelled');
    const aborted = new AbortController();
    aborted.abort(new Error('Already cancelled'));
    const manager = new RuntimeManager(f.baseRoot, cancelledRoot, { probe: async () => {} });
    await assert.rejects(manager.installPack(f.pack, aborted.signal), /Already cancelled/);
    await assert.rejects(fs.lstat(cancelledRoot), { code: 'ENOENT' });
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    const linked = path.join(f.root, 'linked');
    await fs.symlink(outside, linked);
    const unsafe = new RuntimeManager(f.baseRoot, path.join(linked, 'managed'), {
      probe: async () => {
        throw new Error('Must not execute');
      },
    });
    await assert.rejects(unsafe.installPack(f.pack), /linked folders/);
    assert.deepEqual(await fs.readdir(outside), []);
  },
);

test(
  'real process kills at staged, tested and published boundaries leave usable compilers and allow retry',
  { skip: !native, timeout: 60_000 },
  async (t) => {
    const f = await fixture(t),
      data = path.join(f.root, 'runtimes');
    const manager = new RuntimeManager(f.baseRoot, data, { probe: async () => {} });
    await manager.installPack(f.pack);
    const archive = path.join(f.root, 'example.foliopack'),
      key = path.join(f.root, 'public.pem');
    await fs.writeFile(archive, f.built.archive);
    await fs.writeFile(key, f.pem);
    for (const boundary of ['staged', 'tested', 'published']) {
      const before = await pointer(data, f.pack.target.id!);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            'tests/fixtures/resource-pack-crash.ts',
            f.baseRoot,
            data,
            archive,
            key,
            boundary,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '',
          errors = '',
          killTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Checkpoint ${boundary} timed out: ${errors}`));
        }, 15_000);
        child.stdout.on('data', (bytes) => {
          output += bytes;
          if (output.includes('READY-TO-KILL') && !killTimer)
            killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
        });
        child.stderr.on('data', (bytes) => {
          errors += bytes;
        });
        child.on('error', reject);
        child.on('exit', (_code, signal) => {
          clearTimeout(timeout);
          clearTimeout(killTimer);
          if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
          else reject(new Error(`Unexpected exit at ${boundary}: ${errors}`));
        });
      });
      const restarted = new RuntimeManager(f.baseRoot, data, { probe: async () => {} });
      const after = await pointer(data, f.pack.target.id!);
      if (boundary === 'published') assert.notEqual(after.generation, before.generation);
      else assert.deepEqual(after, before);
      assert.equal((await restarted.status(f.base)).ready, true);
      assert.equal((await restarted.status(f.pack.target)).ready, true);
      await restarted.installPack(f.pack);
      assert.equal((await fs.readdir(path.join(data, f.pack.target.id!, 'copies'))).length, 2);
    }
  },
);
