import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyRuntime } from '../electron/core/runtime';
import { assembleResourcePack, ResourcePackVerifier } from '../electron/core/resource-pack';
import { fetchPublisherArtifact } from './lib/pack-publishing';
import { packTrust } from '../electron/core/pack-trust';

// Fail before packaging if a freshly prepared runtime cannot use the same
// public pack exercised by the native catalog workflow. Keep exact identities.
const root = path.resolve(process.argv[2] ?? 'resources/runtime/mac-arm64');
const publication = JSON.parse(await fs.readFile('resources/packs/published.json', 'utf8'));
const pack = publication.packs.find((row: { id: string }) => row.id === 'folio-multirow-2.9-v1');
assert.ok(pack, 'The published table pack is missing.');
const { pin, manifest } = await verifyRuntime(root);
assert.deepEqual(pin, pack.base, 'Prepared compiler does not match the published pack base.');
const archive = process.argv[3]
  ? await fs.readFile(process.argv[3])
  : await fetchPublisherArtifact(pack.artifact, packTrust.hosts);
assert.equal(archive.length, pack.artifact.bytes);
assert.equal(createHash('sha256').update(archive).digest('hex'), pack.artifact.sha256);
const verified = new ResourcePackVerifier(packTrust.keys, packTrust.retiredKeys).read(archive);
assert.deepEqual(verified.base, pack.base);
assert.deepEqual(verified.target, pack.target);
// The v1 assembly also consumes core notices outside the base file inventory.
// Authenticate the original pack and reproduce its exact target before release.
const assembly = await assembleResourcePack(verified, root);
await fs.mkdir('test-results', { recursive: true });
await fs.writeFile(
  'test-results/published-pack-base.json',
  JSON.stringify(
    {
      passed: true,
      pack: pack.id,
      pin,
      target: assembly.pin,
      signatureVerified: true,
      archiveSha256: verified.archiveSha256,
      coreNoticesSha256: createHash('sha256')
        .update(await fs.readFile(path.join(root, 'THIRD_PARTY_NOTICES.md')))
        .digest('hex'),
      filesVerified: Object.keys(manifest.files).length,
      manifestSha256: createHash('sha256')
        .update(await fs.readFile(path.join(root, 'manifest.json')))
        .digest('hex'),
      scope:
        'Exact included runtime inventory, original signed public pack and assembled target; no signature or UI bypass.',
    },
    null,
    2,
  ) + '\n',
);
console.log(`PASS: verified runtime ${pin.id} assembles the signed table pack ${assembly.pin.id}.`);
