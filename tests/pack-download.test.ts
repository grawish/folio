import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {
  CatalogVerifier,
  PackCatalogStore,
  MAX_PACK_BYTES,
  CATALOG_SIGNATURE_CONTEXT,
  requireVerifiedPack,
} from '../electron/core/pack-catalog';
import { PackDownloads } from '../electron/core/pack-download';

const now = Date.now();
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const verifier = () => new CatalogVerifier({ 'test-publisher': publicPem }, ['packs.test']);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const payload = (bytes: Buffer, sequence = 1) => ({
  schemaVersion: 1,
  sequence,
  issuedAt: new Date(now - 1000).toISOString(),
  expiresAt: new Date(now + 3600_000).toISOString(),
  packs: [
    {
      id: 'folio-example-v1',
      title: 'Example resource pack',
      description: 'Synthetic catalog test.',
      base: {
        engine: 'tectonic',
        version: '0.17.0',
        bundle: 'folio-core-v1',
        platform: 'darwin-arm64',
        id: '1'.repeat(64),
      },
      target: {
        engine: 'tectonic',
        version: '0.17.0',
        bundle: 'folio-example-v1',
        platform: 'darwin-arm64',
        id: '2'.repeat(64),
      },
      packages: ['folio-example.sty'],
      artifact: {
        url: 'https://packs.test/example.foliopack',
        sha256: hash(bytes),
        bytes: bytes.length,
      },
    },
  ],
});
function envelope(value: unknown) {
  const raw = Buffer.from(JSON.stringify(value));
  return Buffer.from(
    JSON.stringify({
      keyId: 'test-publisher',
      payload: raw.toString('base64'),
      signature: sign(
        null,
        Buffer.concat([Buffer.from(CATALOG_SIGNATURE_CONTEXT), raw]),
        privateKey,
      ).toString('base64'),
    }),
  );
}
async function fixture(t: TestContext, bytes = Buffer.from('A verified synthetic resource pack.')) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-pack-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = verifier().verify(envelope(payload(bytes)), now);
  return { root, bytes, pack: catalog.packs[0], catalog, downloads: path.join(root, 'downloads') };
}
const chunks = (values: Uint8Array[]) =>
  new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const value = values.shift();
        if (value) controller.enqueue(value);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
const fullResponse = (bytes: Buffer) =>
  new Response(new Uint8Array(bytes), {
    headers: { 'Content-Length': String(bytes.length), ETag: '"same-content"' },
  });

