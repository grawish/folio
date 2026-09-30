/** Preparatory, source-reachable materials for an *unsigned candidate* Folio.app build
 * (LIC-04/LIC-05 prep). This is NOT the final signed-release SBOM: it never inspects a
 * DMG/ZIP/source archive or published third-party bundle, and it never asserts that any
 * component's redistribution grant, corresponding-source obligation or build reproduction
 * has been reviewed. Every fact recorded here is either read directly from the exact local
 * candidate app or cross-referenced against an existing, unmodified license-materials lock;
 * anything that cannot be verified this way fails closed instead of being inferred. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { extractFile } from '@electron/asar';
import { inventoryBundle, jsonBytes, sha256 } from './mac-app-inventory';

const execute = promisify(execFile);

export type BundleLock = { schemaVersion: 1; files: Record<string, string> };
export type TexSourceLock = {
  schemaVersion: 1;
  bundleLockSha256: string;
  fontLockSha256?: string;
  sources: Array<{
    id: string;
    declaredLicense?: string;
    matches: Array<{ bundle: string; source: string; sha256: string }>;
  }>;
  unmatchedResources?: Array<{ file: string; sha256: string; reason: string }>;
};

/** Reject anything other than the exact ad-hoc, unteamed signature every local development
 * build carries. A real Developer ID / distribution signature belongs to the separate,
 * currently-blocked signed-release pipeline, not this unsigned-candidate collector. */
export function parseCodesignIdentity(codesignStderr: string) {
  const identifier = /^Identifier=(.+)$/m.exec(codesignStderr)?.[1];
  const signature = /^Signature=(.+)$/m.exec(codesignStderr)?.[1];
  const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(codesignStderr)?.[1];
  if (!identifier || !signature || !teamIdentifier)
    throw new Error('Could not parse a complete codesign identity report.');
  if (signature !== 'adhoc' || teamIdentifier !== 'not set')
    throw new Error(
      'This collector only covers an unsigned candidate build; the selected app already ' +
        'carries a distribution signature, which belongs to the separate signed-release materials pipeline.',
    );
  return { identifier, signature, teamIdentifier };
}

/** Unzip the exact embedded TeX resource bundle with the real macOS tool (no partial
 * central-directory parsing of our own) and require every entry to equal the reviewed
 * bundle lock byte-for-byte. Only the upstream-published SHA256SUM checksum file may be
 * present alongside the locked members; anything else fails closed. */
