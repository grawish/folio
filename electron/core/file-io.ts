import { randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';

export function safeRelative(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 240 ||
    /[\x00-\x1f\\:]/.test(value) ||
    path.posix.isAbsolute(value) ||
    value.split('/').some((p) => p === '..' || p === '.' || !p || p.startsWith('.'))
  ) {
    throw new Error(
      'Use a relative project filename without hidden folders or parent-directory references.',
    );
  }
  return value;
}

export async function atomicWrite(filename: string, content: string | Uint8Array) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readWithin(
  root: string,
  relative: string,
  limit = 25 * 1024 * 1024,
): Promise<Buffer> {
  safeRelative(relative);
  const filename = path.join(root, relative);
  const real = await fs.realpath(filename);
  if (!real.startsWith(root + path.sep))
    throw new Error('Files linked outside the project are not supported.');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error('Project asset is too large or is not a regular file.');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
