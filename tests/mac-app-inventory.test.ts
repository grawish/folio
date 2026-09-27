import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  inventoryBundle,
  bundleBom,
  validateBundleBom,
  jsonBytes,
  sha256,
} from '../scripts/mac-app-inventory';

async function fixture(t: TestContext) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-app-inventory-'));
  const root = await fs.realpath(folder);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'Folio.app');
  await fs.mkdir(path.join(app, 'Contents/Framework/Versions/A'), { recursive: true });
  await fs.writeFile(
    path.join(app, 'Contents/Framework/Versions/A/Engine'),
    Buffer.from([0, 1, 255]),
  );
  await fs.symlink('A', path.join(app, 'Contents/Framework/Versions/Current'));
  await fs.writeFile(path.join(app, 'Contents/notice.txt'), 'Synthetic notice\n');
  return { root, app };
}

test('physical app inventory is repeatable and records exact file bytes, modes and internal links', async (t) => {
  const { app } = await fixture(t);
  const first = await inventoryBundle(app);
  assert.deepEqual(await inventoryBundle(app), first);
  assert.equal(first.regularFiles, 2);
  assert.equal(first.symlinks, 1);
  assert.equal(first.logicalFileBytes, 3 + Buffer.byteLength('Synthetic notice\n'));
  assert.equal(
    first.entries.find((x) => x.path.endsWith('/Engine'))?.sha256,
    sha256(Buffer.from([0, 1, 255])),
  );
  assert.equal(
    first.entries.find((x) => x.kind === 'symlink')?.resolvedTarget,
    'Contents/Framework/Versions/A',
  );
  const original = sha256(jsonBytes(first));
  await fs.writeFile(path.join(app, 'Contents/notice.txt'), 'Different bytes!\n');
  assert.notEqual(sha256(jsonBytes(await inventoryBundle(app))), original);
  const beforeMode = await inventoryBundle(app);
  await fs.chmod(path.join(app, 'Contents/notice.txt'), 0o700);
  assert.notDeepEqual(await inventoryBundle(app), beforeMode);
});

test('escaping, absolute and broken links are rejected rather than followed into the inventory', async (t) => {
  const { root, app } = await fixture(t);
  const link = path.join(app, 'outside');
  await fs.writeFile(path.join(root, 'private.txt'), 'Outside content');
  await fs.symlink('../private.txt', link);
  await assert.rejects(inventoryBundle(app), /escapes its bundle/);
  await fs.unlink(link);
  await fs.symlink(path.join(root, 'private.txt'), link);
  await assert.rejects(inventoryBundle(app), /absolute symbolic link/);
  await fs.unlink(link);
  await fs.symlink('missing', link);
  await assert.rejects(inventoryBundle(app), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, 'private.txt'), 'utf8'), 'Outside content');
});

test('special files fail without opening or waiting on them', async (t) => {
  const { app } = await fixture(t);
  execFileSync('/usr/bin/mkfifo', [path.join(app, 'pipe')]);
  await assert.rejects(inventoryBundle(app), /special file/);
});

test('a tree changed during traversal is rejected instead of receiving a successful inventory', async (t) => {
  const { app } = await fixture(t);
  const read = fs.readdir.bind(fs);
  let changed = false;
  t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    const result = await read(...args);
    if (!changed && String(args[0]) === app) {
      changed = true;
      await fs.writeFile(path.join(app, 'added-during-read'), 'New file');
    }
    return result;
  });
  await assert.rejects(inventoryBundle(app), /tree changed during inventory/);
});

test('CycloneDX output links its physical inventory, declares incomplete composition, and validates offline', async (t) => {
  const { app } = await fixture(t);
  const inventory = await inventoryBundle(app);
  const bom = bundleBom(inventory, 'Synthetic Folio', '1.0.0');
  await validateBundleBom(bom);
  assert.equal(
    bom.metadata.component.components.length,
    inventory.regularFiles + inventory.symlinks,
  );
  assert.equal(new Set(bom.metadata.component.components.map((x) => x['bom-ref'])).size, 3);
  assert.equal(bom.compositions[0].aggregate, 'incomplete');
  assert.equal(bom.metadata.component.properties[0].value, sha256(jsonBytes(inventory)));
  const corrupted = structuredClone(bom);
  corrupted.metadata.component.components.find((x) => x.hashes)!.hashes![0].content = 'not-a-hash';
  await assert.rejects(validateBundleBom(corrupted), /Invalid CycloneDX/);
  await assert.rejects(
    validateBundleBom({ ...bom, metadata: { ...bom.metadata, timestamp: 'not-a-date' } }),
    /Invalid CycloneDX/,
  );
});
