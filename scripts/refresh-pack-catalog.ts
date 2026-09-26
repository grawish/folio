import { promises as fs } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import path from 'node:path';
import { publicationCatalog, fetchPublisherArtifact } from './lib/pack-publishing';
import { runtimeFile } from '../electron/core/runtime';
import { savePackFile, packFile } from '../electron/core/pack-io';

const [keyArg, ...flags] = process.argv.slice(2);
if (!keyArg || flags.some((x) => x !== '--check'))
  throw new Error(
    'Usage: node --import tsx scripts/refresh-pack-catalog.ts private-key.pem [--check]',
  );
const root = path.resolve('resources/packs');
const trust = JSON.parse(await fs.readFile('resources/pack-publisher.json', 'utf8'));
const publicationBytes = await runtimeFile(root, 'published.json', 1024 * 1024);
const publication = JSON.parse(publicationBytes.toString('utf8'));
const previous = await packFile(root, 'catalog.json', 2 * 1024 * 1024);
const keyPath = path.resolve(keyArg);
const key = createPrivateKey(
  await runtimeFile(await fs.realpath(path.dirname(keyPath)), path.basename(keyPath), 16 * 1024),
);
const active = Object.keys(trust.keys).filter((id) => !trust.retiredKeys?.includes(id));
if (active.length !== 1) throw new Error('Catalog publishing requires exactly one active key.');
const result = await publicationCatalog({
  trust,
  keyId: active[0],
  privateKey: key,
  publication,
  previous: previous ?? undefined,
  read: (asset) => fetchPublisherArtifact(asset, trust.hosts),
});
if (
  !(await runtimeFile(root, 'published.json', 1024 * 1024)).equals(publicationBytes) ||
  !((await packFile(root, 'catalog.json', 2 * 1024 * 1024)) ?? Buffer.alloc(0)).equals(
    previous ?? Buffer.alloc(0),
  )
)
  throw new Error('Publisher inputs changed. Retry from the current checkout.');
if (!flags.includes('--check')) await savePackFile(root, 'catalog.json', result.envelope);
console.log(
  JSON.stringify(
    {
      sequence: result.verified.sequence,
      expiresAt: result.verified.expiresAt,
      packs: result.verified.packs.length,
      wroteCatalog: !flags.includes('--check'),
    },
    null,
    2,
  ),
);
