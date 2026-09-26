import { promises as fs, constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { packUrl, requireKnownPack, requireVerifiedPack, type CatalogPack } from './pack-catalog';
import { isMissing, packDirectory, packFile, packPath, savePackFile } from './pack-io';
import { syncDirectory } from './save-io';

const activeRoots = new Set<string>();
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type PackProgress = { received: number; total: number; resumed: boolean };
export type DownloadedPack = { path: string; sha256: string; bytes: number; cached: boolean };
type Resume = { sha256: string; bytes: number; url: string; etag?: string };
const strongETag = (value: unknown): value is string =>
  typeof value === 'string' && /^"[\x21\x23-\x7e]{1,200}"$/.test(value);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class PackDownloads {
  private readonly hosts: ReadonlySet<string>;
  constructor(
    readonly root: string,
    hosts: readonly string[],
    private options: {
      fetch?: Fetch;
      timeoutMs?: number;
      now?: () => number;
      checkpoint?(phase: 'received' | 'verified' | 'published'): Promise<void>;
    } = {},
  ) {
    this.hosts = new Set(hosts);
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)
    )
      throw new Error('Choose a pack download timeout between 1 and 120000 ms.');
  }

  private async response(url: string, headers: Record<string, string>, signal: AbortSignal) {
    let current = packUrl(url, this.hosts);
    for (let redirect = 0; redirect <= 5; redirect++) {
      signal.throwIfAborted();
      const response = await (this.options.fetch ?? fetch)(current, {
        method: 'GET',
        headers,
        signal,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirect === 5)
        throw new Error('The pack download redirected too many times.');
      current = packUrl(new URL(location, current).href, this.hosts);
    }
    throw new Error('The pack download could not be reached.');
  }

  async download(
    pack: CatalogPack,
    options: {
      signal?: AbortSignal;
      progress?(value: PackProgress): void;
    } = {},
  ): Promise<DownloadedPack> {
    requireVerifiedPack(pack, (this.options.now ?? Date.now)());
    packUrl(pack.artifact.url, this.hosts);
    if (activeRoots.has(this.root)) throw new Error('A pack download is already running.');
    activeRoots.add(this.root);
    const { sha256, bytes: total, url } = pack.artifact;
    const root = packPath(this.root, sha256);
    let handle: FileHandle | undefined, response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let invalidatePartial = false;
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 90_000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      signal.throwIfAborted();
      await packDirectory(root);
      const completed = await packFile(root, 'payload.foliopack', total);
      if (completed) {
        if (completed.length !== total || digest(completed) !== sha256)
          throw new Error('The cached pack is damaged. Remove this download before trying again.');
        signal.throwIfAborted();
        return { path: packPath(root, 'payload.foliopack'), sha256, bytes: total, cached: true };
      }
      const stateBytes = await packFile(root, 'resume.json', 4096);
      const state: Resume = stateBytes
        ? JSON.parse(stateBytes.toString())
        : { sha256, bytes: total, url };
      if (
        !state ||
        state.sha256 !== sha256 ||
        state.bytes !== total ||
        state.url !== url ||
        (state.etag !== undefined && !strongETag(state.etag))
      )
        throw new Error(
          'The partial pack record is damaged. Remove this download before trying again.',
        );
      handle = await fs.open(
        packPath(root, 'payload.part'),
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > total)
        throw new Error('The partial pack must be a bounded regular file without links.');
      let received = stat.size;
      const resumed = received > 0;
      options.progress?.({ received, total, resumed });
      if (received < total) {
        const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
        if (received) {
          headers.Range = `bytes=${received}-${total - 1}`;
          if (state.etag) headers['If-Range'] = state.etag;
        }
        response = await this.response(url, headers, signal);
        if (![200, 206].includes(response.status))
          throw new Error(`The pack server returned HTTP ${response.status}. Try again later.`);
        const encoding = response.headers.get('content-encoding');
        if (encoding && encoding.toLowerCase() !== 'identity') {
          invalidatePartial = true;
          throw new Error('The pack server changed the download encoding. Retry the download.');
        }
        const tag = response.headers.get('etag');
        if (response.status === 206) {
          const range = response.headers.get('content-range');
          if (
            range !== `bytes ${received}-${total - 1}/${total}` ||
            (state.etag && tag !== state.etag)
          ) {
            invalidatePartial = true;
            throw new Error(
              'The pack server returned a different download range. Retry from the beginning.',
            );
          }
        } else {
          // A server may ignore Range or report a changed If-Range validator.
          // Replace only this owned partial file; never append a full response.
          await handle.truncate(0);
          received = 0;
        }
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) !== total - received)) {
          invalidatePartial = true;
          throw new Error('The pack server reported an unexpected download size.');
        }
        await savePackFile(
          root,
          'resume.json',
          JSON.stringify({ sha256, bytes: total, url, ...(strongETag(tag) ? { etag: tag } : {}) }),
        );
        if (!response.body) throw new Error('The pack server returned an empty response.');
        reader = response.body.getReader();
        for (;;) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          if (received + chunk.value.length > total) {
            invalidatePartial = true;
            throw new Error('The pack exceeds its verified download size.');
          }
          let written = 0;
          while (written < chunk.value.length) {
            const result = await handle.write(
              chunk.value,
              written,
              chunk.value.length - written,
              received + written,
            );
            if (!result.bytesWritten) throw new Error('The pack download could not be saved.');
            written += result.bytesWritten;
          }
          received += chunk.value.length;
          options.progress?.({ received, total, resumed: resumed && response.status === 206 });
          await this.options.checkpoint?.('received');
        }
        if (received !== total)
          throw new Error('The pack download was interrupted. Retry to resume it.');
      }
      signal.throwIfAborted();
      // Explicit positional writes leave the file cursor at zero. Re-read every
      // byte, including any prefix retained from an earlier process.
      const contents = await handle.readFile();
      if (contents.length !== total || digest(contents) !== sha256) {
        invalidatePartial = true;
        throw new Error(
          'The downloaded pack failed its integrity check. Retry from the beginning.',
        );
      }
      await handle.sync();
      signal.throwIfAborted();
      await this.options.checkpoint?.('verified');
      const original = await handle.stat();
      await packDirectory(root);
      const leaf = await fs.lstat(packPath(root, 'payload.part'));
      if (
        !leaf.isFile() ||
        leaf.isSymbolicLink() ||
        leaf.ino !== original.ino ||
        leaf.dev !== original.dev
      )
        throw new Error('The partial pack changed while it was being verified.');
      await handle.close();
      handle = undefined;
      await fs.rename(packPath(root, 'payload.part'), packPath(root, 'payload.foliopack'));
      await syncDirectory(root);
      await this.options.checkpoint?.('published');
      return { path: packPath(root, 'payload.foliopack'), sha256, bytes: total, cached: false };
    } finally {
      try {
        await reader?.cancel().catch(() => {});
        if (response && !reader) await response.body?.cancel().catch(() => {});
        if (handle) {
          try {
            if (invalidatePartial) await handle.truncate(0);
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
      } finally {
        activeRoots.delete(this.root);
      }
    }
  }

  async remove(pack: CatalogPack) {
    requireKnownPack(pack);
    if (activeRoots.has(this.root))
      throw new Error('Cancel the active download before removing it.');
    activeRoots.add(this.root);
    try {
      const root = packPath(this.root, pack.artifact.sha256);
      await packDirectory(root);
      // Never recurse over an arbitrary or replaced directory tree.
      for (const name of ['payload.part', 'payload.foliopack', 'resume.json']) {
        const file = packPath(root, name);
        try {
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
            throw new Error('Pack cleanup refuses linked or special files.');
          await fs.unlink(file);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      await syncDirectory(root);
    } finally {
      activeRoots.delete(this.root);
    }
  }

  async cachedBytes(pack: CatalogPack) {
    requireKnownPack(pack);
    const root = packPath(this.root, pack.artifact.sha256);
    await packDirectory(root);
    for (const name of ['payload.foliopack', 'payload.part']) {
      try {
        const stat = await fs.lstat(packPath(root, name));
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > pack.artifact.bytes
        )
          throw new Error('The cached download is damaged. Remove it before retrying.');
        return stat.size;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return 0;
  }
}
