import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verifyNpmNotices } from '../scripts/verify-npm-notices';

test('npm notices preserve the source index, original texts and both missing-text disclosures', async () => {
  const result = await verifyNpmNotices('resources/npm-notices');
  assert.equal(result.indexedPackages, 43);
  assert.equal(result.originalNoticeFiles, 42);
  assert.equal(result.records.length, 44);
  assert.deepEqual(result.missingOriginalText, ['@napi-rs/canvas-darwin-arm64', 'lazy-val']);
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.ok(
    pkg.build.extraResources.some(
      (e: { from: string; to: string }) =>
        e.from === 'resources/npm-notices' && e.to === 'npm-notices',
    ),
  );
});

test('npm package gate rejects altered texts, missing notices, links, extra files and altered provenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-npm-notices-'));
  try {
    const folder = path.join(root, 'notices');
    await fs.cp('resources/npm-notices', folder, { recursive: true });
    await verifyNpmNotices(folder);
    const file = path.join(folder, 'react--LICENSE');
    const original = await fs.readFile(file);
    await fs.writeFile(file, Buffer.alloc(original.length));
    await assert.rejects(verifyNpmNotices(folder), /Changed/);
    await fs.unlink(file);
    await assert.rejects(verifyNpmNotices(folder), /Incomplete/);
    const outside = path.join(root, 'outside');
    await fs.writeFile(outside, original);
    await fs.symlink(outside, file);
    await assert.rejects(verifyNpmNotices(folder), /linked/);
    await fs.unlink(file);
    await fs.writeFile(file, original);
    for (const name of ['README.md', 'SOURCES.json']) {
      const target = path.join(folder, name);
      const bytes = await fs.readFile(target);
      await fs.writeFile(target, Buffer.alloc(bytes.length));
      await assert.rejects(verifyNpmNotices(folder), /Changed/);
      await fs.writeFile(target, bytes);
    }
    await fs.writeFile(path.join(folder, 'extra.txt'), 'extra');
    await assert.rejects(verifyNpmNotices(folder), /unexpected/);
    await fs.unlink(path.join(folder, 'extra.txt'));
    await fs.symlink(folder, path.join(root, 'linked-directory'));
    await assert.rejects(verifyNpmNotices(path.join(root, 'linked-directory')), /Linked/);
    await verifyNpmNotices(folder);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
