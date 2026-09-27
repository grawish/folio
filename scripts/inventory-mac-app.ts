import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractFile } from '@electron/asar';
import {
  inventoryBundle,
  bundleBom,
  validateBundleBom,
  jsonBytes,
  sha256,
} from './mac-app-inventory';

if (process.platform !== 'darwin' || !process.argv[2])
  throw new Error('Provide a packaged Folio.app directory on macOS.');
const app = path.resolve(process.argv[2]);
if (!app.endsWith('.app')) throw new Error('Choose the Folio.app directory.');
const inventory = await inventoryBundle(app);
const entries = new Map(inventory.entries.map((row) => [row.path, row]));
const asarRelative = 'Contents/Resources/app.asar';
const infoRelative = 'Contents/Info.plist';
const runtimeRelative = 'Contents/Resources/runtime/manifest.json';
const asar = path.join(app, asarRelative);
for (const name of [asarRelative, infoRelative, runtimeRelative]) {
  const entry = entries.get(name);
  if (entry?.kind !== 'file' || entry.bytes! > 128 * 1024 * 1024)
    throw new Error('Missing or oversized Folio identity metadata.');
}
const anchors = Object.fromEntries(
  await Promise.all(
    [asarRelative, infoRelative, runtimeRelative].map(async (name) => [
      name,
      await fs.readFile(path.join(app, name)),
    ]),
  ),
);
const pkg = JSON.parse(extractFile(asar, 'package.json').toString());
const info = JSON.parse(
  execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: anchors[infoRelative],
    encoding: 'utf8',
  }),
);
if (
  pkg.name !== 'folio-resume-maker' ||
  typeof pkg.version !== 'string' ||
  info.CFBundleIdentifier !== 'app.folio.resume'
)
  throw new Error('The selected bundle does not identify itself as Folio.');
const architecture = execFileSync(
  '/usr/bin/lipo',
  ['-archs', path.join(app, 'Contents/MacOS/Folio')],
  { encoding: 'utf8' },
).trim();
if (architecture !== 'arm64') throw new Error('Expected an Apple silicon Folio executable.');
const runtime = JSON.parse(anchors[runtimeRelative].toString());
if (
  runtime.schemaVersion !== 1 ||
  runtime.platform !== 'darwin-arm64' ||
  !runtime.files ||
  typeof runtime.files !== 'object' ||
  Array.isArray(runtime.files) ||
  ['tectonic', 'biber', 'bundle.zip'].some((name) => !Object.hasOwn(runtime.files, name))
)
  throw new Error('Expected the packaged Apple silicon runtime manifest.');
for (const [name, bytes] of Object.entries(anchors))
  if (entries.get(name)?.sha256 !== sha256(bytes))
    throw new Error('Packaged identity metadata changed while being inventoried.');
for (const [name, digest] of Object.entries(runtime.files)) {
  if (
    typeof digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    name.split('/').some((part) => !part || part === '.' || part === '..') ||
    name.includes('\\') ||
    entries.get(`Contents/Resources/runtime/${name}`)?.sha256 !== digest
  )
    throw new Error(`A packaged runtime file differs from its manifest: ${name}`);
}
const bom = bundleBom(inventory, 'Folio', pkg.version);
await validateBundleBom(bom);
const inventoryBytes = jsonBytes(inventory);
const bomBytes = jsonBytes(bom);
const digest = sha256(inventoryBytes);
const output = path.resolve('artifacts/license-materials/mac-app', digest);
await fs.mkdir(output, { recursive: true });
const report = {
  schemaVersion: 1,
  application: {
    name: 'Folio',
    version: pkg.version,
    bundleIdentifier: info.CFBundleIdentifier,
    architecture,
  },
  appAsarSha256: sha256(anchors[asarRelative]),
  runtimeManifestSha256: sha256(anchors[runtimeRelative]),
  runtimeFilesVerified: Object.keys(runtime.files).length,
  regularFiles: inventory.regularFiles,
  directories: inventory.directories,
  symlinks: inventory.symlinks,
  logicalFileBytes: inventory.logicalFileBytes,
  records: [
    { path: 'bundle-inventory.json', bytes: inventoryBytes.length, sha256: digest },
    { path: 'bundle.cdx.json', bytes: bomBytes.length, sha256: sha256(bomBytes) },
  ],
  schemaValidation: 'Official pinned CycloneDX 1.6 JSON schema, including formats; offline.',
  componentMappingComplete: false,
  releaseAuditComplete: false,
  limits: [
    'Inventory of physical regular files, directories, POSIX modes and internal symbolic links in this exact local app.',
    'Embedded ASAR/ZIP/PAR members, linked dependencies and per-component license/source mappings remain incomplete.',
    'No extended attributes, ACLs, resource forks, code-signature/notarization validation, disk image or unique physical disk-size claim.',
    'Before/after metadata checks detect ordinary concurrent changes; this is not an atomic filesystem snapshot or a hostile-mutation sandbox.',
  ],
};
for (const [name, bytes] of [
  ['bundle-inventory.json', inventoryBytes],
  ['bundle.cdx.json', bomBytes],
  ['summary.json', jsonBytes(report)],
] as const)
  await fs.writeFile(path.join(output, name), bytes);
console.log(JSON.stringify({ output, ...report }, null, 2));
