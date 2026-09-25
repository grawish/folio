import { randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { safeRelative } from './file-io';
import { fileDigest, readTarget } from './save-transactions';
import type { InterruptedImport } from '../../src/shared/types';

const MiB = 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
type Identity = { dev: number; ino: number; birthtimeMs: number };
type Entry = { path: string; bytes: number; digest: string };
type Journal = {
  schema: 1;
  id: string;
  name: string;
  createdAt: string;
  parent: string;
  parentIdentity: Identity;
  directoryIdentity?: Identity;
  mainFile: string;
  phase: 'staging' | 'prepared' | 'copying' | 'complete' | 'discarding';
  entries: Entry[];
  written: number;
};
export type ImportHooks = {
  afterStageFile?(index: number): Promise<void>;
  afterPrepare?(): Promise<void>;
  afterDirectory?(): Promise<void>;
  afterWrite?(index: number): Promise<void>;
  afterComplete?(): Promise<void>;
  afterDiscard?(): Promise<void>;
};
const identity = (stat: Identity): Identity => ({
  dev: stat.dev,
  ino: stat.ino,
  birthtimeMs: stat.birthtimeMs,
});
const sameIdentity = (a: Identity, b: Identity) =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const validIdentity = (value: Identity) =>
  value &&
  [value.dev, value.ino, value.birthtimeMs].every(
    (number) => Number.isFinite(number) && number >= 0,
  );
const folderName = (journal: Journal) =>
  (journal.name
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .slice(0, 60)
    .replace(/[\uD800-\uDBFF]$/, '') || 'Imported resume') +
  '-' +
  journal.id;
const target = (journal: Journal) => path.join(journal.parent, folderName(journal));

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function writeImportFile(filename: string, data: Uint8Array) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function realDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
    throw new Error('An import folder moved or was replaced by a link. Its files were kept.');
  return stat;
}
async function makeParents(root: string, relative: string) {
  let parent = root;
  for (const part of safeRelative(relative).split('/').slice(0, -1)) {
    const next = path.join(parent, part);
    try {
      await fs.mkdir(next, { mode: 0o700 });
      await syncDirectory(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await realDirectory(next);
    parent = next;
  }
}

// Copies are staged before touching the selected destination. The durable
// inventory lets recovery distinguish our partial writes from outside edits.
export class ImportTransactions {
  constructor(
    private dataRoot: string,
    private write = writeImportFile,
    private hooks: ImportHooks = {},
  ) {}
  private async base() {
    await fs.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const base = path.join(await fs.realpath(this.dataRoot), 'import-transactions');
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    await realDirectory(base);
    return base;
  }
  private async location(id: string) {
    if (!uuid.test(id)) throw new Error('Choose an import from the recovery list.');
    return path.join(await this.base(), id);
  }
  private validate(journal: Journal, id: string) {
    if (
      !journal ||
      journal.schema !== 1 ||
      journal.id !== id ||
      typeof journal.name !== 'string' ||
      !journal.name ||
      journal.name.length > 120 ||
      typeof journal.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(journal.createdAt)) ||
      typeof journal.parent !== 'string' ||
      !path.isAbsolute(journal.parent) ||
      path.normalize(journal.parent) !== journal.parent ||
      !validIdentity(journal.parentIdentity) ||
      (journal.directoryIdentity && !validIdentity(journal.directoryIdentity)) ||
      !['staging', 'prepared', 'copying', 'complete', 'discarding'].includes(journal.phase) ||
      !Array.isArray(journal.entries) ||
      !journal.entries.length ||
      journal.entries.length > 204 ||
      !Number.isInteger(journal.written) ||
      journal.written < 0 ||
      journal.written > journal.entries.length ||
      (journal.phase === 'complete' && journal.written !== journal.entries.length)
    )
      throw new Error('The import recovery record is damaged. Its files were kept.');
    const names = new Set<string>();
    let bytes = 0;
    for (const entry of journal.entries) {
      const name = safeRelative(entry.path);
      if (
        names.has(name.toLowerCase()) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.bytes > (name === 'resume.folio' ? 100 : 25) * MiB ||
        !/^[a-f0-9]{64}$/.test(entry.digest)
      )
        throw new Error('The import file inventory is damaged. Its files were kept.');
      names.add(name.toLowerCase());
      bytes += entry.bytes;
    }
    if (bytes > 136 * MiB || !names.has(safeRelative(journal.mainFile).toLowerCase()))
      throw new Error('The import file inventory exceeds its limits.');
  }
  private async read(id: string) {
    const directory = await this.location(id);
    await realDirectory(directory);
    const bytes = await readTarget(directory, 'journal.json');
    if (!bytes || bytes.length > 200_000)
      throw new Error('The import recovery record is missing or too large.');
    const journal = JSON.parse(bytes.toString()) as Journal;
    this.validate(journal, id);
    return { directory, journal };
  }
  private async save(directory: string, journal: Journal) {
    const temporary = path.join(directory, 'journal-' + randomUUID() + '.tmp');
    try {
      await writeImportFile(temporary, Buffer.from(JSON.stringify(journal)));
      await fs.rename(temporary, path.join(directory, 'journal.json'));
      await syncDirectory(directory);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async create(
    id: string,
    name: string,
    mainFile: string,
    parent: string,
    files: Map<string, Buffer>,
  ) {
    const base = await this.base();
    const records = (await fs.readdir(base)).filter((name) => uuid.test(name));
    if (records.length >= 10)
      throw new Error('Review interrupted imports before importing another ZIP.');
    let stagedBytes = 0;
    for (const record of records) {
      const { journal } = await this.read(record);
      stagedBytes += journal.entries.reduce((total, entry) => total + entry.bytes, 0);
    }
    const entries = [...files].map(([name, bytes]) => ({
      path: name,
      bytes: bytes.length,
      digest: fileDigest(bytes),
    }));
    if (stagedBytes + entries.reduce((total, entry) => total + entry.bytes, 0) > 512 * MiB)
      throw new Error('Import recovery copies reached 512 MB. Review interrupted imports first.');
    parent = await fs.realpath(parent);
    const journal: Journal = {
      schema: 1,
      id,
      name,
      mainFile,
      parent,
      createdAt: new Date().toISOString(),
      parentIdentity: identity(await realDirectory(parent)),
      phase: 'staging',
      entries,
      written: 0,
    };
    this.validate(journal, id);
    const directory = await this.location(id);
    await fs.mkdir(directory, { mode: 0o700 });
    await syncDirectory(base);
    await this.save(directory, journal);
    await fs.mkdir(path.join(directory, 'payload'), { mode: 0o700 });
    for (const [index, entry] of entries.entries()) {
      await writeImportFile(path.join(directory, 'payload', String(index)), files.get(entry.path)!);
      await this.hooks.afterStageFile?.(index);
    }
    await syncDirectory(path.join(directory, 'payload'));
    journal.phase = 'prepared';
    await this.save(directory, journal);
    await this.hooks.afterPrepare?.();
  }
  private async payload(directory: string, entry: Entry, index: number) {
    const data = await readTarget(directory, 'payload/' + index);
    if (!data || data.length !== entry.bytes || fileDigest(data) !== entry.digest)
      throw new Error('An import recovery copy is damaged. The destination files were kept.');
    return data;
  }
  private async inspect(journal: Journal, directory: string, verifyPayload = true) {
    const parent = await realDirectory(journal.parent);
    if (!sameIdentity(parent, journal.parentIdentity))
      throw new Error('The destination folder was replaced. Its files were kept.');
    const folder = target(journal);
    let stat;
    try {
      stat = await realDirectory(folder);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (stat && journal.directoryIdentity && !sameIdentity(stat, journal.directoryIdentity))
      throw new Error('The imported folder was replaced. Its files were kept.');
    if (stat && !journal.directoryIdentity && (await fs.readdir(folder)).length)
      throw new Error('The destination now contains unrecognized files. Nothing was changed.');
    if (journal.phase === 'staging' && stat)
      throw new Error('The destination changed before copying started. Nothing was changed.');
    const allowed = new Map(journal.entries.map((entry, index) => [entry.path, { entry, index }]));
    const directories = new Set<string>();
    for (const entry of journal.entries) {
      const parts = entry.path.split('/');
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    }
    if (verifyPayload)
      for (const [index, entry] of journal.entries.entries())
        await this.payload(directory, entry, index);
    let complete = !!stat;
    const seen = new Set<string>();
    const visit = async (relative: string) => {
      const entries = await fs.readdir(path.join(folder, relative), { withFileTypes: true });
      for (const file of entries) {
        const name = relative ? relative + '/' + file.name : file.name;
        const value = allowed.get(name);
        if (file.isDirectory() && directories.has(name)) {
          await realDirectory(path.join(folder, name));
          await visit(name);
        } else if (file.isFile() && value) {
          const stat = await fs.lstat(path.join(folder, name));
          if (stat.nlink !== 1)
            throw new Error('An imported file has another hard link. Its files were kept.');
          const actual = await readTarget(folder, name);
          const expected = await this.payload(directory, value.entry, value.index);
          if (
            !actual ||
            actual.length > expected.length ||
            !expected.subarray(0, actual.length).equals(actual) ||
            (value.index < journal.written && actual.length !== expected.length) ||
            value.index > journal.written
          )
            throw new Error(
              'Files in this import changed outside Folio. Nothing was overwritten or removed.',
            );
          if (actual.length !== expected.length) complete = false;
          seen.add(name);
        } else
          throw new Error(
            'This import contains new files or links. Nothing was overwritten or removed.',
          );
      }
    };
    if (stat) await visit('');
    if (stat && journal.phase !== 'discarding')
      for (const entry of journal.entries.slice(0, journal.written))
        if (!seen.has(entry.path))
          throw new Error(
            'A completed import file was removed outside Folio. Nothing was changed.',
          );
    if (seen.size !== journal.entries.length) complete = false;
    return { folder, exists: !!stat, complete, stat };
  }
  async resume(id: string) {
    const { journal, directory } = await this.read(id);
    if (journal.phase === 'staging')
      throw new Error(
        'Import preparation did not finish. Discard its recovery copy and choose the original ZIP again.',
      );
    if (journal.phase === 'discarding')
      throw new Error(
        'This import was being discarded. Finish that cleanup before retrying the ZIP.',
      );
    const checked = await this.inspect(journal, directory);
    if (journal.phase === 'complete' && checked.complete)
      return { directory: checked.folder, mainFile: journal.mainFile };
    if (!checked.exists) {
      if (journal.directoryIdentity)
        throw new Error('The imported folder was moved or removed. Its recovery copy was kept.');
      await fs.mkdir(checked.folder, { mode: 0o700 });
      await syncDirectory(journal.parent);
      await this.hooks.afterDirectory?.();
    }
    journal.directoryIdentity ??= identity(await realDirectory(checked.folder));
    journal.phase = 'copying';
    await this.save(directory, journal);
    for (const [index, entry] of journal.entries.entries()) {
      if (index < journal.written) continue;
      const data = await this.payload(directory, entry, index);
      const destination = path.join(checked.folder, entry.path);
      if (!sameIdentity(await realDirectory(checked.folder), journal.directoryIdentity))
        throw new Error('The imported folder was replaced. Its files were kept.');
      await makeParents(checked.folder, entry.path);
      const existing = await readTarget(checked.folder, entry.path);
      if (!existing) await this.write(destination, data);
      else if (!existing.equals(data)) {
        // Continue only a proven prefix; never truncate or replace an outside edit.
        const handle = await fs.open(
          destination,
          constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > data.length)
            throw new Error('An imported file changed. Its contents were kept.');
          const actual = await handle.readFile();
          if (!data.subarray(0, actual.length).equals(actual))
            throw new Error('An imported file changed. Its contents were kept.');
          await handle.writeFile(data.subarray(actual.length));
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await syncDirectory(path.dirname(destination));
      const copied = await readTarget(checked.folder, entry.path);
      if (!copied?.equals(data))
        throw new Error('A copied file changed before it could be verified.');
      journal.written = index + 1;
      await this.save(directory, journal);
      await this.hooks.afterWrite?.(index);
    }
    const verified = await this.inspect(journal, directory);
    if (!verified.complete)
      throw new Error('The imported files could not be verified. Their recovery copy was kept.');
    journal.phase = 'complete';
    await this.save(directory, journal);
    await this.hooks.afterComplete?.();
    return { directory: checked.folder, mainFile: journal.mainFile };
  }
  async list(): Promise<InterruptedImport[]> {
    const base = await this.base();
    const result: InterruptedImport[] = [];
    for (const id of (await fs.readdir(base)).filter((name) => uuid.test(name)).sort()) {
      let item: InterruptedImport = {
        id,
        name: 'Interrupted import',
        directory: null,
        hasFolder: false,
        createdAt: '',
        state: 'blocked',
        message: 'The recovery record could not be read. Its copies are still stored locally.',
        canResume: false,
        canDiscard: false,
      };
      try {
        const { journal, directory } = await this.read(id);
        item = {
          ...item,
          name: journal.name,
          directory: target(journal),
          hasFolder: await fs.lstat(target(journal)).then(
            (stat) => stat.isDirectory(),
            () => false,
          ),
          createdAt: journal.createdAt,
        };
        const check = await this.inspect(journal, directory, journal.phase !== 'staging');
        const missingFolder = !check.exists && !!journal.directoryIdentity;
        item = {
          ...item,
          state:
            journal.phase === 'staging'
              ? 'preparing'
              : journal.phase === 'discarding'
                ? 'discarding'
                : check.complete
                  ? 'complete'
                  : 'partial',
          canResume: !['staging', 'discarding'].includes(journal.phase) && !missingFolder,
          canDiscard: true,
          hasFolder: check.exists,
          message:
            journal.phase === 'staging'
              ? 'Preparation stopped before files were copied. Discard this recovery copy and choose the ZIP again.'
              : journal.phase === 'discarding'
                ? 'Cleanup was interrupted. Finish discarding this copy.'
                : missingFolder
                  ? 'The new folder was moved or removed. Its local recovery copy was kept.'
                  : check.complete
                    ? 'The files finished copying before the import was acknowledged. Open the recovered project.'
                    : 'Copying stopped before the import finished. You can finish it using the saved recovery copy.',
        };
      } catch (error) {
        item.message = (error as Error).message;
      }
      result.push(item);
    }
    return result;
  }
  async count() {
    return (await fs.readdir(await this.base())).filter((name) => uuid.test(name)).length;
  }
  async reveal(id: string) {
    const { journal } = await this.read(id);
    const stat = await realDirectory(target(journal));
    if (!journal.directoryIdentity || !sameIdentity(stat, journal.directoryIdentity))
      throw new Error(
        'The import folder could not be verified. Check the listed location in Finder.',
      );
    return target(journal);
  }
  async discard(
    id: string,
    remove = (directory: string) => fs.rm(directory, { recursive: true }),
    beforeRemove?: (directory: string) => void,
  ) {
    const { journal, directory } = await this.read(id);
    const checked = await this.inspect(journal, directory, journal.phase !== 'staging');
    if (checked.exists) beforeRemove?.(checked.folder);
    journal.phase = 'discarding';
    await this.save(directory, journal);
    if (checked.exists) await remove(checked.folder);
    await this.hooks.afterDiscard?.();
    await this.forget(id);
  }
  async forget(id: string) {
    const directory = await this.location(id);
    // Only app-owned staging records are removed. The selected project folder
    // is untouched, including when its recovery inventory is damaged.
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) await fs.unlink(directory);
    else {
      await realDirectory(directory);
      await fs.rm(directory, { recursive: true });
    }
    await syncDirectory(path.dirname(directory));
  }
  async has(id: string) {
    try {
      await fs.lstat(await this.location(id));
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }
  async acknowledge(id: string) {
    const { journal } = await this.read(id);
    if (journal.phase !== 'complete') throw new Error('Finish the import before acknowledging it.');
    await this.forget(id);
  }
}