test('retired keys preserve the saved rollback floor but cannot authorize fresh catalogs or downloads', async (t) => {
  const f = await fixture(t);
  const folder = path.join(f.root, 'rotation');
  const before = envelope(payload(f.bytes, 4));
  await new PackCatalogStore(folder, verifier(), () => now).accept(before);
  const replacement = generateKeyPairSync('ed25519');
  const trust = new CatalogVerifier(
    {
      'test-publisher': publicPem,
      replacement: replacement.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
    ['packs.test'],
    1,
    ['test-publisher'],
  );
  const store = new PackCatalogStore(folder, trust, () => now);
  assert.throws(() => trust.verify(before, now), /retired/);
  const historical = await store.load(true);
  assert.equal(historical?.sequence, 4);
  assert.throws(() => requireVerifiedPack(historical!.packs[0]), /verified catalog/);
  const next = (sequence: number) => {
    const raw = Buffer.from(JSON.stringify(payload(f.bytes, sequence)));
    return Buffer.from(
      JSON.stringify({
        keyId: 'replacement',
        payload: raw.toString('base64'),
        signature: sign(
          null,
          Buffer.concat([Buffer.from(CATALOG_SIGNATURE_CONTEXT), raw]),
          replacement.privateKey,
        ).toString('base64'),
      }),
    );
  };
  await assert.rejects(store.accept(next(3)), /older/);
  await store.accept(next(5));
  requireVerifiedPack((await store.load())!.packs[0], now);
  await assert.rejects(store.accept(envelope(payload(f.bytes, 6))), /retired/);
  assert.equal((await store.load())?.sequence, 5);
});

test('signed catalogs require the pinned Ed25519 publisher and freeze each download capability', () => {
  const body = payload(Buffer.from('example')),
    signed = envelope(body),
    catalog = verifier().verify(signed, now);
  assert.equal(catalog.sequence, 1);
  requireVerifiedPack(catalog.packs[0], now);
  assert.throws(() => {
    (catalog.packs[0].artifact as { bytes: number }).bytes = 9;
  }, /read only/);
  assert.throws(
    () => requireVerifiedPack(JSON.parse(JSON.stringify(catalog.packs[0])), now),
    /verified catalog/,
  );
  assert.throws(() => requireVerifiedPack(catalog.packs[0], now + 3600_001), /expired/);
  const changed = JSON.parse(signed.toString());
  const unscoped = {
    ...changed,
    signature: sign(null, Buffer.from(changed.payload, 'base64'), privateKey).toString('base64'),
  };
  assert.throws(() => verifier().verify(Buffer.from(JSON.stringify(unscoped)), now), /signature/);
  assert.throws(
    () =>
      new CatalogVerifier({ 'test-publisher': publicPem }, ['packs.test'], 2).verify(signed, now),
    /version/,
  );
  changed.payload = Buffer.from(JSON.stringify({ ...body, sequence: 9 })).toString('base64');
  assert.throws(() => verifier().verify(Buffer.from(JSON.stringify(changed)), now), /signature/);
  changed.keyId = 'unknown';
  assert.throws(() => verifier().verify(Buffer.from(JSON.stringify(changed)), now), /trusted/);
  const wrong = generateKeyPairSync('ed25519');
  assert.throws(
    () =>
      new CatalogVerifier(
        { 'test-publisher': wrong.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
        ['packs.test'],
      ).verify(signed, now),
    /signature/,
  );
  assert.throws(() => verifier().verify(signed, now + 3600_001), /expired/);
  const expired = verifier().verify(signed, now + 3600_001, true);
  assert.throws(() => requireVerifiedPack(expired.packs[0], now), /verified catalog/);
});

test('catalog validation rejects rollback-friendly dates, unsafe hosts, changed engines and ambiguous entries', () => {
  const base = payload(Buffer.from('example'));
  const cases = [
    { ...base, sequence: 0 },
    { ...base, sequence: 1.2 },
    { ...base, schemaVersion: 2 },
    { ...base, extra: true },
    { ...base, issuedAt: new Date(now + 600_000).toISOString() },
    { ...base, expiresAt: new Date(now + 91 * 86400_000).toISOString() },
    { ...base, packs: [base.packs[0], base.packs[0]] },
    { ...base, packs: [{ ...base.packs[0], target: { ...base.packs[0].target, version: '9.0' } }] },
    { ...base, packs: [{ ...base.packs[0], packages: ['../bad.sty'] }] },
    { ...base, packs: [{ ...base.packs[0], packages: ['file.sty', 'FILE.sty'] }] },
    {
      ...base,
      packs: [
        { ...base.packs[0], artifact: { ...base.packs[0].artifact, bytes: MAX_PACK_BYTES + 1 } },
      ],
    },
    ...[
      'http://packs.test/file',
      'https://other.test/file',
      'https://user:pass@packs.test/file',
      'https://packs.test:444/file',
      'https://packs.test/file#fragment',
    ].map((url) => ({
      ...base,
      packs: [{ ...base.packs[0], artifact: { ...base.packs[0].artifact, url } }],
    })),
  ];
  for (const candidate of cases) assert.throws(() => verifier().verify(envelope(candidate), now));
  assert.throws(() => verifier().verify(envelope(base), NaN), /time/);
});

test('catalog acceptance retains the highest signed sequence across restart, expiration and failed updates', async (t) => {
  const f = await fixture(t),
    root = path.join(f.root, 'catalog');
  const store = new PackCatalogStore(root, verifier(), () => now);
  await store.accept(envelope(payload(f.bytes, 2)));
  const previous = await fs.readFile(path.join(root, 'catalog.json'));
  await assert.rejects(store.accept(envelope(payload(f.bytes, 1))), /older/);
  const reused = payload(f.bytes, 2);
  reused.packs[0].title = 'Different title';
  await assert.rejects(store.accept(envelope(reused)), /reuses/);
  await assert.rejects(store.accept(Buffer.from('{}')));
  assert.deepEqual(await fs.readFile(path.join(root, 'catalog.json')), previous);
  assert.equal((await new PackCatalogStore(root, verifier(), () => now).load())?.sequence, 2);
  const expired = new PackCatalogStore(root, verifier(), () => now + 7200_000);
  await assert.rejects(expired.load(), /expired/);
  const newer = payload(f.bytes, 3);
  newer.issuedAt = new Date(now + 7200_000).toISOString();
  newer.expiresAt = new Date(now + 10800_000).toISOString();
  assert.equal((await expired.accept(envelope(newer))).sequence, 3);
  const concurrent = new PackCatalogStore(root, verifier(), () => now + 7200_000);
  const high = { ...newer, sequence: 5 },
    low = { ...newer, sequence: 4 };
  const results = await Promise.allSettled([
    concurrent.accept(envelope(high)),
    concurrent.accept(envelope(low)),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  const upgraded = new PackCatalogStore(
    root,
    new CatalogVerifier({ 'test-publisher': publicPem }, ['packs.test'], 6),
    () => now + 7200_000,
  );
  await assert.rejects(upgraded.load(), /version/);
  assert.equal((await upgraded.accept(envelope({ ...newer, sequence: 6 }))).sequence, 6);
  await fs.writeFile(path.join(root, 'catalog.json'), '{damaged');
  await assert.rejects(concurrent.accept(envelope({ ...newer, sequence: 6 })));
});

test('complete downloads verify all bytes, reuse only matching cache and reject forged capabilities', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const downloader = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => {
      requests++;
      return fullResponse(f.bytes);
    },
  });
  await assert.rejects(downloader.download(JSON.parse(JSON.stringify(f.pack))), /verified catalog/);
  const result = await downloader.download(f.pack);
  assert.equal(result.cached, false);
  assert.deepEqual(await fs.readFile(result.path), f.bytes);
  assert.equal((await downloader.download(f.pack)).cached, true);
  assert.equal(requests, 1);
  await fs.writeFile(result.path, Buffer.alloc(f.bytes.length));
  await assert.rejects(downloader.download(f.pack), /damaged/);
  assert.equal(requests, 1);
  await downloader.remove(f.pack);
  assert.equal((await downloader.download(f.pack)).cached, false);
  assert.equal(requests, 2);
  const historical = verifier().verify(envelope(payload(f.bytes)), now + 7200_000, true).packs[0];
  await assert.rejects(downloader.download(historical), /verified catalog/);
  await downloader.remove(historical);
  await assert.rejects(fs.access(result.path));
  await assert.rejects(downloader.remove(JSON.parse(JSON.stringify(f.pack))), /authenticated/);
});

async function partial(t: TestContext) {
  const f = await fixture(t, Buffer.alloc(8192, 42)),
    controller = new AbortController();
  const downloader = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () =>
      new Response(chunks([f.bytes.subarray(0, 2048), f.bytes.subarray(2048)]), {
        headers: { 'Content-Length': String(f.bytes.length), ETag: '"same-content"' },
      }),
  });
  await assert.rejects(
    downloader.download(f.pack, {
      signal: controller.signal,
      progress: ({ received }) => {
        if (received === 2048) controller.abort();
      },
    }),
    /abort/i,
  );
  assert.equal(
    (await fs.stat(path.join(f.downloads, f.pack.artifact.sha256, 'payload.part'))).size,
    2048,
  );
  return f;
}

