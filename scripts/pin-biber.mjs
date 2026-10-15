// Records reviewed SHA-256 digests for the upstream Biber archives that have
// none yet. Run once by a maintainer (or the "Pin Biber archives" workflow);
// commit the resulting runtime-config.mjs change after checking the output.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { biberArchives } from './runtime-config.mjs';

const config = new URL('./runtime-config.mjs', import.meta.url);
let source = await fs.readFile(config, 'utf8');
const pinned = [];
for (const [platform, spec] of Object.entries(biberArchives)) {
  if (spec.hash) continue;
  console.log(`Downloading ${spec.url}…`);
  const response = await fetch(spec.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${spec.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1024 * 1024 || bytes.length > 256 * 1024 * 1024)
    throw new Error(`${spec.url}: unexpected size ${bytes.length}`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const marker = `archive: '${spec.archive}',\n    hash: null,`;
  if (!source.includes(marker)) throw new Error(`Cannot find the ${platform} entry.`);
  source = source.replace(marker, `archive: '${spec.archive}',\n    hash: '${digest}',`);
  pinned.push(`${platform}  ${spec.archive}  ${bytes.length} bytes  sha256 ${digest}`);
}
await fs.writeFile(config, source);
console.log(pinned.length ? pinned.join('\n') : 'Every Biber archive is already pinned.');