export async function verifyEmbeddedTexBundle(bundleZipBytes: Buffer, lock: BundleLock) {
  if (lock.schemaVersion !== 1 || !lock.files || typeof lock.files !== 'object')
    throw new Error('Unsupported TeX bundle lock schema.');
  const names = Object.keys(lock.files);
  if (names.length === 0) throw new Error('The TeX bundle lock has no pinned files.');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-unsigned-bundle-'));
  try {
    const zipFile = path.join(work, 'bundle.zip');
    await fs.writeFile(zipFile, bundleZipBytes);
    const extracted = path.join(work, 'extracted');
    await fs.mkdir(extracted, { recursive: true });
    execFileSync('/usr/bin/unzip', ['-q', '-o', zipFile, '-d', extracted], { stdio: 'ignore' });
    const entries = await fs.readdir(extracted);
    const extra = entries.filter((name) => !Object.hasOwn(lock.files, name));
    if (extra.some((name) => name !== 'SHA256SUM'))
      throw new Error('The embedded TeX bundle contains files outside its pinned lock.');
    const missing = names.filter((name) => !entries.includes(name));
    if (missing.length)
      throw new Error(
        `The embedded TeX bundle is missing pinned files: ${missing.slice(0, 5).join(', ')}`,
      );
    for (const name of names) {
      const bytes = await fs.readFile(path.join(extracted, name));
      if (sha256(bytes) !== lock.files[name])
        throw new Error(`Embedded TeX bundle file differs from its pinned lock: ${name}`);
    }
    return { matchedFiles: names.length, extraFiles: extra };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

export type ComponentEvidence = {
  bundleFile: string;
  sha256: string;
  evidence: 'matched-font-source' | 'matched-resource-source' | 'unmatched-generated';
  sourceId?: string;
  sourcePath?: string;
  declaredLicense?: string;
  generatedReason?: string;
  reviewStatus: 'unreviewed-grant';
};

/** Link every embedded TeX bundle file to its already-reviewed provenance match (or its
 * documented generated/unmatched status) without inferring redistribution permission for
 * any of them: every entry keeps an explicit `unreviewed-grant` status. Fails closed unless
 * the locks are still pinned to the exact bundle they were reviewed against and jointly
 * cover every bundle file exactly once with a matching hash. */
export function crossReferenceTexComponents(input: {
  bundleLockBytes: Buffer;
  fontLockBytes: Buffer;
  bundleLock: BundleLock;
  fontLock: TexSourceLock;
  resourceLock: TexSourceLock;
}): ComponentEvidence[] {
  const { bundleLockBytes, fontLockBytes, bundleLock, fontLock, resourceLock } = input;
  if (bundleLock.schemaVersion !== 1 || !bundleLock.files)
    throw new Error('Unsupported TeX bundle lock schema.');
  const bundleLockSha256 = sha256(bundleLockBytes);
  const fontLockSha256 = sha256(fontLockBytes);
  if (fontLock.schemaVersion !== 1 || fontLock.bundleLockSha256 !== bundleLockSha256)
    throw new Error('The font source-material lock is not pinned to the current TeX bundle lock.');
  if (
    resourceLock.schemaVersion !== 1 ||
    resourceLock.bundleLockSha256 !== bundleLockSha256 ||
    resourceLock.fontLockSha256 !== fontLockSha256
  )
    throw new Error(
      'The resource source-material lock is not pinned to the current TeX bundle/font locks.',
    );
  const covered = new Map<string, ComponentEvidence>();
  const addMatch = (
    source: { id: string; declaredLicense?: string },
    match: { bundle: string; source: string; sha256: string },
    evidence: 'matched-font-source' | 'matched-resource-source',
  ) => {
    if (covered.has(match.bundle))
      throw new Error(`Duplicate TeX bundle coverage for: ${match.bundle}`);
    if (bundleLock.files[match.bundle] !== match.sha256)
      throw new Error(`Source-material match differs from the TeX bundle lock: ${match.bundle}`);
    covered.set(match.bundle, {
      bundleFile: match.bundle,
      sha256: match.sha256,
      evidence,
      sourceId: source.id,
      sourcePath: match.source,
      declaredLicense: source.declaredLicense,
      reviewStatus: 'unreviewed-grant',
    });
  };
  for (const source of fontLock.sources ?? []) {
    if (!Array.isArray(source.matches))
      throw new Error('Font source entry is missing its match list.');
    for (const match of source.matches) addMatch(source, match, 'matched-font-source');
  }
  for (const source of resourceLock.sources ?? []) {
    if (!Array.isArray(source.matches))
      throw new Error('Resource source entry is missing its match list.');
    for (const match of source.matches) addMatch(source, match, 'matched-resource-source');
  }
  for (const unmatched of resourceLock.unmatchedResources ?? []) {
    if (covered.has(unmatched.file))
      throw new Error(`Duplicate TeX bundle coverage for: ${unmatched.file}`);
    if (bundleLock.files[unmatched.file] !== unmatched.sha256)
      throw new Error(
        `Unmatched-resource entry differs from the TeX bundle lock: ${unmatched.file}`,
      );
    covered.set(unmatched.file, {
      bundleFile: unmatched.file,
      sha256: unmatched.sha256,
      evidence: 'unmatched-generated',
      generatedReason: unmatched.reason,
      reviewStatus: 'unreviewed-grant',
    });
  }
  const bundleNames = Object.keys(bundleLock.files);
  if (covered.size !== bundleNames.length)
    throw new Error('TeX component evidence does not cover every pinned bundle file exactly once.');
  for (const name of bundleNames)
    if (!covered.has(name))
      throw new Error(`No component evidence for pinned bundle file: ${name}`);
  return bundleNames.map((name) => covered.get(name)!);
}

/** Recursively hash a packaged notices directory and require it to be byte-for-byte
 * identical (names, structure and content) to the canonical, already-reviewed copy outside
 * the app. Fails closed on any added, removed, renamed or tampered file. */
export async function verifyNoticesDirectory(packagedDir: string, canonicalDir: string) {
  const walk = async (root: string, rel = ''): Promise<Array<[string, string]>> => {
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    const rows: Array<[string, string]> = [];
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) rows.push(...(await walk(root, child)));
      else if (entry.isFile())
        rows.push([child, sha256(await fs.readFile(path.join(root, child)))]);
      else throw new Error(`Unexpected non-regular notice file: ${child}`);
    }
    return rows;
  };
  const [packaged, canonical] = await Promise.all([walk(packagedDir), walk(canonicalDir)]);
  if (JSON.stringify(packaged) !== JSON.stringify(canonical))
    throw new Error(
      `Packaged notices differ from their canonical originals: ${path.basename(canonicalDir)}`,
    );
  return { fileCount: packaged.length, digest: sha256(JSON.stringify(packaged)) };
}

