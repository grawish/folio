import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type { CompilerStorageEntry } from '../../src/shared/compiler-storage';
import { validateRuntimePin } from '../../src/shared/runtime';
import { readRuntimeManifest, runtimeFile, runtimePin } from './runtime';
import { syncDirectory } from './save-io';

export const compilerInstallationBudget = 16 * 1024 ** 3;
export const compilerFreeSpaceMargin = 1024 ** 3;
export const compilerGeneration = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const identity = /^[a-f0-9]{64}$/;
const removed = /^removing-([a-f0-9]{64})-[a-f0-9-]{36}$/;
const maximumEntries = 200_000;
type Item = { name: string; stat: Stats };
export type StorageTree = { bytes: number; token: string; items: Item[] };
const signature = (stat: Stats) => [
  stat.dev,
  stat.ino,
  stat.mode,
  stat.nlink,
  stat.size,
  stat.mtimeMs,
  stat.ctimeMs,
];

// Do not follow links, allocate an unbounded readdir array, or read large file
// contents merely to show disk use. Logical bytes deliberately ignore APFS clones.
export async function compilerStorageTree(root: string): Promise<StorageTree> {
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    !(await fs.lstat(root)).isDirectory() ||
    (await fs.realpath(root)) !== root
  )
    throw new Error('Compiler storage requires an existing folder without links.');
  const items: Item[] = [],
    digest = createHash('sha256');
  let bytes = 0;
  const visit = async (name: string, depth: number) => {
    if (depth > 32 || items.length >= maximumEntries)
      throw new Error('Compiler storage exceeds the inspection limit. No files were removed.');
    const full = path.join(root, name),
      stat = await fs.lstat(full);
    if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1))
      throw new Error('Compiler storage contains a link or special file. No files were removed.');
    items.push({ name, stat });
    if (stat.isFile()) bytes += stat.size;
    else {
      if ((await fs.realpath(full)) !== full)
        throw new Error('Compiler storage contains a linked folder. No files were removed.');
      const folder = await fs.opendir(full);
      for await (const entry of folder)
        await visit(name ? `${name}/${entry.name}` : entry.name, depth + 1);
    }
  };
  await visit('', 0);
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const item of items) digest.update(JSON.stringify([item.name, signature(item.stat)]));
  return { bytes, token: digest.digest('hex'), items };
}

export function compilerStorageKey(value: unknown): string {
  if (typeof value !== 'string' || (!identity.test(value) && !removed.test(value)))
    throw new Error('Choose a compiler from a fresh storage review.');
  return value;
}

export async function describeCompilerStorage(
  root: string,
  key: string,
): Promise<CompilerStorageEntry> {
  compilerStorageKey(key);
  const base = path.join(root, key),
    tree = await compilerStorageTree(base);
  const entry: CompilerStorageEntry = {
    key,
    bytes: tree.bytes,
    copies: 0,
    token: tree.token,
    unfinishedRemoval: removed.test(key),
  };
  // Renamed copies are no longer usable compilers. A new review may finish an
  // interrupted removal even after its manifests were already deleted.
  if (entry.unfinishedRemoval) return entry;
  try {
    const generations = tree.items.filter((item) => /^copies\/[^/]+$/.test(item.name));
    const allowed = new Set(['', 'copies', 'active.json']);
    for (const generation of generations) {
      const name = generation.name.slice(7);
      if (!compilerGeneration.test(name) || !generation.stat.isDirectory())
        throw new Error('Unrecognized compiler copy.');
      const copy = path.join(base, generation.name);
      const manifest = await readRuntimeManifest(path.join(copy, 'runtime'));
      const pin = runtimePin(manifest);
      if (pin.id !== key) throw new Error('Compiler identity does not match its folder.');
      if (!entry.pin) entry.pin = pin;
      const marker = validateRuntimePin(
        JSON.parse((await runtimeFile(copy, 'ready.json', 2048)).toString()).pin,
      );
      if (JSON.stringify(marker) !== JSON.stringify(pin))
        throw new Error('Compiler ready marker does not match.');
      entry.copies++;
      for (const suffix of ['', '/runtime', '/ready.json']) allowed.add(generation.name + suffix);
      for (const file of [
        ...Object.keys(manifest.files),
        'manifest.json',
        'bundle.lock.json',
        'THIRD_PARTY_NOTICES.md',
      ]) {
        let relative = `${generation.name}/runtime/${file}`;
        allowed.add(relative);
        while (relative.includes('/')) {
          relative = relative.slice(0, relative.lastIndexOf('/'));
          allowed.add(relative);
        }
      }
    }
    if (!entry.pin || tree.items.some((item) => !allowed.has(item.name)))
      throw new Error('Unrecognized or unfinished compiler files.');
  } catch {
    entry.protectedReason = 'Unrecognized or unfinished compiler files; preserved for recovery.';
  }
  return entry;
}

export async function removeCompilerStorage(root: string, key: string, token: string) {
  compilerStorageKey(key);
  const source = path.join(root, key),
    tree = await compilerStorageTree(source);
  if (tree.token !== token)
    throw new Error('Compiler files changed. Refresh storage and review again.');
  const target = removed.test(key) ? source : path.join(root, `removing-${key}-${randomUUID()}`);
  if (target !== source) {
    await fs.rename(source, target);
    await syncDirectory(root);
  }
  // No recursive rm: a file added after review must not be swept into removal.
  // A crash or failure leaves a visible, reviewable unfinished-removal folder.
  try {
    for (const item of [...tree.items].sort((a, b) => b.name.length - a.name.length)) {
      const full = path.join(target, item.name),
        actual = await fs.lstat(full);
      const same =
        actual.dev === item.stat.dev &&
        actual.ino === item.stat.ino &&
        actual.mode === item.stat.mode;
      if (
        !same ||
        (actual.isFile() &&
          JSON.stringify(signature(actual)) !== JSON.stringify(signature(item.stat)))
      )
        throw new Error('A reviewed compiler file changed.');
      if (actual.isDirectory()) {
        if ((await fs.realpath(full)) !== full)
          throw new Error('A reviewed compiler folder changed.');
        await fs.rmdir(full);
      } else await fs.unlink(full);
    }
    await syncDirectory(root);
  } catch (error) {
    throw new Error(
      `Compiler removal stopped. Refresh storage to review the remaining files. ${(error as Error).message}`,
    );
  }
}

export async function admitCompilerCopy(root: string, copyBytes: number) {
  const tree = await compilerStorageTree(root);
  // 256 MiB allows metadata and the small offline self-test; this is an
  // admission policy, not an OS disk reservation or a measured peak guarantee.
  const allowance = copyBytes + 256 * 1024 ** 2;
  if (tree.bytes + allowance > compilerInstallationBudget)
    throw new Error(
      'Compiler storage would exceed the 16 GiB installation budget. Open Settings → Storage and review old compilers before trying again.',
    );
  const disk = await fs.statfs(root, { bigint: true });
  const required = BigInt(allowance + compilerFreeSpaceMargin);
  if (disk.bavail * disk.bsize < required)
    throw new Error(
      'Not enough free disk space to prepare this compiler. Free space or review old compilers in Settings → Storage, then try again.',
    );
}
