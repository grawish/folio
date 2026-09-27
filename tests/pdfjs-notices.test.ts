import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verifyPdfjsNotices } from '../scripts/verify-pdfjs-notices';

test('PDF.js includes all seven original licenses and four original copyright headers', async () => {
  const result = await verifyPdfjsNotices('resources/pdfjs-notices');
  assert.equal(result.originalNoticeFiles, 7);
  assert.equal(result.originalSourceHeaders, 4);
  assert.equal(result.records.length, 13);
  assert.equal(result.upstreamCommit, '1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56');
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.ok(
    pkg.build.extraResources.some(
      (r: { from: string; to: string }) =>
        r.from === 'resources/pdfjs-notices' && r.to === 'pdfjs-notices',
    ),
  );
});

test('PDF.js package notices reject missing, changed, linked and unexpected files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-pdfjs-notices-'));
  try {
    const folder = path.join(root, 'notices');
    await fs.cp('resources/pdfjs-notices', folder, { recursive: true });
    const file = path.join(folder, 'brotli--LICENSE_BROTLI.txt');
    const original = await fs.readFile(file);
    await verifyPdfjsNotices(folder);
    await fs.writeFile(file, Buffer.alloc(original.length));
    await assert.rejects(verifyPdfjsNotices(folder), /Changed/);
    await fs.unlink(file);
    await assert.rejects(verifyPdfjsNotices(folder), /Incomplete/);
    const elsewhere = path.join(root, 'elsewhere');
    await fs.writeFile(elsewhere, original);
    await fs.symlink(elsewhere, file);
    await assert.rejects(verifyPdfjsNotices(folder), /linked/);
    await fs.unlink(file);
    await fs.writeFile(file, original);
    for (const name of ['README.md', 'SOURCES.json', 'flate_stream.js--original-header.txt']) {
      const target = path.join(folder, name);
      const bytes = await fs.readFile(target);
      await fs.writeFile(target, Buffer.alloc(bytes.length));
      await assert.rejects(verifyPdfjsNotices(folder), /Changed/);
      await fs.writeFile(target, bytes);
    }
    await fs.writeFile(path.join(folder, 'unexpected'), 'extra');
    await assert.rejects(verifyPdfjsNotices(folder), /unexpected/);
    await fs.unlink(path.join(folder, 'unexpected'));
    await fs.symlink(folder, path.join(root, 'linked'));
    await assert.rejects(verifyPdfjsNotices(path.join(root, 'linked')), /Linked/);
    await verifyPdfjsNotices(folder);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