const NOTICE_DIRECTORIES: Array<{ name: string; canonical: string }> = [
  { name: 'tex-font-notices', canonical: 'resources/tex-font-notices' },
  { name: 'tex-resource-notices', canonical: 'resources/tex-resource-notices' },
  { name: 'npm-notices', canonical: 'resources/npm-notices' },
  { name: 'pdfjs-notices', canonical: 'resources/pdfjs-notices' },
  { name: 'electron-notices', canonical: 'artifacts/electron-notices' },
  { name: 'biber-notices', canonical: 'artifacts/biber-notices' },
  { name: 'tectonic-notices', canonical: 'artifacts/tectonic-notices' },
];

/** Orchestrate every check above against one exact local unsigned-candidate Folio.app and
 * write a bounded, self-describing materials index. Every failure mode above propagates
 * unchanged: there is no partial/best-effort output. */
export async function collectUnsignedCandidateMaterials(appPath: string) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('This collector requires an Apple silicon Mac.');
  const app = path.resolve(appPath);
  if (!app.endsWith('.app')) throw new Error('Provide a packaged Folio.app directory.');
  const inventory = await inventoryBundle(app);
  const entries = new Map(inventory.entries.map((row) => [row.path, row]));
  const relatives = {
    asar: 'Contents/Resources/app.asar',
    info: 'Contents/Info.plist',
    runtimeManifest: 'Contents/Resources/runtime/manifest.json',
    texBundle: 'Contents/Resources/runtime/bundle.zip',
  } as const;
  for (const name of Object.values(relatives)) {
    const entry = entries.get(name);
    if (entry?.kind !== 'file' || entry.bytes! > 512 * 1024 * 1024)
      throw new Error(`Missing or oversized identity file for the candidate app: ${name}`);
  }
  const anchors: Record<string, Buffer> = Object.fromEntries(
    await Promise.all(
      Object.values(relatives).map(async (name) => [name, await fs.readFile(path.join(app, name))]),
    ),
  );
  for (const name of Object.values(relatives))
    if (entries.get(name)?.sha256 !== sha256(anchors[name]))
      throw new Error('Packaged identity metadata changed while being inventoried.');
  const pkg = JSON.parse(extractFile(path.join(app, relatives.asar), 'package.json').toString());
  const info = JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      input: anchors[relatives.info],
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
  const codesignReport = await execute('/usr/bin/codesign', ['-dv', app]);
  const codesign = parseCodesignIdentity(codesignReport.stderr);
  const runtime = JSON.parse(anchors[relatives.runtimeManifest].toString());
  if (
    runtime.schemaVersion !== 1 ||
    runtime.platform !== 'darwin-arm64' ||
    !runtime.files ||
    typeof runtime.files !== 'object' ||
    Array.isArray(runtime.files) ||
    ['tectonic', 'biber', 'bundle.zip'].some((name) => !Object.hasOwn(runtime.files, name))
  )
    throw new Error('Expected the packaged Apple silicon runtime manifest.');
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
  const bundleLockBytes = await fs.readFile('resources/bundle.lock.json');
  const fontLockBytes = await fs.readFile('resources/tex-font-sources.lock.json');
  const resourceLockBytes = await fs.readFile('resources/tex-resource-sources.lock.json');
  const bundleLock: BundleLock = JSON.parse(bundleLockBytes.toString());
  const fontLock: TexSourceLock = JSON.parse(fontLockBytes.toString());
  const resourceLock: TexSourceLock = JSON.parse(resourceLockBytes.toString());
  const texBundle = await verifyEmbeddedTexBundle(anchors[relatives.texBundle], bundleLock);
  const componentEvidence = crossReferenceTexComponents({
    bundleLockBytes,
    fontLockBytes,
    bundleLock,
    fontLock,
    resourceLock,
  });
  const noticesMaterials = await Promise.all(
    NOTICE_DIRECTORIES.map(async ({ name, canonical }) => {
      const packaged = path.join(app, 'Contents/Resources', name);
      const result = await verifyNoticesDirectory(packaged, path.resolve(canonical));
      return { directory: name, canonicalPath: canonical, ...result };
    }),
  );
  for (const name of Object.values(relatives))
    if (entries.get(name)?.sha256 !== sha256(anchors[name]))
      throw new Error('Packaged identity metadata changed while being collected.');
  const materialsIndex = {
    schemaVersion: 1,
    kind: 'unsigned-candidate-exact-artifact-materials-index',
    candidateScope: 'unsigned-candidate',
    grantReview: 'unreviewed-grant',
    generatedAt: new Date().toISOString(),
    scope:
      'A preparatory, source-reachable materials index for one exact local unsigned-candidate ' +
      'Folio.app build (LIC-04/LIC-05 prep). Every TeX-bundle component keeps an explicit ' +
      'unreviewed-grant status; no redistribution permission, corresponding-source compliance, ' +
      'build reproduction or absence of additional linkage is inferred or implied.',
    releaseAuditComplete: false,
    signedReleaseCoverage: {
      covered: false,
      excluded: [
        'Signed/notarized app, DMG and ZIP artifacts',
        'Published source archive and third-party materials bundle',
        'Code-signature and notarization validation',
      ],
      reason:
        'Final signed-app materials publication (LIC-05) is externally blocked in this environment; ' +
        'this index only covers the unsigned local candidate build used to prepare for it.',
    },
    application: {
      name: 'Folio',
      version: pkg.version,
      bundleIdentifier: info.CFBundleIdentifier,
      architecture,
      codesign,
    },
    appAsarSha256: sha256(anchors[relatives.asar]),
    runtimeManifestSha256: sha256(anchors[relatives.runtimeManifest]),
    runtimeFilesVerified: Object.keys(runtime.files).length,
    embeddedTexBundle: {
      sha256: sha256(anchors[relatives.texBundle]),
      bundleLockSha256: sha256(bundleLockBytes),
      pinnedFiles: Object.keys(bundleLock.files).length,
      ...texBundle,
    },
    componentEvidence,
    noticesMaterials,
    limits: [
      'Covers one exact local unsigned-candidate app build; not the final signed/notarized release.',
      'Component evidence links embedded TeX-bundle files to their already-pinned source-material ' +
        'matches; individual redistribution-grant and corresponding-source review remain open (LIC-04).',
      'Notices materials are verified byte-identical to their canonical originals, not independently ' +
        're-reviewed for license correctness.',
      'Excludes DMG/ZIP/source-archive contents, code-signature/notarization validation and any ' +
        'linked-component mapping beyond the embedded TeX bundle and packaged notice directories.',
    ],
  };
  const digest = sha256(jsonBytes(materialsIndex));
  const output = path.resolve('artifacts/license-materials/unsigned-candidate-sbom', digest);
  await fs.mkdir(output, { recursive: true });
  const record = { ...materialsIndex, digest };
  const recordBytes = jsonBytes(record);
  await fs.writeFile(path.join(output, 'materials-index.json'), recordBytes);
  const summary = {
    schemaVersion: 1,
    digest,
    application: record.application,
    releaseAuditComplete: false,
    candidateScope: 'unsigned-candidate',
    grantReview: 'unreviewed-grant',
    runtimeFilesVerified: record.runtimeFilesVerified,
    embeddedTexBundlePinnedFiles: record.embeddedTexBundle.pinnedFiles,
    componentEvidenceEntries: componentEvidence.length,
    noticesDirectoriesVerified: noticesMaterials.length,
    records: [
      { path: 'materials-index.json', bytes: recordBytes.length, sha256: sha256(recordBytes) },
    ],
  };
  const summaryBytes = jsonBytes(summary);
  await fs.writeFile(path.join(output, 'summary.json'), summaryBytes);
  return { output, ...summary };
}