test('cancellation keeps a resumable prefix and the next process-sized session checks Range and If-Range', async (t) => {
  const f = await partial(t);
  const downloader = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async (_url, init) => {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Range, 'bytes=2048-8191');
      assert.equal(headers['If-Range'], '"same-content"');
      return new Response(new Uint8Array(f.bytes.subarray(2048)), {
        status: 206,
        headers: {
          'Content-Range': 'bytes 2048-8191/8192',
          'Content-Length': '6144',
          ETag: '"same-content"',
        },
      });
    },
  });
  assert.deepEqual(await fs.readFile((await downloader.download(f.pack)).path), f.bytes);
});

test('a full response after Range restarts the owned partial file instead of appending', async (t) => {
  const f = await partial(t);
  let restarted = false;
  const downloader = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => fullResponse(f.bytes),
  });
  const result = await downloader.download(f.pack, {
    progress: ({ received, resumed }) => {
      if (received === 8192 && !resumed) restarted = true;
    },
  });
  assert.deepEqual(await fs.readFile(result.path), f.bytes);
  assert.ok(restarted);
});

test('wrong ranges, changed validators and compressed responses discard the unsafe prefix', async (t) => {
  for (const headers of [
    { 'Content-Range': 'bytes 1-8191/8192', ETag: '"same-content"' },
    { 'Content-Range': 'bytes 2048-8191/8192', ETag: '"different-content"' },
    { 'Content-Range': 'bytes 2048-8191/8192', ETag: '"same-content"', 'Content-Encoding': 'gzip' },
  ] as Record<string, string>[]) {
    const f = await partial(t);
    const downloader = new PackDownloads(f.downloads, ['packs.test'], {
      fetch: async () =>
        new Response(new Uint8Array(f.bytes.subarray(2048)), { status: 206, headers }),
    });
    await assert.rejects(downloader.download(f.pack), /range|encoding/i);
    assert.equal(
      (await fs.stat(path.join(f.downloads, f.pack.artifact.sha256, 'payload.part'))).size,
      0,
    );
    await assert.rejects(
      fs.access(path.join(f.downloads, f.pack.artifact.sha256, 'payload.foliopack')),
    );
  }
});

