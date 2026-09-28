import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractFile } from '@electron/asar';
import { macReleaseSuites } from './mac-release-suites.mjs';
import { tsImport } from 'tsx/esm/api';

const [releaseArg, ...flags] = process.argv.slice(2);
if (
  flags.some((flag) => !['--allow-ad-hoc-test', '--distribution'].includes(flag)) ||
  (flags.includes('--distribution') && flags.includes('--allow-ad-hoc-test'))
)
  throw new Error('Choose ordinary verification, --allow-ad-hoc-test, or --distribution.');
const distribution = flags.includes('--distribution');
const release = path.resolve(releaseArg ?? 'release/import-recovery');
// A failed rerun must not leave a previous success looking like current evidence.
await fs.writeFile(
  path.join(release, 'verification.json'),
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    passed: false,
    distributionVerified: false,
  }) + '\n',
);
const app = path.join(release, 'mac-arm64/Folio.app');
const asar = path.join(app, 'Contents/Resources/app.asar');
const iconName = execFileSync(
  '/usr/bin/plutil',
  ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')],
  { encoding: 'utf8' },
).trim();
if (iconName !== 'icon.icns') throw new Error('The Mac app does not select the Folio icon.');
const iconBytes = await fs.readFile(path.join(app, 'Contents/Resources', iconName));
if (!iconBytes.equals(await fs.readFile('resources/branding/folio.icns')))
  throw new Error('The packaged Folio icon differs from the reviewed source.');
const appIcon = {
  file: iconName,
  bytes: iconBytes.length,
  sha256: createHash('sha256').update(iconBytes).digest('hex'),
};
const { verifyTexFontNotices, verifyTexResourceNotices } = await tsImport(
  './verify-tex-font-notices.ts',
  import.meta.url,
);
const texFontNotices = await verifyTexFontNotices(
  path.join(app, 'Contents/Resources/tex-font-notices'),
);
const texResourceNotices = await verifyTexResourceNotices(
  path.join(app, 'Contents/Resources/tex-resource-notices'),
);
const { verifyNpmNotices } = await tsImport('./verify-npm-notices.ts', import.meta.url);
const npmNotices = await verifyNpmNotices(path.join(app, 'Contents/Resources/npm-notices'));
const { verifyPdfjsNotices } = await tsImport('./verify-pdfjs-notices.ts', import.meta.url);
const pdfjsNotices = await verifyPdfjsNotices(path.join(app, 'Contents/Resources/pdfjs-notices'));
const { verifyElectronNotices } = await tsImport('./electron-notices.ts', import.meta.url);
const electronNotices = await verifyElectronNotices(
  path.join(app, 'Contents/Resources/electron-notices'),
);
const { verifyTectonicNotices } = await tsImport('./tectonic-notices.ts', import.meta.url);
const tectonicNotices = await verifyTectonicNotices(
  path.join(app, 'Contents/Resources/tectonic-notices'),
);
const { verifyBiberNotices } = await tsImport('./biber-notices.ts', import.meta.url);
const biberNotices = await verifyBiberNotices(path.join(app, 'Contents/Resources/biber-notices'));
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
const runtimeManifestMatches = manifest.equals(
  await fs.readFile('resources/runtime/mac-arm64/manifest.json'),
);
let signing;
try {
  const record = JSON.parse(
    await fs.readFile(path.join(release, 'mac-arm64/runtime-signing.json'), 'utf8'),
  );
  const { verifySignedRuntime } = await tsImport('./verify-signed-runtime.ts', import.meta.url);
  signing = await verifySignedRuntime(app, path.resolve('resources/runtime/mac-arm64'), record, {
    allowAdHocTest: process.argv.includes('--allow-ad-hoc-test'),
    expectedTeamId: process.env.FOLIO_APPLE_TEAM_ID,
  });
} catch (error) {
  // Only absence of the sidecar allows the original unsigned verification path.
  // Missing files/errors within signature verification must still fail closed.
  if (
    error.code !== 'ENOENT' ||
    error.path !== path.join(release, 'mac-arm64/runtime-signing.json')
  )
    throw error;
}
if (!signing && !runtimeManifestMatches) throw new Error('The packaged runtime manifest differs.');
if (JSON.parse(manifest).platform !== 'darwin-arm64') throw new Error('Wrong runtime platform.');
let appBytes = 0;
for (const name of await files(app)) appBytes += (await fs.stat(name)).size;
const dmgNames = (await fs.readdir(release)).filter((name) => name.endsWith('-mac-arm64.dmg'));
if (dmgNames.length !== 1) throw new Error('Expected one Apple silicon disk image.');
const zipNames = (await fs.readdir(release)).filter((name) => name.endsWith('-mac-arm64.zip'));
if (zipNames.length !== 1) throw new Error('Expected one Apple silicon application ZIP.');
const { archiveDigest, verifyMacArchives } = await tsImport(
  './verify-mac-archives.ts',
  import.meta.url,
);
const hashes = [];
for (const name of [path.join(release, dmgNames[0]), asar, path.join(release, zipNames[0])])
  hashes.push({
    path: path.relative(release, name),
    ...(await archiveDigest(name)),
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
  const { qualificationIdentity } = await tsImport('./mac-qualification.ts', import.meta.url);
  const actualIdentity = await qualificationIdentity(app);
  if (JSON.stringify(nativeTests.bundleIdentity) !== JSON.stringify(actualIdentity))
    throw new Error(
      'Native qualification belongs to a different app inventory or predates full-app binding.',
    );
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
if (
  distribution &&
  (!nativeTests?.passed || signing?.mode !== 'distribution' || !signing?.developerIdVerified)
)
  throw new Error(
    'Distribution requires Developer ID signing and complete native qualification of this exact app.',
  );
const archives = await verifyMacArchives(
  app,
  path.join(release, dmgNames[0]),
  path.join(release, zipNames[0]),
  distribution ? { distributionTeamId: process.env.FOLIO_APPLE_TEAM_ID } : {},
);
if (archives.dmg.sha256 !== hashes[0].sha256 || archives.zip.sha256 !== hashes[2].sha256)
  throw new Error('A distribution archive changed during verification.');
const result = {
  passed: true,
  checkedAt: new Date().toISOString(),
  architecture,
  appIcon,
  comparedOutputFiles: outputs.length,
  runtimeManifestMatches,
  texFontNotices,
  texResourceNotices,
  npmNotices,
  pdfjsNotices,
  electronNotices,
  tectonicNotices,
  biberNotices,
  ...(signing ? { signing } : {}),
  appBytes,
  hashes,
  archives,
  distributionVerified: distribution && archives.distributionVerified,
  nativeTestsPassed: nativeTests?.passed ?? false,
};
await fs.writeFile(
  path.join(release, 'SHA256SUMS'),
  hashes.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n',
);
await fs.writeFile(path.join(release, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
