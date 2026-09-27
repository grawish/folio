import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function verifyNpmNotices(directory: string) {
  const source = path.join(root, 'resources/npm-notices');
  const indexBytes = await fs.readFile(path.join(source, 'SOURCES.json'));
  const index = JSON.parse(indexBytes.toString());
  const lockBytes = await fs.readFile(path.join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString());
  if (
    index.schemaVersion !== 1 ||
    index.packageLockSha256 !== digest(lockBytes) ||
    index.releaseAuditComplete !== false
  )
    throw new Error('Npm notice index does not match the dependency lock.');
  const expected = new Map<string, { bytes: number; sha256: string }>();
  const locations = new Set<string>();
  const missing = [];
  for (const pkg of index.packages) {
    const entry = lock.packages[pkg.location];
    if (
      locations.has(pkg.location) ||
      !entry ||
      entry.dev ||
      pkg.version !== entry.version ||
      pkg.archive.url !== entry.resolved ||
      pkg.archive.integrity !== entry.integrity
    )
      throw new Error('Invalid npm source identity.');
    locations.add(pkg.location);
    if (pkg.notices.length === 0) missing.push(pkg.name);
    for (const notice of pkg.notices) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,150}$/.test(notice.file) ||
        expected.has(notice.file) ||
        !Number.isSafeInteger(notice.bytes) ||
        notice.bytes < 1 ||
        notice.bytes > 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(notice.sha256)
      )
        throw new Error('Invalid npm original notice.');
      expected.set(notice.file, notice);
    }
  }
  // Required production packages cannot silently disappear from the notice index.
  for (const [location, entry] of Object.entries(lock.packages) as [
    string,
    { dev?: boolean; optional?: boolean },
  ][]) {
    if (location && !entry.dev && !entry.optional && !locations.has(location))
      throw new Error('Npm production package omitted from notice index.');
  }
  if (JSON.stringify(missing) !== JSON.stringify(index.missingOriginalText))
    throw new Error('Npm missing-text disclosure differs.');
  const originalNoticeFiles = expected.size;
  for (const name of ['README.md', 'SOURCES.json']) {
    const bytes = await fs.readFile(path.join(source, name));
    expected.set(name, { bytes: bytes.length, sha256: digest(bytes) });
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked npm notice directory.');
  const entries = await fs.readdir(directory);
  if (entries.length !== expected.size) throw new Error('Incomplete or unexpected npm notices.');
  const records = [];
  for (const name of entries.sort()) {
    const ref = expected.get(name);
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    if (!ref || !stat.isFile() || stat.isSymbolicLink() || stat.size !== ref.bytes)
      throw new Error(`Missing, linked or changed npm notice: ${name}`);
    const bytes = await fs.readFile(file);
    if (digest(bytes) !== ref.sha256) throw new Error(`Changed npm notice: ${name}`);
    records.push({ path: name, bytes: bytes.length, sha256: ref.sha256 });
  }
  return {
    originalNoticeFiles,
    indexedPackages: locations.size,
    missingOriginalText: missing,
    sourceIndexSha256: digest(indexBytes),
    records,
  };
}
