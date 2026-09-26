import { createHash, sign, type KeyObject } from 'node:crypto';
import {
  CATALOG_SIGNATURE_CONTEXT,
  CatalogVerifier,
  MAX_PACK_BYTES,
  packUrl,
  type PackArtifact,
  type CatalogPack,
} from '../../electron/core/pack-catalog';
import { ResourcePackVerifier } from '../../electron/core/resource-pack';
import type { PackTrust } from '../../electron/core/pack-service';

export type Publication = {
  schemaVersion: 1;
  packs: CatalogPack[];
  materials: PackArtifact[];
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function publicationCatalog(options: {
  trust: PackTrust;
  keyId: string;
  privateKey: KeyObject;
  publication: Publication;
  previous?: Uint8Array;
  now?: number;
  read(artifact: PackArtifact): Promise<Uint8Array>;
}) {
  const { trust, publication } = options;
  const now = options.now ?? Date.now();
  const verifier = new CatalogVerifier(
    trust.keys,
    trust.hosts,
    trust.minimumSequence,
    trust.retiredKeys,
  );
  const previous = options.previous ? verifier.verify(options.previous, now, true) : undefined;
  if (
    publication.schemaVersion !== 1 ||
    Object.keys(publication).sort().join(',') !== 'materials,packs,schemaVersion' ||
    !Array.isArray(publication.materials) ||
    publication.materials.length > 512
  )
    throw new Error('Invalid published-pack inventory.');
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      sequence: Math.max((previous?.sequence ?? 0) + 1, trust.minimumSequence),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 45 * 86400_000).toISOString(),
      packs: publication.packs,
    }),
  );
  const envelope = Buffer.from(
    JSON.stringify(
      {
        keyId: options.keyId,
        payload: payload.toString('base64'),
        signature: sign(
          null,
          Buffer.concat([Buffer.from(CATALOG_SIGNATURE_CONTEXT), payload]),
          options.privateKey,
        ).toString('base64'),
      },
      null,
      2,
    ) + '\n',
  );
  // Validate with the app's verifier before any network request or publication.
  const verified = verifier.verify(envelope, now);
  const archiveVerifier = new ResourcePackVerifier(trust.keys, trust.retiredKeys);
  const assets = [...verified.packs.map((p) => p.artifact), ...publication.materials];
  let total = 0;
  const urls = new Set<string>();
  for (const asset of assets) {
    if (
      !asset ||
      Object.keys(asset).sort().join(',') !== 'bytes,sha256,url' ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      asset.bytes > MAX_PACK_BYTES ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      urls.has(asset.url)
    )
      throw new Error('Invalid or duplicate published asset.');
    packUrl(asset.url, new Set(trust.hosts));
    urls.add(asset.url);
    total += asset.bytes;
  }
  if (total > 256 * 1024 * 1024)
    throw new Error('Published inventory exceeds the transfer budget.');
  for (const asset of assets) {
    const bytes = await options.read(asset);
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256)
      throw new Error(`Published asset failed its size/hash check: ${asset.url}`);
    const pack = verified.packs.find((p) => p.artifact.url === asset.url);
    if (pack) archiveVerifier.read(bytes, pack);
  }
  return { envelope, verified };
}

export async function fetchPublisherArtifact(asset: PackArtifact, hosts: readonly string[]) {
  const allowed = new Set(hosts);
  let url = packUrl(asset.url, allowed);
  const signal = AbortSignal.timeout(90_000);
  for (let attempt = 0; attempt <= 5; attempt++) {
    const response = await fetch(url, {
      signal,
      redirect: 'manual',
      credentials: 'omit',
      headers: { 'Accept-Encoding': 'identity' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || attempt === 5) throw new Error('Published asset redirected too many times.');
      url = packUrl(new URL(location, url).href, allowed);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`Published asset returned HTTP ${response.status}.`);
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > asset.bytes) throw new Error('Published asset exceeds its pinned size.');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Published asset could not be read.');
}
