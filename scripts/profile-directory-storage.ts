import { promises as fs } from 'node:fs';
import path from 'node:path';

type Entry =
  { path: string; kind: 'directory' | 'symlink' } | { path: string; kind: 'file'; bytes: number };

// Read-only metadata observation of an owned synthetic profile. It is not an
// atomic snapshot, deletion policy, allocated-block measure or security boundary.
export async function profileStorage(
  root: string,
  { maxEntries = 50_000, maxDepth = 16 }: { maxEntries?: number; maxDepth?: number } = {},
) {
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 50_000 ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > 16
  )
    throw new Error('Invalid profile observation bounds.');
  const start = performance.now();
  const state = await fs.lstat(root);
  if (!state.isDirectory() || state.isSymbolicLink())
    throw new Error('Profile root must be a directory.');
  const entries: Entry[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > maxDepth) throw new Error('Profile metadata observation exceeded its depth bound.');
    const directory = await fs.opendir(path.join(root, relative));
    for await (const entry of directory) {
      if (entries.length >= maxEntries)
        throw new Error('Profile metadata observation exceeded its entry bound.');
      const file = path.join(relative, entry.name);
      const state = await fs.lstat(path.join(root, file));
      if (state.isSymbolicLink()) {
        entries.push({ path: file, kind: 'symlink' });
      } else if (state.isDirectory()) {
        entries.push({ path: file, kind: 'directory' });
        await walk(file, depth + 1);
      } else if (state.isFile() && Number.isSafeInteger(state.size) && state.size >= 0) {
        entries.push({ path: file, kind: 'file', bytes: state.size });
      } else {
        throw new Error('Unexpected special file in the synthetic profile.');
      }
    }
  };
  await walk('', 0);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = entries.filter((entry) => entry.kind === 'file');
  const groups = new Map<string, { regularFiles: number; logicalFileBytes: number }>();
  for (const file of files) {
    const key = file.path.split(path.sep)[0];
    const group = groups.get(key) ?? { regularFiles: 0, logicalFileBytes: 0 };
    group.regularFiles++;
    group.logicalFileBytes += file.bytes;
    groups.set(key, group);
  }
  const logicalFileBytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
  if (!Number.isSafeInteger(logicalFileBytes))
    throw new Error('Profile size exceeds safe integer accounting.');
  return {
    collectionMs: performance.now() - start,
    regularFiles: files.length,
    directories: entries.filter((entry) => entry.kind === 'directory').length,
    symlinks: entries.filter((entry) => entry.kind === 'symlink').length,
    logicalFileBytes,
    groups: Object.fromEntries(groups),
    entries,
  };
}
