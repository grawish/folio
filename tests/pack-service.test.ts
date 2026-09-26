import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { randomUUID, sign } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { PackService } from '../electron/core/pack-service';
import { RuntimeManager } from '../electron/core/runtime-manager';
import { CATALOG_SIGNATURE_CONTEXT } from '../electron/core/pack-catalog';
import { hash, packFixture } from './fixtures/resource-pack';
import type { PackActivity } from '../src/shared/packs';

const native = process.platform === 'darwin' && process.arch === 'arm64';
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-pack-service-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = await packFixture(root);
  const filename = path.join(root, 'Example pack.foliopack');
  await fs.writeFile(filename, f.built.archive);
  const activity: PackActivity[] = [];
  let manager: RuntimeManager;
  const state = {
    filename: filename as string | undefined,
    sequence: 1,
    starts: 0,
    fetches: 0,
    expired: false,
    badRedirect: false,
    cancelAt: '',
  };
  const catalog = () => {
    const { id, title, description, base, target, packages } = f.pack;
    const payload = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        sequence: state.sequence,
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + (state.expired ? -1000 : 3600_000)).toISOString(),
        packs: [
          {
            id,
            title,
            description,
            base,
            target,
            packages,
            artifact: {
              url: 'https://packs.test/example.foliopack',
              sha256: hash(f.built.archive),
              bytes: f.built.archive.length,
            },
          },
        ],
      }),
    );
    return Buffer.from(
      JSON.stringify({
        keyId: 'fixture',
        payload: payload.toString('base64'),
        signature: sign(
          null,
          Buffer.concat([Buffer.from(CATALOG_SIGNATURE_CONTEXT), payload]),
          f.privateKey,
        ).toString('base64'),
      }),
    );
  };
  const service = new PackService(
    path.join(root, 'packs'),
    {
      keys: { fixture: f.pem },
      hosts: ['packs.test'],
      catalogUrl: 'https://packs.test/catalog.json',
      minimumSequence: 1,
    },
    {
      runtime: {
        status: (pin) => manager.status(pin),
        installPack: (pack, signal, progress) => manager.installPack(pack, signal, progress),
      },
      choose: async () => state.filename,
      start: async () => {
        state.starts++;
      },
      progress: (value) => {
        activity.push(value);
        if (value.phase === state.cancelAt) void service.cancel(value.id);
      },
      fetch: async (input) => {
        state.fetches++;
        if (state.badRedirect)
          return new Response(null, {
            status: 302,
            headers: { location: 'https://untrusted.test/redirect' },
          });
        return new Response(String(input).endsWith('catalog.json') ? catalog() : f.built.archive);
      },
    },
  );
  manager = new RuntimeManager(f.baseRoot, path.join(root, 'managed'), {
    packs: service.archives,
    probe: async () => {},
  });
  await manager.initialize();
  return { ...f, state, service, manager, activity, filename, catalog };
}

test(
  'native pack service reviews immutable signed imports, stages them and exposes only verified installed targets',
  { skip: !native },
  async (t) => {
    const f = await fixture(t);
    const initial = await f.service.list();
    assert.equal(initial.configured, true);
    assert.deepEqual(initial.choices, []);
    await assert.rejects(f.service.target(f.pack.target.id!), /Install and verify/);
    const preview = await f.service.prepareImport(randomUUID());
    assert.ok(preview);
    assert.equal(preview.notices, f.options.notices);
    assert.equal(preview.choice.installed, false);
    await fs.writeFile(f.filename, 'Changed after review.');
    assert.deepEqual((await f.service.list()).choices, []);
    assert.equal(f.state.starts, 0);
    const installed = await f.service.install(randomUUID(), preview.token, 'import');
    assert.equal(installed.choices[0].installed, true);
    assert.equal(installed.choices[0].retained, true);
    assert.deepEqual(await f.service.target(f.pack.target.id!), f.pack.target);
    assert.deepEqual(f.manager.defaultPin, f.base);
    assert.equal(f.state.starts, 1);
    assert.equal(f.state.fetches, 0);
    assert.ok(f.activity.some((item) => item.phase === 'copy'));
    assert.ok(f.activity.some((item) => item.phase === 'check'));
    await assert.rejects(f.service.install(randomUUID(), preview.token, 'import'), /review/);
  },
);

