import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profileStorage } from '../scripts/profile-directory-storage.js';

test('profile storage counts logical file bytes and excludes a linked outside tree', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-profile-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  await fs.mkdir(path.join(profile, 'cache/nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'outside'));
  await fs.writeFile(path.join(profile, 'state'), Buffer.alloc(7));
  await fs.writeFile(path.join(profile, 'cache/one'), Buffer.alloc(11));
  await fs.writeFile(path.join(profile, 'cache/nested/two'), Buffer.alloc(13));
  await fs.writeFile(path.join(root, 'outside/foreign'), Buffer.alloc(1000));
  await fs.symlink(path.join(root, 'outside'), path.join(profile, 'link'));
  const measured = await profileStorage(profile);
  assert.equal(measured.regularFiles, 3);
  assert.equal(measured.logicalFileBytes, 31);
  assert.equal(measured.directories, 2);
  assert.equal(measured.symlinks, 1);
  assert.deepEqual(measured.groups, {
    cache: { regularFiles: 2, logicalFileBytes: 24 },
    state: { regularFiles: 1, logicalFileBytes: 7 },
  });
  assert.equal(measured.entries.length, 6);
  assert.ok(measured.entries.every((entry) => !entry.path.includes('foreign')));
  await assert.rejects(profileStorage(path.join(profile, 'link')), /root must be a directory/);
  assert.equal((await fs.stat(path.join(root, 'outside/foreign'))).size, 1000);
});

test('profile storage stops instead of reporting a silently truncated tree', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-profile-bounds-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'a/b'), { recursive: true });
  await fs.writeFile(path.join(root, 'a/b/file'), 'bytes');
  await assert.rejects(profileStorage(root, { maxEntries: 2 }), /entry bound/);
  await assert.rejects(profileStorage(root, { maxDepth: 1 }), /depth bound/);
  await assert.rejects(profileStorage(root, { maxEntries: Infinity }), /Invalid.*bounds/);
  assert.equal((await profileStorage(root)).logicalFileBytes, 5);
});
