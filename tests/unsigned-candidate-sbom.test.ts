import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  parseCodesignIdentity,
  verifyEmbeddedTexBundle,
  crossReferenceTexComponents,
  verifyNoticesDirectory,
} from '../scripts/collect-unsigned-candidate-sbom';

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const adhoc = [
  'Executable=/tmp/Folio.app/Contents/MacOS/Folio',
  'Identifier=Electron',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded',
  'Signature=adhoc',
  'Info.plist=not bound',
  'TeamIdentifier=not set',
  'Sealed Resources=none',
  'Internal requirements=none',
].join('\n');

test('an ad-hoc, unteamed identity is accepted as an unsigned candidate', () => {
  const identity = parseCodesignIdentity(adhoc);
  assert.equal(identity.signature, 'adhoc');
  assert.equal(identity.teamIdentifier, 'not set');
});

test('a real distribution signature is rejected because it belongs to the signed-release pipeline', () => {
  const signed = adhoc
    .replace('Signature=adhoc', 'Signature=1 valid on disk')
    .replace('TeamIdentifier=not set', 'TeamIdentifier=ABCDE12345');
  assert.throws(() => parseCodesignIdentity(signed), /signed-release materials pipeline/);
});

test('an incomplete codesign report fails closed instead of silently accepting an unknown identity', () => {
  assert.throws(() => parseCodesignIdentity('Executable=/tmp/Folio.app\n'), /complete codesign/);
});

async function texFixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-unsigned-tex-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'alpha.tex'), 'alpha contents\n');
  await fs.writeFile(path.join(source, 'beta.sty'), 'beta contents\n');
  const zip = path.join(root, 'bundle.zip');
  execFileSync('/usr/bin/zip', ['-q', '-j', zip, 'alpha.tex', 'beta.sty'], { cwd: source });
  const bundleZipBytes = await fs.readFile(zip);
  const files = {
    'alpha.tex': sha256('alpha contents\n'),
    'beta.sty': sha256('beta contents\n'),
  };
  return { root, bundleZipBytes, files };
}

test('the embedded TeX bundle is accepted only when it exactly matches its pinned lock', async (t) => {
  const { bundleZipBytes, files } = await texFixture(t);
  const result = await verifyEmbeddedTexBundle(bundleZipBytes, { schemaVersion: 1, files });
  assert.equal(result.matchedFiles, 2);
  assert.deepEqual(result.extraFiles, []);
});

test('a tampered embedded TeX bundle file fails closed', async (t) => {
  const { bundleZipBytes, files } = await texFixture(t);
  await assert.rejects(
    verifyEmbeddedTexBundle(bundleZipBytes, {
      schemaVersion: 1,
      files: { ...files, 'alpha.tex': sha256('different bytes') },
    }),
    /differs from its pinned lock/,
  );
});

test('a missing pinned TeX bundle file fails closed', async (t) => {
  const { bundleZipBytes, files } = await texFixture(t);
  await assert.rejects(
    verifyEmbeddedTexBundle(bundleZipBytes, {
      schemaVersion: 1,
      files: { ...files, 'gamma.tex': sha256('missing') },
    }),
    /missing pinned files/,
  );
});

test('an unpinned extra file inside the embedded TeX bundle fails closed', async (t) => {
  const { root, files } = await texFixture(t);
  await fs.writeFile(path.join(root, 'source/extra.tex'), 'unexpected extra file\n');
  const zip = path.join(root, 'bundle-with-extra.zip');
  execFileSync('/usr/bin/zip', ['-q', '-j', zip, 'alpha.tex', 'beta.sty', 'extra.tex'], {
    cwd: path.join(root, 'source'),
  });
  await assert.rejects(
    verifyEmbeddedTexBundle(await fs.readFile(zip), { schemaVersion: 1, files }),
    /outside its pinned lock/,
  );
});

function texLockFixture() {
  const bundleLockBytes = Buffer.from(JSON.stringify({ bogus: 'bundle-lock' }));
  const fontLockBytes = Buffer.from(JSON.stringify({ bogus: 'font-lock' }));
  const bundleLock = {
    schemaVersion: 1 as const,
    files: {
      'alpha.otf': sha256('alpha font'),
      'beta.tex': sha256('beta macro'),
      'gamma.map': sha256('gamma generated'),
    },
  };
  const fontLock = {
    schemaVersion: 1 as const,
    bundleLockSha256: sha256(bundleLockBytes),
    sources: [
      {
        id: 'alpha-family',
        declaredLicense: 'OFL-1.1',
        matches: [{ bundle: 'alpha.otf', source: 'fonts/alpha.otf', sha256: sha256('alpha font') }],
      },
    ],
  };
  const resourceLock = {
    schemaVersion: 1 as const,
    bundleLockSha256: sha256(bundleLockBytes),
    fontLockSha256: sha256(fontLockBytes),
    sources: [
      {
        id: 'beta-package',
        declaredLicense: 'LPPL-1.3c',
        matches: [{ bundle: 'beta.tex', source: 'tex/beta.tex', sha256: sha256('beta macro') }],
      },
    ],
    unmatchedResources: [
      {
        file: 'gamma.map',
        sha256: sha256('gamma generated'),
        reason: 'Generated by TeX Live tools.',
      },
    ],
  };
  return { bundleLockBytes, fontLockBytes, bundleLock, fontLock, resourceLock };
}

