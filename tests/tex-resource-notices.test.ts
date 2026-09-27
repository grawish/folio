import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { verifyTexResourceNotices } from '../scripts/verify-tex-font-notices';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('TeX source notices bind all mapped resources and explicitly retain the generated-file gap', async () => {
  const lockBytes = await fs.readFile('resources/tex-resource-sources.lock.json');
  const lock = JSON.parse(lockBytes.toString());
  const bundleBytes = await fs.readFile('resources/bundle.lock.json');
  const bundle = JSON.parse(bundleBytes.toString());
  assert.equal(lock.bundleLockSha256, digest(bundleBytes));
  assert.equal(
    lock.fontLockSha256,
    digest(await fs.readFile('resources/tex-font-sources.lock.json')),
  );
  const index = JSON.parse(
    await fs.readFile('resources/tex-resource-notices/SOURCES.json', 'utf8'),
  );
  assert.equal(index.sourceLockSha256, digest(lockBytes));
  assert.equal(index.releaseAuditComplete, false);
  const matches = lock.sources.flatMap(
    (source: { matches: { bundle: string; sha256: string }[] }) => source.matches,
  );
  const names = new Set(matches.map((match: { bundle: string }) => match.bundle));
  assert.equal(names.size, matches.length);
  assert.equal(matches.length, 402);
  for (const match of matches) assert.equal(match.sha256, bundle.files[match.bundle]);
  assert.deepEqual(
    lock.unmatchedResources.map((r: { file: string }) => r.file),
    ['kanjix.map', 'language.dat', 'pdftex.map'],
  );
  const report = await verifyTexResourceNotices('resources/tex-resource-notices');
  assert.equal(report.originalNoticeFiles, 102);
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.ok(
    pkg.build.extraResources.some(
      (e: { from: string; to: string }) =>
        e.from === 'resources/tex-resource-notices' && e.to === 'tex-resource-notices',
    ),
  );
});

test('TeX package gate rejects altered originals, source guide, links and additional files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-tex-notices-'));
  try {
    const folder = path.join(root, 'notices');
    await fs.cp('resources/tex-resource-notices', folder, { recursive: true });
    await verifyTexResourceNotices(folder);
    const target = path.join(folder, 'SPDX-Apache-2.0.txt');
    const original = await fs.readFile(target);
    await fs.writeFile(target, Buffer.alloc(original.length));
    await assert.rejects(verifyTexResourceNotices(folder), /Changed/);
    await fs.unlink(target);
    await assert.rejects(verifyTexResourceNotices(folder), /Incomplete/);
    await fs.writeFile(path.join(root, 'outside'), original);
    await fs.symlink(path.join(root, 'outside'), target);
    await assert.rejects(verifyTexResourceNotices(folder), /linked/);
    await fs.unlink(target);
    await fs.writeFile(target, original);
    const guide = path.join(folder, 'SOURCES.json');
    const bytes = await fs.readFile(guide);
    await fs.writeFile(guide, Buffer.alloc(bytes.length));
    await assert.rejects(verifyTexResourceNotices(folder), /Changed/);
    await fs.writeFile(guide, bytes);
    await fs.writeFile(path.join(folder, 'extra'), 'extra');
    await assert.rejects(verifyTexResourceNotices(folder), /unexpected/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