test(
  'catalog refresh and download installation preserve pins and cache clearing preserves retained archives',
  { skip: !native },
  async (t) => {
    const f = await fixture(t);
    const listed = await f.service.refresh(randomUUID());
    assert.equal(listed.choices[0].canDownload, true);
    assert.equal(listed.choices[0].installed, false);
    const installed = await f.service.install(randomUUID(), f.pack.target.id!, 'catalog');
    assert.equal(installed.choices[0].installed, true);
    assert.equal(installed.choices[0].cachedBytes, f.built.archive.length);
    const cleared = await f.service.removeDownload(randomUUID(), f.pack.target.id!);
    assert.equal(cleared.choices[0].cachedBytes, 0);
    assert.equal(cleared.choices[0].retained, true);
    assert.equal(cleared.choices[0].installed, true);
    assert.deepEqual(f.manager.defaultPin, f.base);
    assert.equal(f.state.fetches, 2);
  },
);

test(
  'publisher redirects, expiry and rollback cannot replace the verified saved catalog',
  { skip: !native },
  async (t) => {
    const f = await fixture(t);
    f.state.sequence = 2;
    await f.service.refresh(randomUUID());
    f.state.sequence = 1;
    await assert.rejects(f.service.refresh(randomUUID()), /older/);
    f.state.expired = true;
    await assert.rejects(f.service.refresh(randomUUID()), /expired/);
    f.state.badRedirect = true;
    await assert.rejects(f.service.refresh(randomUUID()), /approved host/);
    assert.equal((await f.service.list()).choices[0].canDownload, true);
    assert.equal(f.service.active, false);
  },
);

test(
  'cancellation waits for installation, preserves its signed archive and allows offline retry',
  { skip: !native },
  async (t) => {
    const f = await fixture(t);
    const preview = await f.service.prepareImport(randomUUID());
    f.state.cancelAt = 'check';
    await assert.rejects(f.service.install(randomUUID(), preview!.token, 'import'), /cancelled/);
    await f.service.cancel();
    assert.equal(f.service.active, false);
    assert.equal((await f.manager.status(f.base)).ready, true);
    const retained = await f.service.list();
    assert.equal(retained.choices[0].retained, true);
    assert.equal(retained.choices[0].installed, false);
    f.state.cancelAt = '';
    const retried = await f.service.install(randomUUID(), f.pack.target.id!, 'retained');
    assert.equal(retried.choices[0].installed, true);
    assert.equal(f.state.fetches, 0);
  },
);

test(
  'review refuses linked/tampered files, forgets cancelled imports and reports damaged retained archives',
  { skip: !native },
  async (t) => {
    const f = await fixture(t);
    const preview = await f.service.prepareImport(randomUUID());
    await f.service.cancel();
    await assert.rejects(f.service.install(randomUUID(), preview!.token, 'import'), /review/);
    const link = path.join(f.root, 'linked.foliopack');
    await fs.symlink(f.filename, link);
    f.state.filename = link;
    await assert.rejects(f.service.prepareImport(randomUUID()));
    f.state.filename = f.filename;
    await fs.writeFile(f.filename, 'Unsigned file');
    await assert.rejects(f.service.prepareImport(randomUUID()));
    await f.service.archives.retain(f.built.archive);
    await fs.writeFile(
      path.join(f.service.archives.root, `${f.pack.target.id}.foliopack`),
      'Tampered retained bytes',
    );
    const damaged = await f.service.list();
    assert.deepEqual(damaged.choices, []);
    assert.equal(damaged.warnings.length, 1);
  },
);

test(
  'an open native picker keeps the service locked until cancellation can finish',
  { skip: !native },
  async (t) => {
    const f = await fixture(t);
    let finish: (path?: string) => void = () => {};
    const service = new PackService(
      path.join(f.root, 'picker'),
      { keys: { fixture: f.pem }, hosts: [], minimumSequence: 1 },
      {
        runtime: f.manager,
        start: async () => {},
        progress: () => {},
        choose: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    );
    const choosing = service.prepareImport(randomUUID());
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => service.requireIdle(), /Finish or cancel/);
    const cancelled = service.cancel();
    assert.equal(service.active, true);
    finish(f.filename);
    await assert.rejects(choosing, /cancelled/);
    await cancelled;
    assert.equal(service.active, false);
    assert.deepEqual((await service.list()).choices, []);
  },
);
