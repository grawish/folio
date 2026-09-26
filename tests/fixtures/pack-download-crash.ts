import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CatalogVerifier } from '../../electron/core/pack-catalog';
import { PackDownloads } from '../../electron/core/pack-download';
const [fixture, storage, origin, phase] = process.argv.slice(2);
const key = await fs.readFile(path.join(fixture, 'key.pem'), 'utf8');
const catalog = new CatalogVerifier({ 'test-publisher': key }, ['packs.test']).verify(
  await fs.readFile(path.join(fixture, 'catalog.json')),
);
await new PackDownloads(storage, ['packs.test'], {
  fetch: (url, init) => fetch(origin + new URL(url).pathname, init),
  checkpoint: async (boundary) => {
    if (boundary === phase) {
      console.log('READY-TO-KILL');
      await new Promise(() => setInterval(() => {}, 60000));
    }
  },
}).download(catalog.packs[0]);
