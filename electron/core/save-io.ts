import { createHash } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { safeRelative } from './file-io';

export const fileDigest = (data: Uint8Array | string) =>
  createHash('sha256').update(data).digest('hex');
export const LIMIT = 100 * 1024 * 1024;
export const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

// Check each parent, not just the leaf: a dangling symlink must never cause mkdir
// or a replacement write outside the chosen project directory.
export async function parentPath(root: string, relative: string, create = false): Promise<string> {
  safeRelative(relative);
  let parent = root;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    if (create) {
      try {
        await fs.mkdir(parent);
        await syncDirectory(path.dirname(parent));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Project folders must be real directories, without symbolic links.');
  }
  return parent;
}

export async function readTarget(root: string, relative: string): Promise<Buffer | null> {
  try {
    await parentPath(root, relative);
    const leaf = await fs.lstat(path.join(root, relative));
    if (leaf.isSymbolicLink() || !leaf.isFile())
      throw new Error(
        `Cannot save over ${relative}: expected a regular file without symbolic links.`,
      );
    const handle = await fs.open(
      path.join(root, relative),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > LIMIT)
        throw new Error(`Cannot save over ${relative}: invalid or oversized file.`);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function syncDirectory(directory: string) {
  // Windows does not expose portable directory fsync through Node; each file is
  // still flushed. Native power-loss durability must be validated per platform.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function writeDurable(filename: string, data: Uint8Array | string, mode = 0o600) {
  const handle = await fs.open(filename, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function replaceDurable(
  filename: string,
  data: Uint8Array | string,
  suffix: string,
  mode = 0o600,
) {
  const temporary = `${filename}.${suffix}.tmp`;
  try {
    await writeDurable(temporary, data, mode);
    await fs.rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
