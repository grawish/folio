import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  verifyMacArchives,
  verifyDistributionApp,
  verifyDmgSignature,
} from '../scripts/verify-mac-archives';

const supported = process.platform === 'darwin' && process.arch === 'arm64';
let root: string, app: string, dmg: string, zip: string;
const run = (file: string, args: string[]) =>
  execFileSync(file, args, { timeout: 90_000, stdio: 'pipe' });
before(async () => {
  if (!supported) return;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-archive-test-')));
  app = path.join(root, 'source/Folio.app');
  const resources = path.join(app, 'Contents/Resources');
  await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
  await fs.mkdir(path.join(resources, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(resources, 'app.asar'), 'Synthetic app archive');
  await fs.writeFile(path.join(resources, 'runtime/manifest.json'), '{}');
  await fs.mkdir(path.join(resources, 'versions/A'), { recursive: true });
  await fs.writeFile(path.join(resources, 'versions/A/resource'), 'Internal link target');
  await fs.symlink('A', path.join(resources, 'versions/Current'));
  await fs.writeFile(path.join(root, 'fixture.c'), 'int main(void) { return 0; }\n');
  run('/usr/bin/xcrun', [
    'clang',
    '-arch',
    'arm64',
    path.join(root, 'fixture.c'),
    '-o',
    path.join(app, 'Contents/MacOS/Folio'),
  ]);
  await fs.writeFile(
    path.join(app, 'Contents/Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.folio.resume</string><key>CFBundleExecutable</key><string>Folio</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
  );
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
  run('/usr/bin/xattr', [
    '-w',
    'com.folio.archive-test',
    'Synthetic metadata',
    path.join(resources, 'app.asar'),
  ]);
  zip = path.join(root, 'app.zip');
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  const staging = path.join(root, 'dmg-source');
  run('/usr/bin/ditto', [app, path.join(staging, 'Folio.app')]);
  await fs.symlink('/Applications', path.join(staging, 'Applications'));
  dmg = path.join(root, 'app.dmg');
  run('/usr/bin/hdiutil', [
    'create',
    '-srcfolder',
    staging,
    '-fs',
    'HFS+',
    '-format',
    'UDZO',
    '-volname',
    'Folio archive test',
    dmg,
  ]);
});
after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test(
  'real DMG and metadata-preserving ZIP contain the exact reference app',
  { skip: !supported },
  async () => {
    const result = await verifyMacArchives(app, dmg, zip);
    assert.equal(result.passed, true);
    assert.equal(result.zip.appMatches, true);
    assert.ok(result.zip.metadataEntries > 0);
    assert.equal(result.dmg.appMatches, true);
    assert.equal(result.distributionVerified, false);
    assert.equal('distribution' in result.zip, false);
  },
);

test(
  'changed, omitted, duplicate, escaping and wrong-mode ZIP entries fail before extraction',
  { skip: !supported },
  async () => {
    const marker = path.join(root, 'outside-marker');
    await fs.writeFile(marker, 'keep this');
    for (const variation of [
      'bytes',
      'missing',
      'duplicate',
      'escape',
      'link',
      'mode',
      'hidden-output',
    ]) {
      const changed = path.join(root, `${variation}.zip`);
      run('python3', [
        '-c',
        `
import sys, zipfile, stat, warnings, struct
warnings.simplefilter('ignore', UserWarning)
source, output, variation, marker = sys.argv[1:]
with zipfile.ZipFile(source) as original, zipfile.ZipFile(output, 'w') as edited:
    original_member = original.getinfo('Folio.app/Contents/Resources/app.asar')
    original_size, original_crc = original_member.file_size, original_member.CRC
    for info in original.infolist():
        data = original.read(info)
        if info.filename == 'Folio.app/Contents/Resources/app.asar':
            if variation == 'missing': continue
            if variation == 'bytes': data += b'changed'
            if variation == 'hidden-output': data += b'X' * 8192
            if variation == 'duplicate': edited.writestr(info, data)
            if variation == 'mode': info.external_attr = (stat.S_IFREG | 0o755) << 16
        if variation == 'link' and stat.S_ISLNK(info.external_attr >> 16):
            data = marker.encode()
        edited.writestr(info, data)
    if variation == 'escape':
        info = zipfile.ZipInfo(marker)
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        edited.writestr(info, b'overwrite')
if variation == 'hidden-output':
    with zipfile.ZipFile(output) as rewritten:
        member = rewritten.getinfo('Folio.app/Contents/Resources/app.asar')
        local, central = member.header_offset, rewritten.start_dir
    with open(output, 'rb') as stream: payload = bytearray(stream.read())
    struct.pack_into('<I', payload, local + 14, original_crc)
    struct.pack_into('<I', payload, local + 22, original_size)
    while payload[central:central+4] == b'PK\x01\x02':
        name_size, extra_size, comment_size = struct.unpack_from('<HHH', payload, central + 28)
        name = payload[central+46:central+46+name_size].decode()
        if name == member.filename:
            struct.pack_into('<I', payload, central + 16, original_crc)
            struct.pack_into('<I', payload, central + 24, original_size)
            break
        central += 46 + name_size + extra_size + comment_size
    with open(output, 'wb') as stream: stream.write(payload)
`,
        zip,
        changed,
        variation,
        marker,
      ]);
      await assert.rejects(verifyMacArchives(app, dmg, changed), /ZIP/);
      assert.equal(await fs.readFile(marker, 'utf8'), 'keep this');
    }
  },
);

test(
  'a valid disk image containing a different app cannot qualify',
  { skip: !supported },
  async () => {
    const staging = path.join(root, 'changed-dmg-source');
    run('/usr/bin/ditto', [app, path.join(staging, 'Folio.app')]);
    await fs.appendFile(path.join(staging, 'Folio.app/Contents/Resources/app.asar'), 'changed');
    const changed = path.join(root, 'changed.dmg');
    run('/usr/bin/hdiutil', [
      'create',
      '-srcfolder',
      staging,
      '-fs',
      'HFS+',
      '-format',
      'UDZO',
      '-volname',
      'Folio changed archive test',
      changed,
    ]);
    await assert.rejects(verifyMacArchives(app, changed, zip), /Archive app differs/);
  },
);

test(
  'ad-hoc apps and invalid publisher identities cannot pass production checks',
  { skip: !supported },
  async () => {
    await assert.rejects(verifyDistributionApp(app, 'invalid'), /Apple Team ID/);
    await assert.rejects(verifyDistributionApp(app, 'ABCDE12345'), /codesign/);
    await assert.rejects(verifyDmgSignature(dmg, 'ABCDE12345'), /codesign/);
    await assert.rejects(
      verifyMacArchives(app, dmg, zip, { distributionTeamId: '' }),
      /Apple Team ID/,
    );
  },
);

test(
  'a failed package-verification rerun invalidates its old success report',
  { skip: !supported },
  async () => {
    const release = path.join(root, 'failed-package');
    await fs.mkdir(release);
    const report = path.join(release, 'verification.json');
    await fs.writeFile(report, JSON.stringify({ passed: true, distributionVerified: true }));
    assert.throws(() =>
      run(process.execPath, ['scripts/verify-mac-package.mjs', release, '--distribution']),
    );
    const actual = JSON.parse(await fs.readFile(report, 'utf8'));
    assert.equal(actual.passed, false);
    assert.equal(actual.distributionVerified, false);
  },
);
