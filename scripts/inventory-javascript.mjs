import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build as viteBuild } from 'vite';
import { extractFile, listPackage } from '@electron/asar';
import { tsImport } from 'tsx/esm/api';
import { buildElectron } from './build-electron.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (!process.argv[2]?.endsWith('.app'))
  throw new Error('Provide the exact packaged Folio.app to inspect.');
const app = path.resolve(process.argv[2]);
const asar = path.join(app, 'Contents/Resources/app.asar');
const before = hash(await fs.readFile(asar));
const pkg = JSON.parse(extractFile(asar, 'package.json').toString());
if (pkg.name !== 'folio-resume-maker') throw new Error('The selected app is not Folio.');
const { inventoryJavaScriptReplay, javascriptBom } = await tsImport(
  './javascript-bundle-inventory.ts',
  import.meta.url,
);
const electron = await buildElectron({ collectMetadata: true, write: false });
const renderer = await viteBuild({ logLevel: 'error', build: { write: false } });
const result = await inventoryJavaScriptReplay({
  root: process.cwd(),
  asarMembers: listPackage(asar),
  readAsar: (file) => extractFile(asar, file),
  electron,
  renderer: Array.isArray(renderer) ? renderer : [renderer],
});
if (before !== hash(await fs.readFile(asar))) throw new Error('The app changed during inventory.');
const inputs = await Promise.all(
  [
    'scripts/inventory-javascript.mjs',
    'scripts/javascript-bundle-inventory.ts',
    'scripts/build-electron.mjs',
    'vite.config.ts',
    'package.json',
    'package-lock.json',
  ].map(async (file) => ({ file, sha256: hash(await fs.readFile(file)) })),
);
const record = {
  ...result,
  application: { name: pkg.name, version: pkg.version, appAsarSha256: before },
  inputs,
};
const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
const out = path.resolve('artifacts/license-materials/javascript', hash(bytes));
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'inventory.json'), bytes);
const { validateBundleBom } = await tsImport('./mac-app-inventory.ts', import.meta.url);
const bom = javascriptBom(record, pkg.version, before);
await validateBundleBom(bom);
const bomBytes = Buffer.from(JSON.stringify(bom, null, 2) + '\n');
await fs.writeFile(path.join(out, 'javascript.cdx.json'), bomBytes);
await fs.writeFile(
  path.join(out, 'summary.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      appAsarSha256: before,
      inventorySha256: hash(bytes),
      bomSha256: hash(bomBytes),
      packagedJavaScriptAndMaps: record.packagedJavaScriptAndMaps.length,
      reproducedOutputs: record.reproducedOutputs.length,
      sourceModules: record.modules.length,
      runtimePackages: record.packages.filter((p) => p.roles.some((r) => r !== 'generator')).length,
      generators: record.packages.filter((p) => p.roles.includes('generator')).length,
      completeBinarySbom: false,
    },
    null,
    2,
  ) + '\n',
);

await fs.mkdir('test-results', { recursive: true });
await fs.writeFile(
  'test-results/javascript-inventory-location.json',
  JSON.stringify({ root: out }, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    {
      output: out,
      appAsarSha256: before,
      packagedJavaScriptAndMaps: record.packagedJavaScriptAndMaps,
      reproducedOutputs: record.reproducedOutputs.length,
      modules: record.modules.length,
      packages: record.packages.map((p) => ({
        name: p.name,
        version: p.version,
        roles: p.roles,
        markedDevInNpmLock: p.markedDevInNpmLock,
      })),
      completeBinarySbom: false,
    },
    null,
    2,
  ),
);
