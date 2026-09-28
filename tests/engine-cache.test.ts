import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireEngineCache, engineCachePolicy } from '../electron/core/engine-cache';

const id = (n: number) => n.toString(16).padStart(64, '0');
const policy = { ...engineCachePolicy, bytes: 100, entries: 8, depth: 2 };
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-engine-cache-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const cache = path.join(work, 'engine-cache');
  const acquire = (n: number) => acquireEngineCache(work, id(n), policy);
  const write = async (n: number, bytes: number) => {
    const lease = await acquire(n);
    try {
      await fs.writeFile(path.join(lease.path, 'format.fmt'), Buffer.alloc(bytes, n));
      await lease.check();
    } finally {
      await lease.release();
    }
  };
  const names = () => fs.readdir(cache);
  return { root, work, cache, acquire, write, names };
}

test('cache retention keeps two recent runtimes, reuses warm bytes and preserves unmarked files', async (t) => {
  const { cache, acquire, write, names } = await fixture(t);
  await write(1, 30);
  await write(2, 30);
  await fs.writeFile(path.join(cache, 'keep-user-note'), 'Unmarked data');
  await fs.utimes(path.join(cache, id(1)), new Date(1), new Date(1));
  await fs.utimes(path.join(cache, id(2)), new Date(2), new Date(2));
  const warm = await acquire(1);
  assert.deepEqual(await fs.readFile(path.join(warm.path, 'format.fmt')), Buffer.alloc(30, 1));
  await warm.release();
  await write(3, 30);
  assert.deepEqual((await names()).sort(), [id(1), id(3), 'keep-user-note'].sort());
  assert.equal(await fs.readFile(path.join(cache, 'keep-user-note'), 'utf8'), 'Unmarked data');
});

test('aggregate byte and entry bounds evict old idle caches after a build', async (t) => {
  const { cache, acquire, write, names } = await fixture(t);
  await write(1, 60);
  await write(2, 60);
  assert.deepEqual(await names(), [id(2)]);
  const lease = await acquire(3);
  for (let i = 0; i < 8; i++) await fs.writeFile(path.join(lease.path, `f${i}`), 'a');
  await lease.check();
  await lease.release();
  assert.deepEqual(await names(), [id(3)]);
  assert.equal((await fs.readdir(path.join(cache, id(3)))).length, 8);
});

test('oversized current cache fails its live check, is removed on release and can rebuild', async (t) => {
  const { acquire, write, names } = await fixture(t);
  await write(1, 30);
  const lease = await acquire(2);
  await fs.writeFile(path.join(lease.path, 'too-big'), Buffer.alloc(101));
  await assert.rejects(lease.check(), /storage limit/);
  await lease.release();
  await lease.release();
  assert.deepEqual(await names(), [id(1)]);
  const next = await acquire(2);
  assert.deepEqual(await fs.readdir(next.path), []);
  await next.release();
});

test('replacing an oversized cache reserves its slot before recreating it', async (t) => {
  const { cache, acquire, write, names } = await fixture(t);
  await write(1, 30);
  await write(2, 30);
  await fs.utimes(path.join(cache, id(1)), new Date(1), new Date(1));
  await fs.mkdir(path.join(cache, id(3)));
  await fs.writeFile(path.join(cache, id(3), 'large'), Buffer.alloc(101));
  const lease = await acquire(3);
  assert.deepEqual((await names()).sort(), [id(2), id(3)].sort());
  assert.deepEqual(await fs.readdir(lease.path), []);
  await lease.release();
});

test('count and depth violations are bounded and discarded after the writer stops', async (t) => {
  const { acquire, names } = await fixture(t);
  let lease = await acquire(1);
  for (let i = 0; i < 9; i++) await fs.writeFile(path.join(lease.path, `f${i}`), '');
  await assert.rejects(lease.check(), /storage limit/);
  await lease.release();
  assert.deepEqual(await names(), []);
  lease = await acquire(2);
  const deep = path.join(lease.path, 'a/b/c');
  await fs.mkdir(deep, { recursive: true });
  await assert.rejects(lease.check(), /storage limit/);
  await lease.release();
  assert.deepEqual(await names(), []);
});

test('a live root rejects overlapping leases without pruning or queueing active work', async (t) => {
  const { root, work, acquire } = await fixture(t);
  const lease = await acquire(1);
  await fs.writeFile(path.join(lease.path, 'active'), 'working');
  const alias = path.join(root, 'alias');
  await fs.symlink(work, alias);
  await assert.rejects(acquireEngineCache(alias, id(2), policy), /busy/);
  assert.equal(await fs.readFile(path.join(lease.path, 'active'), 'utf8'), 'working');
  await lease.release();
  const next = await acquire(2);
  await next.release();
});

test('linked cache roots and runtime entries are rejected without changing outside files', async (t) => {
  const { root, work, cache, acquire } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep'), 'outside');
  await fs.mkdir(work);
  await fs.symlink(outside, cache);
  await assert.rejects(acquire(1), /local directory/);
  await fs.unlink(cache);
  await fs.mkdir(cache);
  await fs.symlink(outside, path.join(cache, id(1)));
  await assert.rejects(acquire(1), /local directory/);
  assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'outside');
  assert.equal((await fs.lstat(path.join(cache, id(1)))).isSymbolicLink(), true);
});

test('linked payloads and directory replacements are preserved, and failed cleanup releases admission', async (t) => {
  const { root, acquire } = await fixture(t);
  const outside = path.join(root, 'original');
  await fs.writeFile(outside, 'outside');
  let lease = await acquire(1);
  await fs.link(outside, path.join(lease.path, 'linked'));
  await assert.rejects(lease.check(), /unsupported linked/);
  await assert.rejects(lease.release(), /unsupported linked/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  await fs.unlink(path.join(lease.path, 'linked'));
  lease = await acquire(1);
  const moved = path.join(root, 'moved');
  await fs.rename(lease.path, moved);
  await fs.mkdir(lease.path);
  await fs.writeFile(path.join(lease.path, 'replacement'), 'keep');
  await assert.rejects(lease.release(), /changed before cleanup/);
  assert.equal(await fs.readFile(path.join(lease.path, 'replacement'), 'utf8'), 'keep');
  const next = await acquire(1);
  await next.release();
});

test('invalid identities and policies fail before creating a work root', async (t) => {
  const { work } = await fixture(t);
  await assert.rejects(acquireEngineCache(work, '../outside'), /identity/);
  await assert.rejects(acquireEngineCache(work, id(1), { ...policy, bytes: -1 }), /policy/);
  await assert.rejects(fs.lstat(work), { code: 'ENOENT' });
});

test('rejected cache admission cannot accumulate empty runtime directories', async (t) => {
  const { root, work, cache, acquire, names } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(cache, { recursive: true });
  await fs.symlink(outside, path.join(cache, id(999)));
  for (let i = 1; i <= 10; i++) await assert.rejects(acquire(i), /local directory/);
  assert.deepEqual(await names(), [id(999)]);
  assert.equal((await fs.lstat(work)).isDirectory(), true);
});