test('changed retained bytes, excessive output and wrong hashes cannot become a ready pack', async (t) => {
  const f = await partial(t);
  const part = path.join(f.downloads, f.pack.artifact.sha256, 'payload.part');
  await fs.writeFile(part, Buffer.alloc(2048, 7));
  const downloader = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () =>
      new Response(new Uint8Array(f.bytes.subarray(2048)), {
        status: 206,
        headers: { 'Content-Range': 'bytes 2048-8191/8192', ETag: '"same-content"' },
      }),
  });
  await assert.rejects(downloader.download(f.pack), /integrity/);
  assert.equal((await fs.stat(part)).size, 0);
  for (const bytes of [Buffer.alloc(8193), Buffer.alloc(8192, 7)]) {
    const bad = new PackDownloads(f.downloads, ['packs.test'], {
      fetch: async () => new Response(new Uint8Array(bytes)),
    });
    await assert.rejects(bad.download(f.pack), /size|integrity/);
    assert.equal((await fs.stat(part)).size, 0);
  }
});

test('redirects are checked at every hop and failures preserve a valid partial download', async (t) => {
  const f = await partial(t);
  let requests = 0;
  const bad = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => {
      requests++;
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
    },
  });
  await assert.rejects(bad.download(f.pack), /HTTPS/);
  assert.equal(requests, 1);
  assert.equal(
    (await fs.stat(path.join(f.downloads, f.pack.artifact.sha256, 'payload.part'))).size,
    2048,
  );
  const unavailable = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => new Response(null, { status: 503 }),
  });
  await assert.rejects(unavailable.download(f.pack), /HTTP 503/);
  const loop = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => new Response(null, { status: 302, headers: { Location: '/again' } }),
  });
  await assert.rejects(loop.download(f.pack), /redirected/);
});

test('linked folders, cache files and hard links are refused without altering their targets', async (t) => {
  const f = await fixture(t),
    outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, f.downloads);
  const downloader = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => fullResponse(f.bytes),
  });
  await assert.rejects(downloader.download(f.pack), /linked/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(f.downloads);
  await fs.mkdir(f.downloads);
  const folder = path.join(f.downloads, f.pack.artifact.sha256);
  await fs.mkdir(folder);
  const target = path.join(outside, 'keep');
  await fs.writeFile(target, 'KEEP');
  const partialFile = path.join(folder, 'payload.part');
  await fs.symlink(target, partialFile);
  await assert.rejects(downloader.download(f.pack));
  assert.equal(await fs.readFile(target, 'utf8'), 'KEEP');
  await fs.unlink(partialFile);
  await fs.link(target, partialFile);
  await assert.rejects(downloader.download(f.pack), /regular file/);
  await assert.rejects(downloader.remove(f.pack), /linked/);
  assert.equal(await fs.readFile(target, 'utf8'), 'KEEP');
});

test('overlapping downloads and deletion are rejected across manager instances', async (t) => {
  const f = await fixture(t);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const first = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => {
      enter();
      await hold;
      return fullResponse(f.bytes);
    },
  });
  const running = first.download(f.pack);
  await entered;
  try {
    const second = new PackDownloads(f.downloads, ['packs.test']);
    await assert.rejects(second.download(f.pack), /already running/);
    await assert.rejects(second.remove(f.pack), /Cancel/);
  } finally {
    release();
    await running;
  }
});

test('a truncated stream keeps only its received prefix and can resume without an ETag', async (t) => {
  const f = await fixture(t, Buffer.alloc(8192, 3));
  const first = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => new Response(chunks([f.bytes.subarray(0, 1234)])),
  });
  await assert.rejects(first.download(f.pack), /interrupted/);
  const second = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async (_url, init) => {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Range, 'bytes=1234-8191');
      assert.equal(headers['If-Range'], undefined);
      return new Response(new Uint8Array(f.bytes.subarray(1234)), {
        status: 206,
        headers: { 'Content-Range': 'bytes 1234-8191/8192' },
      });
    },
  });
  assert.deepEqual(await fs.readFile((await second.download(f.pack)).path), f.bytes);
});

