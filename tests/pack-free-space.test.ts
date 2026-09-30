import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CatalogVerifier, CATALOG_SIGNATURE_CONTEXT } from '../electron/core/pack-catalog';
import { PackDownloads, PACK_SPACE_MARGIN } from '../electron/core/pack-download';

const now = Date.now();
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const verifier = () => new CatalogVerifier({ 'test-publisher': publicPem }, ['packs.test']);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const payload = (bytes: Buffer) => ({
  schemaVersion: 1,
  sequence: 1,
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
async function fixture(t: TestContext, bytes = Buffer.alloc(4096, 7)) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-pack-space-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = verifier().verify(envelope(payload(bytes)), now);
  return { root, bytes, pack: catalog.packs[0], downloads: path.join(root, 'downloads') };
}
const fullResponse = (bytes: Buffer) =>
  new Response(new Uint8Array(bytes), {
    headers: { 'Content-Length': String(bytes.length), ETag: '"same-content"' },
  });

test('insufficient free space is rejected before any network request and leaves no partial file', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const downloader = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => {
      requests++;
      return fullResponse(f.bytes);
    },
    statSpace: async () => BigInt(f.bytes.length) + BigInt(PACK_SPACE_MARGIN) - 1n,
  });
  await assert.rejects(downloader.download(f.pack), /needs about .* MB free.*LaTeX resources/s);
  assert.equal(requests, 0);
  await assert.rejects(fs.access(path.join(f.downloads, f.pack.artifact.sha256, 'payload.part')));
});

test('sufficient free space allows the download to proceed and complete', async (t) => {
  const f = await fixture(t);
  const downloader = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => fullResponse(f.bytes),
    statSpace: async () => BigInt(f.bytes.length) + BigInt(PACK_SPACE_MARGIN),
  });
  const result = await downloader.download(f.pack);
  assert.equal(result.cached, false);
  assert.deepEqual(await fs.readFile(result.path), f.bytes);
});

test('a probe failure is reported as an actionable disk-space error without starting a request', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const downloader = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => {
      requests++;
      return fullResponse(f.bytes);
    },
    statSpace: async () => {
      throw new Error('synthetic statfs failure');
    },
  });
  await assert.rejects(downloader.download(f.pack), /could not check free disk space/);
  assert.equal(requests, 0);
});

test('required space accounts for retained partial bytes: a resumable download admits with less free space than a fresh one would need', async (t) => {
  const f = await fixture(t, Buffer.alloc(8192, 3));
  const root = path.join(f.downloads, f.pack.artifact.sha256);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'payload.part'), f.bytes.subarray(0, 6144));
  await fs.writeFile(
    path.join(root, 'resume.json'),
    JSON.stringify({
      sha256: f.pack.artifact.sha256,
      bytes: f.bytes.length,
      url: f.pack.artifact.url,
    }),
  );
  const remaining = f.bytes.length - 6144;
  const available = BigInt(remaining) + BigInt(PACK_SPACE_MARGIN);
  // This amount covers only the unretained remainder plus margin, well under
  // the full file size plus margin: proves retained bytes reduce the requirement.
  assert.ok(available < BigInt(f.bytes.length) + BigInt(PACK_SPACE_MARGIN));
  const resumer = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async (_url, init) => {
      assert.equal((init.headers as Record<string, string>).Range, 'bytes=6144-8191');
      return new Response(new Uint8Array(f.bytes.subarray(6144)), {
        status: 206,
        headers: { 'Content-Range': 'bytes 6144-8191/8192', ETag: '"same-content"' },
      });
    },
    statSpace: async () => available,
  });
  const result = await resumer.download(f.pack);
  assert.deepEqual(await fs.readFile(result.path), f.bytes);
});

test('a resumable download is still rejected when even the reduced remaining-bytes requirement is not met', async (t) => {
  const f = await fixture(t, Buffer.alloc(8192, 3));
  const root = path.join(f.downloads, f.pack.artifact.sha256);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'payload.part'), f.bytes.subarray(0, 6144));
  await fs.writeFile(
    path.join(root, 'resume.json'),
    JSON.stringify({
      sha256: f.pack.artifact.sha256,
      bytes: f.bytes.length,
      url: f.pack.artifact.url,
    }),
  );
  const remaining = f.bytes.length - 6144;
  let requests = 0;
  const resumer = new PackDownloads(f.downloads, ['packs.test'], {
    fetch: async () => {
      requests++;
      throw new Error('must not be called');
    },
    statSpace: async () => BigInt(remaining) + BigInt(PACK_SPACE_MARGIN) - 1n,
  });
  await assert.rejects(resumer.download(f.pack), /needs about .* MB free/);
  assert.equal(requests, 0);
  assert.equal(
    (await fs.stat(path.join(root, 'payload.part'))).size,
    6144,
    'retained partial bytes must survive a rejected admission check',
  );
});
