import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { safeRelative } from './file-io';

export const fileDigest = (data: Uint8Array | string) =>
  createHash('sha256').update(data).digest('hex');
const LIMIT = 100 * 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

// Check each parent, not just the leaf: a dangling symlink must never cause mkdir
// or a replacement write outside the chosen project directory.
async function parentPath(root: string, relative: string, create = false): Promise<string> {
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

async function syncDirectory(directory: string) {
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
async function writeDurable(filename: string, data: Uint8Array | string, mode = 0o600) {
  const handle = await fs.open(filename, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function replaceDurable(
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

type Entry = { path: string; before: string | null; after: string | null; mode: number };
type Journal = {
  schema: 1;
  root: string;
  nonce: string;
  phase: 'prepared' | 'committed' | 'rolled-back';
  entries: Entry[];
};
export type SaveEntry = { path: string; data: Uint8Array | null; before: Uint8Array | null };
export type SaveHooks = {
  afterApply?(index: number): Promise<void>;
  afterCommit?(): Promise<void>;
  afterRollback?(): Promise<void>;
};

export class SaveTransactions {
  constructor(
    readonly dataRoot: string,
    private hooks: SaveHooks = {},
  ) {}
  private location(root: string) {
    return path.join(this.dataRoot, 'save-transactions', fileDigest(root));
  }
  private async readJournal(root: string): Promise<Journal | null> {
    const directory = this.location(root);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Invalid save journal directory.');
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    let raw: Journal;
    try {
      const data = await readTarget(directory, 'journal.json');
      if (!data) {
        // Preparation never touches project files before publishing the journal.
        await fs.rm(directory, { recursive: true, force: true });
        return null;
      }
      if (data.byteLength > 200_000) throw new Error('Oversized save journal.');
      raw = JSON.parse(data.toString());
    } catch {
      throw new Error('The interrupted save record could not be read. Its backups were kept.');
    }
    if (
      !raw ||
      raw.schema !== 1 ||
      raw.root !== root ||
      !/^[\w-]{1,80}$/.test(raw.nonce) ||
      !['prepared', 'committed', 'rolled-back'].includes(raw.phase) ||
      !Array.isArray(raw.entries) ||
      raw.entries.length > 404
    )
      throw new Error('Invalid interrupted save record. Its backups were kept.');
    const seen = new Set<string>();
    for (const entry of raw.entries) {
      const name = safeRelative(entry.path).toLowerCase();
      if (
        seen.has(name) ||
        (entry.before !== null && !/^[a-f0-9]{64}$/.test(entry.before)) ||
        (entry.after !== null && !/^[a-f0-9]{64}$/.test(entry.after)) ||
        !Number.isInteger(entry.mode) ||
        entry.mode < 0 ||
        entry.mode > 0o777
      )
        throw new Error('Invalid interrupted save entry. Its backups were kept.');
      seen.add(name);
    }
    return raw;
  }
  async recover(root: string): Promise<'none' | 'rolled-back' | 'committed'> {
    root = await fs.realpath(root);
    const journal = await this.readJournal(root);
    if (!journal) return 'none';
    const directory = this.location(root);
    if (journal.phase === 'prepared') {
      // Validate all backups and all current targets before restoring any of them.
      // An external edit made after the crash is never silently overwritten.
      for (const [index, entry] of journal.entries.entries()) {
        if (entry.before) {
          const backup = await readTarget(directory, `old-${index}`);
          if (!backup || fileDigest(backup) !== entry.before)
            throw new Error(
              'An interrupted save backup is missing or damaged. Remaining backups were kept.',
            );
        }
        const current = await readTarget(root, entry.path);
        const hash = current && fileDigest(current);
        if (hash !== entry.before && hash !== entry.after)
          throw new Error(
            `Cannot recover the interrupted save because ${entry.path} changed afterward. Your edit and save backups were kept in ${directory}.`,
          );
      }
      for (const [index, entry] of journal.entries.entries()) {
        const current = await readTarget(root, entry.path);
        const hash = current && fileDigest(current);
        if (hash === entry.before) continue;
        if (hash !== entry.after)
          throw new Error(`File changed during save recovery: ${entry.path}. Backups were kept.`);
        await parentPath(root, entry.path, true);
        if (entry.before) {
          // A previous recovery may itself have been killed before its rename.
          await fs.rm(`${path.join(root, entry.path)}.restore-${journal.nonce}.tmp`, {
            force: true,
          });
          await replaceDurable(
            path.join(root, entry.path),
            (await readTarget(directory, `old-${index}`))!,
            `restore-${journal.nonce}`,
            entry.mode,
          );
        } else {
          await fs.unlink(path.join(root, entry.path));
          await syncDirectory(path.dirname(path.join(root, entry.path)));
        }
      }
      // Cleanup can itself be interrupted. Publish that all old files are back
      // before deleting any backups, so the next launch need not restore again.
      journal.phase = 'rolled-back';
      await replaceDurable(
        path.join(directory, 'journal.json'),
        JSON.stringify(journal),
        journal.nonce,
      );
      await this.hooks.afterRollback?.();
    }
    for (const entry of journal.entries) {
      try {
        await parentPath(root, entry.path);
        for (const suffix of [`save-${journal.nonce}`, `restore-${journal.nonce}`])
          await fs.rm(`${path.join(root, entry.path)}.${suffix}.tmp`, { force: true });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
    await syncDirectory(path.dirname(directory));
    return journal.phase === 'committed' ? 'committed' : 'rolled-back';
  }
  async commit(root: string, changes: SaveEntry[]): Promise<string | undefined> {
    root = await fs.realpath(root);
    await this.recover(root);
    if (!changes.length) return;
    if (changes.length > 404) throw new Error('This save contains too many files.');
    const directory = this.location(root),
      nonce = randomUUID();
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await syncDirectory(this.dataRoot);
    await fs.mkdir(directory, { mode: 0o700 });
    const journal: Journal = { schema: 1, root, nonce, phase: 'prepared', entries: [] };
    let prepared = false;
    try {
      const seen = new Set<string>();
      for (const [index, entry] of changes.entries()) {
        const name = safeRelative(entry.path);
        if (
          seen.has(name.toLowerCase()) ||
          (entry.data?.byteLength ?? 0) > LIMIT ||
          (entry.before?.byteLength ?? 0) > LIMIT
        )
          throw new Error('Duplicate or oversized file in save.');
        seen.add(name.toLowerCase());
        const current = await readTarget(root, name);
        const before = entry.before && fileDigest(entry.before);
        if ((current && fileDigest(current)) !== before)
          throw new Error(
            `The file ${name} changed while the save was being prepared. Save again to review the conflict.`,
          );
        const mode = current ? (await fs.stat(path.join(root, name))).mode & 0o777 : 0o600;
        if (entry.data) await writeDurable(path.join(directory, `new-${index}`), entry.data);
        if (entry.before) await writeDurable(path.join(directory, `old-${index}`), entry.before);
        journal.entries.push({
          path: name,
          before,
          after: entry.data && fileDigest(entry.data),
          mode,
        });
      }
      await replaceDurable(path.join(directory, 'journal.json'), JSON.stringify(journal), nonce);
      await syncDirectory(path.dirname(directory));
      prepared = true;
      for (const [index, entry] of journal.entries.entries()) {
        const data = changes[index].data;
        if ((data && fileDigest(data)) !== entry.after)
          throw new Error('The prepared file changed.');
        const current = await readTarget(root, entry.path);
        if ((current && fileDigest(current)) !== entry.before)
          throw new Error(`The file ${entry.path} changed during save.`);
        await parentPath(root, entry.path, true);
        if (data)
          await replaceDurable(path.join(root, entry.path), data, `save-${nonce}`, entry.mode);
        else {
          await fs.rm(path.join(root, entry.path), { force: true });
          await syncDirectory(path.dirname(path.join(root, entry.path)));
        }
        await this.hooks.afterApply?.(index);
      }
      journal.phase = 'committed';
      await replaceDurable(path.join(directory, 'journal.json'), JSON.stringify(journal), nonce);
      await this.hooks.afterCommit?.();
    } catch (error) {
      if (!prepared) {
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
      }
      try {
        const result = await this.recover(root);
        if (result === 'committed') return 'Project saved; save-journal cleanup was retried.';
      } catch (recoveryError) {
        throw new Error(`Save was interrupted. ${String((recoveryError as Error).message)}`);
      }
      throw new Error(`Save failed; previous files were restored. ${(error as Error).message}`);
    }
    try {
      await this.recover(root);
    } catch {
      return 'Project saved. Temporary save backups will be cleaned up when you reopen it.';
    }
  }
}
