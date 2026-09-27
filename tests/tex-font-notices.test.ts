import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { verifyTexFontNotices } from '../scripts/verify-tex-font-notices';

test('all included font binaries have locked sources and packaged original notices', async () => {
  const bundleBytes = await fs.readFile('resources/bundle.lock.json');
  const bundle = JSON.parse(bundleBytes.toString());
  const lock = JSON.parse(await fs.readFile('resources/tex-font-sources.lock.json', 'utf8'));
  assert.equal(lock.bundleLockSha256, createHash('sha256').update(bundleBytes).digest('hex'));
  const matches = lock.sources.flatMap(
    (source: { matches: { bundle: string; sha256: string }[] }) => source.matches,
  );
  const names = new Set(matches.map((match: { bundle: string }) => match.bundle));
  assert.equal(names.size, matches.length);
  for (const match of matches) assert.equal(match.sha256, bundle.files[match.bundle]);
  for (const name of Object.keys(bundle.files).filter((name) => /\.(otf|ttf|pfb)$/.test(name)))
    assert.ok(names.has(name), `Font has no locked source: ${name}`);
  const report = await verifyTexFontNotices('resources/tex-font-notices');
  assert.equal(report.originalNoticeFiles, 15);
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.ok(
    pkg.build.extraResources.some(
      (entry: { from: string; to: string }) =>
        entry.from === 'resources/tex-font-notices' && entry.to === 'tex-font-notices',
    ),
  );
});

test('package notice verification rejects missing, changed, linked and extra files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-font-notices-'));
  try {
    const folder = path.join(root, 'notices');
    await fs.cp('resources/tex-font-notices', folder, { recursive: true });
    await verifyTexFontNotices(folder);
    const original = await fs.readFile(path.join(folder, 'OFL-1.1.txt'));
    await fs.unlink(path.join(folder, 'OFL-1.1.txt'));
    await assert.rejects(verifyTexFontNotices(folder), /Incomplete/);
    await fs.writeFile(path.join(folder, 'OFL-1.1.txt'), Buffer.alloc(original.length));
    await assert.rejects(verifyTexFontNotices(folder), /Changed/);
    await fs.unlink(path.join(folder, 'OFL-1.1.txt'));
    await fs.writeFile(path.join(root, 'outside.txt'), original);
    await fs.symlink(path.join(root, 'outside.txt'), path.join(folder, 'OFL-1.1.txt'));
    await assert.rejects(verifyTexFontNotices(folder), /linked/);
    await fs.unlink(path.join(folder, 'OFL-1.1.txt'));
    await fs.writeFile(path.join(folder, 'OFL-1.1.txt'), original);
    await fs.writeFile(path.join(folder, 'extra.txt'), 'extra');
    await assert.rejects(verifyTexFontNotices(folder), /unexpected/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
