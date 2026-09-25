import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extractFile } from '@electron/asar';
import { macReleaseSuites } from './mac-release-suites.mjs';

const release = path.resolve(process.argv[2] ?? 'release/import-recovery');
const app = path.join(release, 'mac-arm64/Folio.app');
const asar = path.join(app, 'Contents/Resources/app.asar');
const architecture = execFileSync(
  '/usr/bin/lipo',
  ['-archs', path.join(app, 'Contents/MacOS/Folio')],
  { encoding: 'utf8' },
).trim();
if (architecture !== 'arm64')
  throw new Error(`Expected an Apple silicon app, got ${architecture}.`);
async function files(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(name)));
    else if (entry.isFile()) found.push(name);
  }
  return found;
}
const outputs = [...(await files('dist')), ...(await files('dist-electron'))];
for (const name of outputs)
  if (!Buffer.from(extractFile(asar, name)).equals(await fs.readFile(name)))
    throw new Error(`Packaged output differs: ${name}`);
const manifest = await fs.readFile(path.join(app, 'Contents/Resources/runtime/manifest.json'));
if (!manifest.equals(await fs.readFile('resources/runtime/mac-arm64/manifest.json')))
  throw new Error('The packaged runtime manifest differs.');
if (JSON.parse(manifest).platform !== 'darwin-arm64') throw new Error('Wrong runtime platform.');
let appBytes = 0;
for (const name of await files(app)) appBytes += (await fs.stat(name)).size;
const dmgNames = (await fs.readdir(release)).filter((name) => name.endsWith('-mac-arm64.dmg'));
if (dmgNames.length !== 1) throw new Error('Expected one Apple silicon disk image.');
const hashes = [];
for (const name of [path.join(release, dmgNames[0]), asar])
  hashes.push({
    path: path.relative(release, name),
    bytes: (await fs.stat(name)).size,
    sha256: createHash('sha256')
      .update(await fs.readFile(name))
      .digest('hex'),
  });
const diskCheck = execFileSync('/usr/bin/hdiutil', ['verify', path.join(release, dmgNames[0])], {
  encoding: 'utf8',
});
await fs.writeFile(path.join(release, 'disk-image-verification.log'), diskCheck);
let nativeTests;
try {
  nativeTests = JSON.parse(await fs.readFile(path.join(release, 'native-tests.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (nativeTests) {
  const expected = macReleaseSuites;
  if (
    nativeTests.passed !== true ||
    nativeTests.asarSha256 !== hashes[1].sha256 ||
    !Array.isArray(nativeTests.suites) ||
    nativeTests.suites.length !== expected.length ||
    nativeTests.suites.some(
      (suite, index) =>
        suite.suite !== expected[index] ||
        suite.passed !== true ||
        suite.code !== 0 ||
        suite.unchanged !== true,
    )
  )
    throw new Error('Native qualification is incomplete or belongs to a different app.');
}
const result = {
  checkedAt: new Date().toISOString(),
  architecture,
  comparedOutputFiles: outputs.length,
  runtimeManifestMatches: true,
  appBytes,
  hashes,
  nativeTestsPassed: nativeTests?.passed ?? false,
};
await fs.writeFile(
  path.join(release, 'SHA256SUMS'),
  hashes.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n',
);
await fs.writeFile(path.join(release, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
