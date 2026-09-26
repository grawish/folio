import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { packFixture, hash } from './fixtures/resource-pack';
import { CatalogVerifier, requireVerifiedPack } from '../electron/core/pack-catalog';
import {
  publicationCatalog,
  fetchPublisherArtifact,
  type Publication,
} from '../scripts/lib/pack-publishing';

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-publisher-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = await packFixture(root);
  const source = Buffer.from('Complete original upstream source fixture.');
  const { id, title, description, base, target, packages } = f.pack;
  const publication: Publication = {
    schemaVersion: 1,
    packs: [
      {
        id,
        title,
        description,
        base,
        target,
        packages,
        artifact: {
          url: 'https://packs.test/pack.foliopack',
          bytes: f.built.archive.length,
          sha256: hash(f.built.archive),
        },
      },
    ],
    materials: [
      { url: 'https://packs.test/source.tar.gz', bytes: source.length, sha256: hash(source) },
    ],
  };
  let reads = 0;
  const options = {
    trust: { keys: { fixture: f.pem }, hosts: ['packs.test'], minimumSequence: 1 },
    keyId: 'fixture',
    privateKey: f.privateKey,
    publication,
    now: Date.parse('2026-09-26T00:00:00.000Z'),
    read: async (asset: { url: string }) => {
      reads++;
      return asset.url.endsWith('.foliopack') ? f.built.archive : source;
    },
  };
  return { ...f, options, reads: () => reads };
}

test('publisher verifies exact archives and companion materials before producing an app-readable catalog', async (t) => {
  const f = await fixture(t);
  const result = await publicationCatalog(f.options);
  assert.equal(f.reads(), 2);
  const catalog = new CatalogVerifier(f.options.trust.keys, ['packs.test']).verify(
    result.envelope,
    f.options.now,
  );
  assert.equal(catalog.sequence, 1);
  requireVerifiedPack(catalog.packs[0], f.options.now);
  assert.deepEqual(catalog.packs[0].target, f.pack.target);
  assert.equal(Date.parse(catalog.expiresAt) - f.options.now, 45 * 86400_000);
});

test('publisher refuses changed assets, archive metadata, unapproved hosts and wrong or retired signing keys', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    publicationCatalog({ ...f.options, read: async () => Buffer.from('changed') }),
    /size\/hash/,
  );
  const publication = structuredClone(f.options.publication);
  publication.packs[0] = { ...publication.packs[0], title: 'Not the archive title' };
  await assert.rejects(publicationCatalog({ ...f.options, publication }), /match/);
  publication.packs[0] = {
    ...publication.packs[0],
    artifact: { ...publication.packs[0].artifact, url: 'https://unapproved.test/pack' },
  };
  await assert.rejects(publicationCatalog({ ...f.options, publication }), /approved host/);
  await assert.rejects(
    publicationCatalog({ ...f.options, privateKey: generateKeyPairSync('ed25519').privateKey }),
    /signature/,
  );
  await assert.rejects(
    publicationCatalog({ ...f.options, trust: { ...f.options.trust, retiredKeys: ['fixture'] } }),
    /retired/,
  );
  const changedSource = {
    ...f.options,
    read: async (asset: { url: string }) =>
      asset.url.endsWith('.foliopack') ? f.built.archive : Buffer.from('changed source'),
  };
  await assert.rejects(publicationCatalog(changedSource), /size\/hash/);
});

test('publisher increments an authenticated expired catalog and refuses an untrusted rollback baseline', async (t) => {
  const f = await fixture(t);
  const first = await publicationCatalog(f.options);
  const next = await publicationCatalog({
    ...f.options,
    previous: first.envelope,
    now: f.options.now + 50 * 86400_000,
  });
  assert.equal(next.verified.sequence, 2);
  await assert.rejects(
    publicationCatalog({ ...f.options, previous: Buffer.from('{}') }),
    /structure/,
  );
  const floored = await publicationCatalog({
    ...f.options,
    previous: first.envelope,
    trust: { ...f.options.trust, minimumSequence: 10 },
  });
  assert.equal(floored.verified.sequence, 10);
});

test('publication reads reject cross-host redirects, oversized streams and HTTP failures', async (t) => {
  const asset = { url: 'https://packs.test/source', bytes: 4, sha256: '0'.repeat(64) };
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(null, { status: 302, headers: { location: 'https://unapproved.test/source' } }),
  );
  await assert.rejects(fetchPublisherArtifact(asset, ['packs.test']), /approved host/);
  fetchMock.mock.mockImplementation(async () => new Response('oversize'));
  await assert.rejects(fetchPublisherArtifact(asset, ['packs.test']), /pinned size/);
  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 404 }));
  await assert.rejects(fetchPublisherArtifact(asset, ['packs.test']), /HTTP 404/);
  fetchMock.mock.mockImplementation(async () => new Response('test'));
  assert.equal((await fetchPublisherArtifact(asset, ['packs.test'])).toString(), 'test');
});
