import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function verifyPdfjsNotices(directory: string) {
  const source = path.join(root, 'resources/pdfjs-notices');
  const indexBytes = await fs.readFile(path.join(source, 'SOURCES.json'));
  const index = JSON.parse(indexBytes.toString());
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const pkg = index.package;
  const locked = lock.packages[pkg.location];
  if (
    index.schemaVersion !== 1 ||
    index.completeBinarySbom !== false ||
    pkg.name !== 'pdfjs-dist' ||
    !locked ||
    locked.version !== pkg.version ||
    locked.integrity !== pkg.archive.integrity ||
    locked.resolved !== pkg.archive.url
  )
    throw new Error('PDF.js notice sources do not match the dependency lock.');
  const expected = new Map<string, { bytes: number; sha256: string }>();
  for (const notice of index.noticeFiles) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,150}$/.test(notice.file) ||
      expected.has(notice.file) ||
      !Number.isSafeInteger(notice.bytes) ||
      notice.bytes < 1 ||
      notice.bytes > 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(notice.sha256)
    )
      throw new Error('Invalid PDF.js notice record.');
    expected.set(notice.file, notice);
  }
  for (const name of ['README.md', 'SOURCES.json']) {
    const bytes = await fs.readFile(path.join(source, name));
    expected.set(name, { bytes: bytes.length, sha256: digest(bytes) });
  }
  const state = await fs.lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink())
    throw new Error('Linked PDF.js notice directory.');
  const names = await fs.readdir(directory);
  if (names.length !== expected.size) throw new Error('Incomplete or unexpected PDF.js notices.');
  const records = [];
  for (const name of names.sort()) {
    const ref = expected.get(name);
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    if (!ref || !stat.isFile() || stat.isSymbolicLink() || stat.size !== ref.bytes)
      throw new Error(`Missing, linked or changed PDF.js notice: ${name}`);
    if (digest(await fs.readFile(file)) !== ref.sha256)
      throw new Error(`Changed PDF.js notice: ${name}`);
    records.push({ path: name, bytes: ref.bytes, sha256: ref.sha256 });
  }
  return {
    originalNoticeFiles: index.noticeFiles.filter(
      (n: { copy: string }) => n.copy === 'complete-original',
    ).length,
    originalSourceHeaders: index.noticeFiles.filter(
      (n: { copy: string }) => n.copy === 'original-comment-prefix',
    ).length,
    sourceIndexSha256: digest(indexBytes),
    upstreamCommit: index.upstream.commit,
    records,
  };
}
