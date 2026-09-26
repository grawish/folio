import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeRelative } from './file-io';
import {
  fileDigest,
  readTarget,
  LIMIT,
  missing,
  parentPath,
  syncDirectory,
  writeDurable,
  replaceDurable,
} from './save-io';
export { fileDigest, readTarget } from './save-io';
import {
  previewSaveRecovery,
  readSaveRecoveryText,
  resolveSaveRecovery,
  finishSaveRecovery,
} from './save-recovery';
import type { RecoveryVersion, SaveRecoveryChoice } from '../../src/shared/save-recovery';
export type SaveJournalEntry = {
  path: string;
  before: string | null;
  after: string | null;
  mode: number;
};
export type SaveJournal = {
  schema: 1;
  root: string;
  nonce: string;
  phase: 'prepared' | 'committed' | 'rolled-back';
  entries: SaveJournalEntry[];
};
export type SaveEntry = { path: string; data: Uint8Array | null; before: Uint8Array | null };
export type SaveHooks = {
  afterApply?(index: number): Promise<void>;
  afterCommit?(): Promise<void>;
  afterRollback?(): Promise<void>;
  afterResolutionPrepared?(): Promise<void>;
  afterResolutionApply?(index: number): Promise<void>;
  afterResolutionCommit?(): Promise<void>;
  afterResolutionArchive?(): Promise<void>;
};

export class SaveTransactions {
  constructor(
    readonly dataRoot: string,
    private hooks: SaveHooks = {},
  ) {}
  private location(root: string) {
    return path.join(this.dataRoot, 'save-transactions', fileDigest(root));
  }
  private async readJournal(root: string): Promise<SaveJournal | null> {
    const directory = this.location(root);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Invalid save journal directory.');
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    let raw: SaveJournal;
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
      typeof raw.nonce !== 'string' ||
      !/^[\w-]{1,80}$/.test(raw.nonce) ||
      !['prepared', 'committed', 'rolled-back'].includes(raw.phase) ||
      !Array.isArray(raw.entries) ||
      raw.entries.length > 404
    )
      throw new Error('Invalid interrupted save record. Its backups were kept.');
    const seen = new Set<string>();
    for (const entry of raw.entries) {
      if (!entry || typeof entry !== 'object')
        throw new Error('Invalid interrupted save entry. Its backups were kept.');
      const name = safeRelative(entry.path).toLowerCase();
      if (
        seen.has(name) ||
        (entry.before !== null &&
          (typeof entry.before !== 'string' || !/^[a-f0-9]{64}$/.test(entry.before))) ||
        (entry.after !== null &&
          (typeof entry.after !== 'string' || !/^[a-f0-9]{64}$/.test(entry.after))) ||
        !Number.isInteger(entry.mode) ||
        entry.mode < 0 ||
        entry.mode > 0o777
      )
        throw new Error('Invalid interrupted save entry. Its backups were kept.');
      seen.add(name);
    }
    return raw;
  }
  async review(root: string) {
    root = await fs.realpath(root);
    const journal = await this.readJournal(root);
    if (!journal) return null;
    return previewSaveRecovery(root, this.location(root), journal);
  }

  async reviewText(root: string, token: string, filename: string, version: RecoveryVersion) {
    root = await fs.realpath(root);
    const journal = await this.readJournal(root);
    if (!journal) throw new Error('This save no longer needs recovery.');
    return readSaveRecoveryText(root, this.location(root), journal, token, filename, version);
  }

  async resolve(root: string, token: string, choices: SaveRecoveryChoice[]) {
    root = await fs.realpath(root);
    const journal = await this.readJournal(root);
    if (!journal) throw new Error('This save no longer needs recovery.');
    return resolveSaveRecovery(
      root,
      this.location(root),
      this.dataRoot,
      journal,
      token,
      choices,
      this.hooks,
    );
  }

  async recover(root: string): Promise<'none' | 'rolled-back' | 'committed' | 'resolved'> {
    root = await fs.realpath(root);
    const journal = await this.readJournal(root);
    if (!journal) return 'none';
    const directory = this.location(root);
    if (await finishSaveRecovery(root, directory, this.dataRoot, journal, this.hooks))
      return 'resolved';
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
    const journal: SaveJournal = { schema: 1, root, nonce, phase: 'prepared', entries: [] };
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
