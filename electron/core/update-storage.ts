import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { packDirectory } from './pack-io';
import { requireVerifiedUpdate, updateVersion, type UpdateFeed } from './update-manifest';

const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_METADATA = 4096;
export const UPDATE_SPACE_MARGIN = 1024 ** 3;

function recognizedFile(name: string) {
  if (name === 'update-info.json') return true;
  const version = /^(?:(?:[0-2]-)?temp-)?Folio-(.{1,80})-mac-arm64\.zip$/.exec(name)?.[1];
  if (!version) return false;
  try {
    return updateVersion(version) === version;
  } catch {
    return false;
  }
}
const identity = (stat: Stats) =>
  [stat.dev, stat.ino, stat.size, stat.ctimeMs, stat.mtimeMs].join(':');

/** Inspect everything before allowing the pinned updater to read metadata or
 * clear its pending directory. Never recursively delete an unexpected item.
 */
export async function prepareUpdateCache(root: string, feed: UpdateFeed, signal: AbortSignal) {
  requireVerifiedUpdate(feed);
  if (!feed.release) throw new Error('There is no approved app update.');
  signal.throwIfAborted();
  await packDirectory(root);
  const entries = new Map<string, Stats>();
  const directory = await fs.opendir(root);
  for await (const entry of directory) {
    signal.throwIfAborted();
    if (entries.size >= MAX_CACHE_ENTRIES)
      throw new Error('The app update cache contains too many files. Use Downloads on GitHub.');
    const stat = await fs.lstat(path.join(root, entry.name));
    if (!recognizedFile(entry.name) || !stat.isFile() || stat.nlink !== 1)
      throw new Error(
        'The app update cache contains unexpected items or links. Use Downloads on GitHub.',
      );
    entries.set(entry.name, stat);
  }
  const archive = `Folio-${feed.release.version}-mac-arm64.zip`;
  const metadata = entries.get('update-info.json');
  let retain = false;
  if (metadata && metadata.size <= MAX_CACHE_METADATA) {
    const handle = await fs.open(
      path.join(root, 'update-info.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || identity(before) !== identity(metadata))
        throw new Error('The app update cache changed while being checked. Try again.');
      const bytes = Buffer.alloc(MAX_CACHE_METADATA + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (identity(await handle.stat()) !== identity(before))
        throw new Error('The app update cache changed while being checked. Try again.');
      try {
        const record = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
        retain =
          bytesRead <= MAX_CACHE_METADATA &&
          !!record &&
          Object.keys(record).length === 3 &&
          record.fileName === archive &&
          record.sha512 === feed.release.zip.sha512 &&
          record.isAdminRightsRequired === false &&
          entries.get(archive)?.size === feed.release.zip.bytes;
      } catch {
        /* Damaged metadata is discarded, never passed to the updater. */
      }
    } finally {
      await handle.close();
    }
  }
  let removed = 0;
  for (const [name, before] of entries) {
    if (retain && (name === archive || name === 'update-info.json')) continue;
    signal.throwIfAborted();
    const file = path.join(root, name);
    const current = await fs.lstat(file);
    if (!current.isFile() || current.nlink !== 1 || identity(current) !== identity(before))
      throw new Error('The app update cache changed while being checked. Try again.');
    await fs.unlink(file);
    removed++;
  }
  return {
    cached: retain,
    removed,
    retainedBytes: retain ? feed.release.zip.bytes + metadata!.size : 0,
  };
}

export type UpdateSpaceProbe = (directory: string) => Promise<bigint>;
const availableBytes: UpdateSpaceProbe = async (directory) => {
  const stat = await fs.statfs(directory, { bigint: true });
  if (stat.bavail < 0n || stat.bsize <= 0n) throw new Error('Invalid disk-space reading.');
  return stat.bavail * stat.bsize;
};

/** Conservative headroom, not an OS reservation. Check each involved path, even
 * on separate/APFS-shared volumes, rather than assuming independent free space.
 */
export async function checkUpdateSpace(
  feed: UpdateFeed,
  locations: { cache: string; application: string; temporary: string },
  needsDownload: boolean,
  probe: UpdateSpaceProbe = availableBytes,
) {
  requireVerifiedUpdate(feed);
  if (!feed.release) throw new Error('There is no approved app update.');
  const { zip, unpackedBytes } = feed.release;
  // Pending ZIP plus native ZIP copy, extraction and replacement workspace.
  // Existing cached ZIP bytes are already reflected in the free-space reading.
  const required = BigInt(
    (needsDownload ? 2 : 1) * zip.bytes + 3 * unpackedBytes + UPDATE_SPACE_MARGIN,
  );
  const requiredGB = (Math.ceil((Number(required) / 1024 ** 3) * 10) / 10).toFixed(1);
  for (const [label, directory] of Object.entries(locations)) {
    let available: bigint;
    try {
      available = await probe(directory);
    } catch (cause) {
      throw new Error(
        'Folio could not check free disk space for this update. Try again or use Downloads on GitHub.',
        { cause },
      );
    }
    if (available < required)
      throw new Error(
        `This app update needs about ${requiredGB} GB free on the ${label === 'application' ? 'app' : label === 'temporary' ? 'temporary-files' : 'update-cache'} disk. Free some space and check for updates again. Your documents are kept.`,
      );
  }
  return { requiredBytes: Number(required) };
}