test('a real network timeout aborts the response and a later request resumes its saved bytes', async (t) => {
  const f = await fixture(t, Buffer.alloc(8192, 4));
  const server = createServer((req, res) => {
    if (req.headers.range) {
      assert.equal(req.headers.range, 'bytes=2048-8191');
      res.writeHead(206, { 'Content-Range': 'bytes 2048-8191/8192', ETag: '"stable"' });
      res.end(f.bytes.subarray(2048));
    } else {
      res.writeHead(200, { 'Content-Length': 8192, ETag: '"stable"' });
      res.write(f.bytes.subarray(0, 2048));
      // Deliberately leave the response open. The production AbortSignal must
      // stop the body read, rather than only bounding the initial fetch.
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address() as { port: number };
  const localFetch = (_url: string, init: RequestInit) =>
    fetch(`http://127.0.0.1:${address.port}/pack`, init);
  const first = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: localFetch,
    timeoutMs: 2000,
  });
  await assert.rejects(first.download(f.pack), /timeout|abort/i);
  assert.equal(
    (await fs.stat(path.join(f.downloads, f.pack.artifact.sha256, 'payload.part'))).size,
    2048,
  );
  const second = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: localFetch,
    timeoutMs: 5000,
  });
  assert.deepEqual(await fs.readFile((await second.download(f.pack)).path), f.bytes);
});

test('a disk write failure retains the exact short write for a later verified retry', async (t) => {
  const f = await fixture(t, Buffer.alloc(8192, 5));
  const originalOpen = fs.open;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('/payload.part')) {
      const originalWrite = handle.write.bind(handle);
      let first = true;
      handle.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (first) {
          first = false;
          return originalWrite(buffer, offset, Math.min(123, length), position);
        }
        throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' });
      }) as typeof handle.write;
    }
    return handle;
  };
  try {
    await assert.rejects(
      new PackDownloads(f.downloads, ['packs.test'], {
        fetch: async () => fullResponse(f.bytes),
      }).download(f.pack),
      /disk full/,
    );
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(
    (await fs.stat(path.join(f.downloads, f.pack.artifact.sha256, 'payload.part'))).size,
    123,
  );
  const resumed = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async (_url, init) => {
      assert.equal((init.headers as Record<string, string>).Range, 'bytes=123-8191');
      return new Response(new Uint8Array(f.bytes.subarray(123)), {
        status: 206,
        headers: {
          'Content-Range': 'bytes 123-8191/8192',
          ETag: '"same-content"',
        },
      });
    },
  });
  assert.deepEqual(await fs.readFile((await resumed.download(f.pack)).path), f.bytes);
});

test('actual process kills before verification and after publication resume to the exact signed bytes', async (t) => {
  const f = await fixture(t, Buffer.alloc(512 * 1024, 91));
  const ranges: string[] = [];
  const server = createServer((req, res) => {
    const range = req.headers.range;
    let start = 0;
    if (range) {
      ranges.push(range);
      start = Number(range.match(/^bytes=(\d+)-/)?.[1]);
    }
    res.writeHead(range ? 206 : 200, {
      'Content-Length': f.bytes.length - start,
      ETag: '"same-content"',
      ...(range
        ? { 'Content-Range': `bytes ${start}-${f.bytes.length - 1}/${f.bytes.length}` }
        : {}),
    });
    res.end(f.bytes.subarray(start));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number },
    origin = `http://127.0.0.1:${address.port}`;
  await fs.writeFile(path.join(f.root, 'catalog.json'), envelope(payload(f.bytes)));
  await fs.writeFile(path.join(f.root, 'key.pem'), publicPem);
  for (const phase of ['received', 'verified', 'published']) {
    const storage = path.join(f.root, phase);
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/fixtures/pack-download-crash.ts', f.root, storage, origin, phase],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      errors = '';
    child.stderr.on('data', (value) => {
      errors += value;
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Pack checkpoint timeout: ' + errors));
      }, 15000);
      child.stdout.on('data', (value) => {
        output += value;
        if (output.includes('READY-TO-KILL')) child.kill('SIGKILL');
      });
      child.on('error', reject);
      child.on('exit', (_code, signal) => {
        clearTimeout(timeout);
        if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
        else reject(new Error('Unexpected fixture exit: ' + errors));
      });
    });
    const downloaded = await new PackDownloads(storage, ['packs.test'], {
      fetch: (url, init) => fetch(origin + new URL(url).pathname, init),
    }).download(f.pack);
    assert.deepEqual(await fs.readFile(downloaded.path), f.bytes);
    assert.equal(downloaded.cached, phase === 'published');
  }
  assert.ok(ranges.length >= 1, 'Interrupted transfer must request its saved suffix.');
});
