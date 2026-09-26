import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function pinnedDownload(item, cache, offline = false) {
  const urls = [item.url, ...(item.mirrors ?? [])];
  if (
    !/^[a-zA-Z0-9._-]+$/.test(item.filename) ||
    urls.length > 4 ||
    urls.some((url) => typeof url !== 'string' || !/^https:\/\//.test(url)) ||
    !Number.isSafeInteger(item.bytes) ||
    item.bytes < 1 ||
    item.bytes > 64 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(item.sha256)
  )
    throw new Error('Invalid pinned source description.');
  await fs.mkdir(cache, { recursive: true });
  const file = path.join(cache, item.filename);
  let bytes;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== item.bytes)
      throw new Error(`Invalid cached source: ${item.filename}`);
    bytes = await fs.readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (offline) throw new Error(`Missing offline source: ${item.filename}`);
    for (const url of urls) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`Source HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > item.bytes) throw new Error('Source exceeds its pinned size.');
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const candidate = Buffer.concat(chunks);
        if (candidate.length !== item.bytes || sha256(candidate) !== item.sha256)
          throw new Error('Source changed.');
        bytes = candidate;
        break;
      } catch {
        // A release mirror may preserve a pinned source after upstream changes.
        // Every candidate must match the same reviewed size and digest.
      }
    }
    if (!bytes) throw new Error(`Pinned source unavailable or changed: ${item.filename}`);
  }
  if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256)
    throw new Error(`Source differs from its reviewed lock: ${item.filename}`);
  try {
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return bytes;
}
