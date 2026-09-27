import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { requireVerifiedUpdate, type UpdateFeed } from './update-manifest';

function cachePath(file: string, root: string) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || path.dirname(file) !== root)
    throw new Error('The app update is outside its owned cache.');
}

export async function verifyUpdateArchive(
  file: string,
  root: string,
  feed: UpdateFeed,
  now = Date.now(),
) {
  requireVerifiedUpdate(feed, now);
  if (!feed.release) throw new Error('There is no approved app update.');
  cachePath(file, root);
  if ((await fs.realpath(root)) !== root)
    throw new Error('The update cache must not use linked folders.');
  if (
    path.basename(file) !== `Folio-${feed.release.version}-mac-arm64.zip` ||
    (await fs.realpath(file)) !== file
  )
    throw new Error('The app update cache has an unexpected download path.');
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(feed.release.zip.bytes))
      throw new Error('The downloaded app has the wrong size or is not a regular file.');
    const hash = createHash('sha512');
    let bytes = 0;
    for await (const block of handle.createReadStream({ autoClose: false })) {
      bytes += block.length;
      if (bytes > feed.release.zip.bytes)
        throw new Error('The downloaded app grew while being verified.');
      hash.update(block);
    }
    const after = await handle.stat({ bigint: true });
    if (
      bytes !== feed.release.zip.bytes ||
      hash.digest('base64') !== feed.release.zip.sha512 ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs ||
      before.size !== after.size
    )
      throw new Error(
        'The downloaded app changed or failed its signed checksum. Download it again.',
      );
  } finally {
    await handle.close();
  }
}

export async function discardUpdateArchive(file: string, root: string) {
  cachePath(file, root);
  if ((await fs.realpath(root)) !== root)
    throw new Error('The update cache must not use linked folders.');
  // Remove only the updater-selected cache entry, never a directory or link target.
  await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
