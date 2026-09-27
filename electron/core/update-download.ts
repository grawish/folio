import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { CancellationError, type DownloadOptions } from 'builder-util-runtime';
import { updateNetworkUrl } from './update-feed';
import { requireVerifiedUpdate, type UpdateFeed } from './update-manifest';

export type UpdateDownloadRequest = (
  url: string,
  signal: AbortSignal,
) => Promise<{ status: number; headers: Headers; body: Readable }>;

/** Transfer hook for the pinned Mac updater. Enforces signed bytes before writes. */
export async function downloadAppUpdate(
  feed: UpdateFeed,
  url: URL,
  destination: string,
  cacheRoot: string,
  options: DownloadOptions,
  request: UpdateDownloadRequest,
) {
  requireVerifiedUpdate(feed);
  const release = feed.release;
  if (!release || url.href !== release.zip.url || options.sha512 !== release.zip.sha512)
    throw new Error('The download differs from the authenticated app release.');
  if (
    !path.isAbsolute(cacheRoot) ||
    path.resolve(cacheRoot) !== cacheRoot ||
    path.dirname(destination) !== cacheRoot ||
    (await fs.realpath(cacheRoot)) !== cacheRoot
  )
    throw new Error('The app update must download into its owned, unlinked cache.');
  const controller = new AbortController();
  const cancel = () => controller.abort(new CancellationError());
  options.cancellationToken.once('cancel', cancel);
  if (options.cancellationToken.cancelled) cancel();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () => controller.abort(new Error('The app download stopped responding. Try again.')),
      30_000,
    );
  };
  let response: Awaited<ReturnType<UpdateDownloadRequest>> | undefined,
    file: FileHandle | undefined;
  try {
    controller.signal.throwIfAborted();
    let current = updateNetworkUrl(url.href);
    for (let redirects = 0; redirects <= 5; redirects++) {
      resetIdle();
      response = await request(current.href, controller.signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      response.body.destroy();
      const location = response.headers.get('location');
      if (!location || redirects === 5)
        throw new Error('The app download redirected too many times.');
      current = updateNetworkUrl(new URL(location, current).href);
    }
    controller.signal.throwIfAborted();
    if (response?.status !== 200 || !response.body)
      throw new Error(
        `The app download returned HTTP ${response?.status ?? 'unknown'}. Try again later.`,
      );
    const size = response.headers.get('content-length'),
      encoding = response.headers.get('content-encoding');
    if (size !== null && (!/^\d+$/.test(size) || Number(size) !== release.zip.bytes))
      throw new Error('The app download reported a different size from its signed metadata.');
    if (encoding && encoding.toLowerCase() !== 'identity')
      throw new Error('The app download changed its transfer encoding. Try again later.');
    file = await fs.open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error('The update download must be a regular file without links.');
    await file.truncate(0);
    const hash = createHash('sha512');
    const startedAt = Date.now();
    let received = 0,
      reported = 0,
      reportedAt = 0;
    for await (const chunk of response.body) {
      controller.signal.throwIfAborted();
      resetIdle();
      // Check before any write, even when Content-Length is missing or false.
      if (!(chunk instanceof Uint8Array) || received + chunk.length > release.zip.bytes)
        throw new Error('The app download exceeds its signed size.');
      let offset = 0;
      while (offset < chunk.length) {
        controller.signal.throwIfAborted();
        const { bytesWritten } = await file.write(
          chunk,
          offset,
          chunk.length - offset,
          received + offset,
        );
        if (bytesWritten <= 0) throw new Error('The app download could not be written.');
        offset += bytesWritten;
      }
      received += chunk.length;
      hash.update(chunk);
      if (Date.now() - reportedAt >= 100 || received === release.zip.bytes) {
        options.onProgress?.({
          total: release.zip.bytes,
          transferred: received,
          delta: received - reported,
          percent: (received / release.zip.bytes) * 100,
          bytesPerSecond: Math.round(received / Math.max(0.001, (Date.now() - startedAt) / 1000)),
        });
        reported = received;
        reportedAt = Date.now();
      }
    }
    controller.signal.throwIfAborted();
    if (received !== release.zip.bytes || hash.digest('base64') !== release.zip.sha512)
      throw new Error('The app download failed its signed size or SHA-512 checksum.');
    await file.sync();
    controller.signal.throwIfAborted();
    return destination;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(idle);
    options.cancellationToken.removeListener('cancel', cancel);
    // End the request and close its file before the updater clears/renames a
    // cache entry or another operation can begin. No background write survives.
    controller.abort();
    if (response) {
      response.body.destroy();
      await finished(response.body, { cleanup: true }).catch(() => {});
    }
    await file?.close();
  }
}
