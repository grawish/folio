import { promises as fs, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { replaceDurable, syncDirectory } from './save-io';

export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

// Pack state is app-owned. Check the existing ancestry before creating anything
// so a linked parent cannot redirect even the first directory creation.
export async function packDirectory(root: string) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root)
    throw new Error('Pack storage requires a canonical absolute path.');
  const absent: string[] = [];
  let existing = root;
  for (;;) {
    try {
      const stat = await fs.lstat(existing);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await fs.realpath(existing)) !== existing
      )
        throw new Error('Pack storage must not use linked folders.');
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      absent.push(existing);
      existing = path.dirname(existing);
    }
  }
  for (const directory of absent.reverse()) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      await syncDirectory(path.dirname(directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!(await fs.lstat(directory)).isDirectory() || (await fs.realpath(directory)) !== directory)
      throw new Error('Pack storage must not use linked folders.');
  }
}

export function packPath(root: string, name: string) {
  if (!/^[a-z0-9][a-z0-9.-]{0,159}$/.test(name)) throw new Error('Invalid pack storage filename.');
  return path.join(root, name);
}

export async function packFile(root: string, name: string, limit: number) {
  await packDirectory(root);
  let handle;
  try {
    handle = await fs.open(
      packPath(root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
      throw new Error('Pack state must be a bounded regular file without links.');
    return await handle.readFile();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function savePackFile(root: string, name: string, bytes: Uint8Array | string) {
  await packDirectory(root);
  const destination = packPath(root, name);
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error('Pack state must not replace links or special files.');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await replaceDurable(destination, bytes, randomUUID());
}
