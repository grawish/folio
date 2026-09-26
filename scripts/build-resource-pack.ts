import { constants, promises as fs } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import path from 'node:path';
import { buildResourcePack, ResourcePackVerifier } from '../electron/core/resource-pack';
import { resourceName } from '../electron/core/pack-resource-name';
import { runtimeFile } from '../electron/core/runtime';

const [recipeArg, baseArg, keyArg, outputArg, ...extra] = process.argv.slice(2);
if (!recipeArg || !baseArg || !keyArg || !outputArg || extra.length)
  throw new Error(
    'Usage: node --import tsx scripts/build-resource-pack.ts recipe.json base-runtime private-key.pem output.foliopack',
  );
const recipePath = path.resolve(recipeArg);
const root = await fs.realpath(path.dirname(recipePath));
const recipe = JSON.parse(
  (await runtimeFile(root, path.basename(recipePath), 64 * 1024)).toString('utf8'),
);
const fields = ['id', 'title', 'description', 'bundle', 'packages', 'keyId'];
if (
  !recipe ||
  typeof recipe !== 'object' ||
  Array.isArray(recipe) ||
  Object.keys(recipe).length !== fields.length ||
  fields.some((key) => !Object.hasOwn(recipe, key))
)
  throw new Error(
    'The recipe must contain exactly id, title, description, bundle, packages and keyId.',
  );
const resourcesRoot = path.join(root, 'resources');
if (
  !(await fs.lstat(resourcesRoot)).isDirectory() ||
  (await fs.realpath(resourcesRoot)) !== resourcesRoot
)
  throw new Error('The resource folder must not be a link.');
const entries = await fs.readdir(resourcesRoot, { withFileTypes: true });
if (!entries.length || entries.length > 512) throw new Error('Provide 1–512 resource files.');
const resources = new Map<string, Buffer>();
let total = 0;
for (const entry of entries) {
  if (!entry.isFile())
    throw new Error('Resources must be regular files without subfolders or links.');
  const name = resourceName(entry.name);
  const data = await runtimeFile(resourcesRoot, name, 20 * 1024 * 1024);
  total += data.length;
  if (total > 120 * 1024 * 1024) throw new Error('Publisher resources exceed 120 MiB.');
  resources.set(name, data);
}
const keyPath = path.resolve(keyArg);
const keyRoot = await fs.realpath(path.dirname(keyPath));
const privateKey = createPrivateKey(await runtimeFile(keyRoot, path.basename(keyPath), 16 * 1024));
const result = await buildResourcePack({
  ...recipe,
  baseRoot: await fs.realpath(baseArg),
  resources,
  notices: new TextDecoder('utf-8', { fatal: true }).decode(
    await runtimeFile(root, 'NOTICES.txt', 4 * 1024 * 1024),
  ),
  probe: new TextDecoder('utf-8', { fatal: true }).decode(
    await runtimeFile(root, 'probe.tex', 256 * 1024),
  ),
  privateKey,
});
const verified = new ResourcePackVerifier({
  [recipe.keyId]: createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString(),
}).read(result.archive);
// Never overwrite an earlier published artifact or print private key material.
const output = await fs.open(
  path.resolve(outputArg),
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
  0o600,
);
try {
  await output.writeFile(result.archive);
  await output.sync();
} finally {
  await output.close();
}
console.log(JSON.stringify(verified, null, 2));
