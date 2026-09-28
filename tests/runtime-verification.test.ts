import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { verifyRuntime, runtimePin, type RuntimeManifest } from '../electron/core/runtime';

async function fixture(t: TestContext, size = 300 * 1024) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-verify-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files: Record<string, string> = {};
  for (const [index, name] of [
    'tectonic',
    'bundle.zip',
    ...Array.from({ length: 10 }, (_, i) => `nested/resource-${i}.dat`),
  ].entries()) {
    const data = Buffer.alloc(size + index, index + 1);
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), data);
    files[name] = createHash('sha256').update(data).digest('hex');
  }
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    version: '0.17.0',
    bundle: 'folio-core-v1',
    platform: 'darwin-arm64',
    files,
  };
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return { root, manifest, pin: runtimePin(manifest) };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('verification hashes complete resources with bounded concurrent readers and buffers', async (t) => {
  const f = await fixture(t);
  const open = fs.open.bind(fs),
    ready = gate();
  let active = 0,
    peak = 0,
    reads = 0,
    readBytes = 0;
  const reached = new Set<string>();
  t.after(ready.release);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const file = String(args[0]);
    if (!Object.keys(f.manifest.files).some((name) => path.join(f.root, name) === file))
      return handle;
    active++;
    peak = Math.max(peak, active);
    const close = handle.close.bind(handle),
      read = handle.read.bind(handle);
    handle.readFile = async () => {
      throw new Error('Whole-resource allocation is forbidden.');
    };
    handle.read = (async (...values: Parameters<typeof read>) => {
      const buffer: unknown = values[0];
      assert.ok(Buffer.isBuffer(buffer));
      assert.ok(buffer.length <= 128 * 1024);
      reached.add(file);
      if (reached.size >= 4) ready.release();
      await ready.promise;
      const result = await read(...values);
      reads++;
      readBytes += result.bytesRead;
      return result;
    }) as typeof handle.read;
    handle.close = async () => {
      try {
        await close();
      } finally {
        active--;
      }
    };
    return handle;
  });
  const result = await verifyRuntime(f.root, f.pin);
  assert.deepEqual(result, { manifest: f.manifest, pin: f.pin });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(reached.size, Object.keys(f.manifest.files).length);
  assert.ok(reads > reached.size);
  assert.equal(readBytes, 12 * 300 * 1024 + 66);
});

test('each verification rejects changed bytes even when size and modification time are preserved', async (t) => {
  const f = await fixture(t);
  await verifyRuntime(f.root, f.pin);
  const file = path.join(f.root, 'nested/resource-9.dat');
  const before = await fs.stat(file);
  const original = await fs.readFile(file),
    changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1;
  await fs.writeFile(file, changed);
  await fs.utimes(file, before.atime, before.mtime);
  assert.equal((await fs.stat(file)).size, before.size);
  await assert.rejects(verifyRuntime(f.root, f.pin), /resource-9.dat failed its integrity check/);
  await fs.writeFile(file, original);
  await verifyRuntime(f.root, f.pin);
});

test('a failed verification waits for every in-flight read and closes all handles', async (t) => {
  const f = await fixture(t, 32);
  await fs.writeFile(path.join(f.root, 'tectonic'), 'Corrupt');
  const open = fs.open.bind(fs),
    allReading = gate(),
    others = gate(),
    firstClosed = gate();
  t.after(() => {
    allReading.release();
    others.release();
  });
  let active = 0,
    entered = 0,
    settled = false,
    opened = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args),
      file = String(args[0]);
    if (file.endsWith('manifest.json')) return handle;
    active++;
    opened++;
    const close = handle.close.bind(handle),
      read = handle.read.bind(handle);
    let firstRead = true;
    handle.read = (async (...values: Parameters<typeof read>) => {
      if (firstRead) {
        firstRead = false;
        if (++entered === 4) allReading.release();
      }
      await allReading.promise;
      if (file !== path.join(f.root, 'tectonic')) await others.promise;
      return read(...values);
    }) as typeof handle.read;
    handle.close = async () => {
      try {
        await close();
      } finally {
        active--;
        if (file === path.join(f.root, 'tectonic')) firstClosed.release();
      }
    };
    return handle;
  });
  const operation = verifyRuntime(f.root, f.pin);
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await firstClosed.promise;
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(active, 3);
  others.release();
  await assert.rejects(operation, /tectonic failed its integrity check/);
  assert.equal(active, 0);
  assert.equal(opened, 4);
});

test('streaming verification rejects a resource that grows beyond its admitted size', async (t) => {
  const f = await fixture(t, 32);
  const open = fs.open.bind(fs);
  let expanded = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) !== path.join(f.root, 'tectonic')) return handle;
    const read = handle.read.bind(handle);
    handle.read = (async (...values: Parameters<typeof read>) => {
      if (!expanded) {
        expanded = true;
        // A sparse extension after fstat exercises the actual byte-read bound.
        await fs.truncate(path.join(f.root, 'tectonic'), 256 * 1024 * 1024 + 1);
      }
      return read(...values);
    }) as typeof handle.read;
    return handle;
  });
  await assert.rejects(verifyRuntime(f.root, f.pin), /resource exceeds its size limit/);
  assert.equal(expanded, true);
});

test('concurrent verification preserves the aggregate one-gigabyte resource limit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-verify-total-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const digest = createHash('sha256'),
    zeros = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 256; i++) digest.update(zeros);
  const hash = digest.digest('hex');
  const files = Object.fromEntries(
    ['tectonic', 'bundle.zip', 'a', 'b', 'c'].map((name) => [name, hash]),
  );
  for (const name of Object.keys(files)) {
    const file = path.join(root, name);
    await fs.writeFile(file, '');
    await fs.truncate(file, 256 * 1024 * 1024);
  }
  await fs.writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: '0.17.0',
      bundle: 'folio-core-v1',
      platform: 'darwin-arm64',
      files,
    }),
  );
  await assert.rejects(verifyRuntime(root), /resources exceed 1 GB/);
});
