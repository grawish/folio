import { promises as fs } from 'node:fs';
import path from 'node:path';

export type EngineCachePolicy = {
  runtimes: number;
  bytes: number;
  entries: number;
  depth: number;
  pollMs: number;
};
export const engineCachePolicy = Object.freeze<EngineCachePolicy>({
  runtimes: 2,
  bytes: 128 * 1024 * 1024,
  entries: 4096,
  depth: 8,
  pollMs: 500,
});
const runtimeName = /^[a-f0-9]{64}$/;
const activeRoots = new Set<string>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
type Identity = Awaited<ReturnType<typeof directory>>;
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
async function directory(folder: string) {
  const stat = await fs.lstat(folder, { bigint: true });
  if (!stat.isDirectory() || (process.getuid && stat.uid !== BigInt(process.getuid())))
    throw new Error('The compiler cache must be a local directory owned by this user.');
  return stat;
}

async function usage(folder: string, policy: EngineCachePolicy) {
  let bytes = 0,
    entries = 0,
    exceeded = false;
  const visit = async (current: string, depth: number): Promise<void> => {
    const stream = await fs.opendir(current);
    for await (const entry of stream) {
      if (++entries > policy.entries || depth > policy.depth) {
        exceeded = true;
        return;
      }
      const target = path.join(current, entry.name);
      let info;
      try {
        info = await fs.lstat(target);
      } catch (error) {
        // Tectonic can rename its temporary format while a live scan is running.
        if (missing(error)) continue;
        throw error;
      }
      if (info.isFile() && info.nlink === 1) bytes += info.size;
      else if (info.isDirectory()) {
        if (depth >= policy.depth) {
          exceeded = true;
          return;
        }
        try {
          await visit(target, depth + 1);
        } catch (error) {
          if (!missing(error)) throw error;
        }
      } else throw new Error('The compiler cache contains unsupported linked or special files.');
      if (bytes > policy.bytes) exceeded = true;
      if (exceeded) return;
    }
  };
  await visit(folder, 0);
  return { bytes, entries, exceeded };
}

type Cache = {
  name: string;
  folder: string;
  identity: Identity;
  bytes: number;
  entries: number;
  exceeded: boolean;
};

/** Only hash-named runtime caches under the app's private compiler work root are managed. */
export async function acquireEngineCache(
  workRoot: string,
  runtimeId: string,
  policy: EngineCachePolicy = engineCachePolicy,
) {
  if (!runtimeName.test(runtimeId)) throw new Error('The compiler cache identity is invalid.');
  if (Object.values(policy).some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new Error('The compiler cache policy is invalid.');
  await fs.mkdir(workRoot, { recursive: true });
  const parent = await fs.realpath(workRoot);
  const root = path.join(parent, 'engine-cache');
  // The app owns one process per profile. Separate compiler contexts have
  // separate roots; reject overlapping callers of the same root without queueing.
  if (activeRoots.has(root)) throw new Error('This compiler cache is busy. Try the build again.');
  activeRoots.add(root);
  let identity: Identity;
  const selected = path.join(root, runtimeId);
  let selectedIdentity: Identity;
  let released: Promise<void> | undefined;
  const checkRoot = async () => {
    if (!same(identity, await directory(root))) throw new Error('The compiler cache changed.');
  };
  const remove = async (cache: Cache) => {
    await checkRoot();
    if (!same(cache.identity, await directory(cache.folder)))
      throw new Error('A compiler cache changed before cleanup.');
    // No native process can be writing in this root during retention cleanup.
    // fs.rm removes links themselves, never their targets.
    await fs.rm(cache.folder, { recursive: true });
  };
  const prune = async (keep: string | undefined, reserveMissing = false) => {
    await checkRoot();
    const caches: Cache[] = [];
    const stream = await fs.opendir(root);
    let inspected = 0;
    for await (const item of stream) {
      // Preserve unrelated data and older unmarked build files.
      if (!runtimeName.test(item.name)) continue;
      if (++inspected > 1024) throw new Error('Too many compiler cache folders to inspect safely.');
      const folder = path.join(root, item.name);
      const stat = await directory(folder);
      const measured = await usage(folder, policy);
      const cache = { name: item.name, folder, identity: stat, ...measured };
      if (measured.exceeded) await remove(cache);
      else caches.push(cache);
    }
    caches.sort((a, b) =>
      a.identity.mtimeNs < b.identity.mtimeNs
        ? -1
        : a.identity.mtimeNs > b.identity.mtimeNs
          ? 1
          : a.name.localeCompare(b.name),
    );
    const remaining = [...caches];
    const over = () =>
      remaining.length + (reserveMissing && !remaining.some((c) => c.name === keep) ? 1 : 0) >
        policy.runtimes ||
      remaining.reduce((sum, c) => sum + c.bytes, 0) > policy.bytes ||
      remaining.reduce((sum, c) => sum + c.entries, 0) > policy.entries;
    for (const cache of caches) {
      if (!over()) break;
      if (cache.name === keep) continue;
      await remove(cache);
      remaining.splice(remaining.indexOf(cache), 1);
    }
    if (over()) throw new Error('The compiler cache exceeds its retention limit.');
  };
  try {
    await fs.mkdir(root, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    identity = await directory(root);
    // Reserve a slot before creating a new directory. A failed inspection must
    // not accumulate empty runtime folders on repeated admission attempts.
    await prune(runtimeId, true);
    await fs.mkdir(selected, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    selectedIdentity = await directory(selected);
    const now = new Date();
    await fs.utimes(selected, now, now);
    return {
      path: selected,
      async check() {
        if (released) throw new Error('The compiler cache lease has ended.');
        await checkRoot();
        if (!same(selectedIdentity, await directory(selected)))
          throw new Error('The active compiler cache changed.');
        const measured = await usage(selected, policy);
        if (measured.exceeded)
          throw new Error(
            'The compiler cache exceeded its storage limit. Simplify the document and try again.',
          );
      },
      release() {
        released ??= (async () => {
          try {
            await checkRoot();
            if (!same(selectedIdentity, await directory(selected)))
              throw new Error('The active compiler cache changed before cleanup.');
            await prune(runtimeId);
          } finally {
            activeRoots.delete(root);
          }
        })();
        return released;
      },
    };
  } catch (error) {
    activeRoots.delete(root);
    throw error;
  }
}
