import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { packTrust } from '../electron/core/pack-trust';
import { CatalogVerifier } from '../electron/core/pack-catalog';
import { PackDownloads } from '../electron/core/pack-download';
import { ResourcePackVerifier } from '../electron/core/resource-pack';

// This acceptance check uses the ordinary app trust and real HTTPS transport.
// It never generates a key, substitutes a response or changes the application.
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/public-pack-transfer-'));
assert.ok(packTrust.catalogUrl);
const response = await fetch(packTrust.catalogUrl, {
  signal: AbortSignal.timeout(30_000),
  redirect: 'error',
});
assert.equal(response.status, 200);
const catalogBytes = new Uint8Array(await response.arrayBuffer());
const catalog = new CatalogVerifier(
  packTrust.keys,
  packTrust.hosts,
  packTrust.minimumSequence,
  packTrust.retiredKeys,
).verify(catalogBytes);
const pack = catalog.packs.find((p) => p.id === 'folio-multirow-2.9-v1');
assert.ok(pack);
const controller = new AbortController();
const requests: {
  host: string;
  range: string | null;
  status: number;
  contentRange: string | null;
}[] = [];
const downloads = new PackDownloads(path.join(root, 'downloads'), packTrust.hosts, {
  // Observe only host/range/status, never release-asset signed URL query strings.
  fetch: async (url, init) => {
    const response = await fetch(url, init);
    requests.push({
      host: new URL(url).hostname,
      range: new Headers(init.headers).get('Range'),
      status: response.status,
      contentRange: response.headers.get('Content-Range'),
    });
    return response;
  },
});
let cancelledAt = 0;
await assert.rejects(
  downloads.download(pack, {
    signal: controller.signal,
    progress: (p) => {
      if (p.received > 0 && p.received < p.total && !controller.signal.aborted) {
        cancelledAt = p.received;
        controller.abort(new Error('Acceptance check: deliberate partial-transfer cancellation'));
      }
    },
  }),
);
assert.ok(cancelledAt > 0 && cancelledAt < pack.artifact.bytes);
const saved = await downloads.cachedBytes(pack);
assert.equal(saved, cancelledAt);
const completed = await downloads.download(pack);
const bytes = await fs.readFile(completed.path);
assert.equal(createHash('sha256').update(bytes).digest('hex'), pack.artifact.sha256);
new ResourcePackVerifier(packTrust.keys, packTrust.retiredKeys).read(bytes, pack);
assert.ok(requests.some((r) => r.range?.startsWith(`bytes=${cancelledAt}-`) && r.status === 206));
const record = {
  passed: true,
  catalogSequence: catalog.sequence,
  catalogSha256: createHash('sha256').update(catalogBytes).digest('hex'),
  artifact: pack.artifact,
  cancelledAt,
  requests,
  signatureVerified: true,
  scope:
    'Ordinary app trust, public HTTPS, actual cancellation and HTTP 206 resume; no transport fixtures.',
};
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(record, null, 2) + '\n');
console.log(
  `PASS: public catalog, partial cancellation, HTTP 206 resume, full hash and publisher signature.\nEvidence: ${root}`,
);