test('every bundle file gets exactly one component-evidence row with an explicit unreviewed-grant status', () => {
  const fixture = texLockFixture();
  const rows = crossReferenceTexComponents(fixture);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.reviewStatus === 'unreviewed-grant'));
  const byFile = new Map(rows.map((row) => [row.bundleFile, row]));
  assert.equal(byFile.get('alpha.otf')?.evidence, 'matched-font-source');
  assert.equal(byFile.get('beta.tex')?.evidence, 'matched-resource-source');
  assert.equal(byFile.get('gamma.map')?.evidence, 'unmatched-generated');
});

test('a font lock no longer pinned to the current bundle lock fails closed', () => {
  const fixture = texLockFixture();
  fixture.fontLock.bundleLockSha256 = 'stale-digest';
  assert.throws(
    () => crossReferenceTexComponents(fixture),
    /not pinned to the current TeX bundle lock/,
  );
});

test('a resource lock no longer pinned to the current font lock fails closed', () => {
  const fixture = texLockFixture();
  fixture.resourceLock.fontLockSha256 = 'stale-digest';
  assert.throws(
    () => crossReferenceTexComponents(fixture),
    /not pinned to the current TeX bundle\/font locks/,
  );
});

test('a bundle file left uncovered by any source or unmatched entry fails closed', () => {
  const fixture = texLockFixture();
  fixture.resourceLock.unmatchedResources = [];
  assert.throws(
    () => crossReferenceTexComponents(fixture),
    /does not cover every pinned bundle file exactly once/,
  );
});

test('a match whose hash disagrees with the bundle lock fails closed', () => {
  const fixture = texLockFixture();
  fixture.fontLock.sources[0].matches[0].sha256 = sha256('tampered');
  assert.throws(() => crossReferenceTexComponents(fixture), /differs from the TeX bundle lock/);
});

test('duplicate coverage of the same bundle file fails closed', () => {
  const fixture = texLockFixture();
  fixture.resourceLock.sources.push({
    id: 'duplicate-alpha',
    declaredLicense: 'OFL-1.1',
    matches: [{ bundle: 'alpha.otf', source: 'tex/dup.otf', sha256: sha256('alpha font') }],
  });
  assert.throws(() => crossReferenceTexComponents(fixture), /Duplicate TeX bundle coverage/);
});

async function noticesFixture(t: any) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'folio-unsigned-notices-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const canonical = path.join(root, 'canonical');
  const packaged = path.join(root, 'packaged');
  await fs.mkdir(path.join(canonical, 'nested'), { recursive: true });
  await fs.mkdir(path.join(packaged, 'nested'), { recursive: true });
  await fs.writeFile(path.join(canonical, 'README.md'), 'notice readme\n');
  await fs.writeFile(path.join(packaged, 'README.md'), 'notice readme\n');
  await fs.writeFile(path.join(canonical, 'nested', 'LICENSE'), 'license text\n');
  await fs.writeFile(path.join(packaged, 'nested', 'LICENSE'), 'license text\n');
  return { canonical, packaged };
}

test('an identical packaged notices directory is accepted', async (t) => {
  const { canonical, packaged } = await noticesFixture(t);
  const result = await verifyNoticesDirectory(packaged, canonical);
  assert.equal(result.fileCount, 2);
});

test('a packaged notice file that differs from its canonical original fails closed', async (t) => {
  const { canonical, packaged } = await noticesFixture(t);
  await fs.writeFile(path.join(packaged, 'nested', 'LICENSE'), 'tampered license text\n');
  await assert.rejects(
    verifyNoticesDirectory(packaged, canonical),
    /differ from their canonical originals/,
  );
});

test('an extra packaged notice file not present in the canonical original fails closed', async (t) => {
  const { canonical, packaged } = await noticesFixture(t);
  await fs.writeFile(path.join(packaged, 'unexpected.txt'), 'unexpected\n');
  await assert.rejects(
    verifyNoticesDirectory(packaged, canonical),
    /differ from their canonical originals/,
  );
});
