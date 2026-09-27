import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function verifyTexFontNotices(directory: string) {
  const lockBytes = await fs.readFile(path.join(root, 'resources/tex-font-sources.lock.json'));
  const lock = JSON.parse(lockBytes.toString());
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.noticeFiles))
    throw new Error('Invalid font notice lock.');
  const expected = new Map<string, { bytes: number; sha256: string }>();
  for (const entry of lock.noticeFiles) {
    if (
      typeof entry.file !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,150}$/.test(entry.file) ||
      expected.has(entry.file) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error('Invalid font notice record.');
    expected.set(entry.file, entry);
  }
  const readme = await fs.readFile(path.join(root, 'resources/tex-font-notices/README.md'));
  expected.set('README.md', { bytes: readme.length, sha256: digest(readme) });
  const state = await fs.lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink())
    throw new Error('Linked font notice directory.');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.length !== expected.size) throw new Error('Incomplete or unexpected font notices.');
  const records = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const reference = expected.get(entry.name);
    const stat = await fs.lstat(path.join(directory, entry.name));
    if (!reference || !stat.isFile() || stat.isSymbolicLink() || stat.size !== reference.bytes)
      throw new Error(`Missing, linked or changed font notice: ${entry.name}`);
    const bytes = await fs.readFile(path.join(directory, entry.name));
    if (digest(bytes) !== reference.sha256) throw new Error(`Changed font notice: ${entry.name}`);
    records.push({ path: entry.name, bytes: bytes.length, sha256: reference.sha256 });
  }
  return {
    originalNoticeFiles: lock.noticeFiles.length,
    sourceLockSha256: digest(lockBytes),
    records,
  };
}
