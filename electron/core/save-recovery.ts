import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SaveJournal, SaveHooks } from './save-transactions';
import type {
  RecoveryVersion,
  SaveRecoveryChoice,
  SaveRecoveryReview,
  SaveRecoveryText,
} from '../../src/shared/save-recovery';
import {
  fileDigest,
  readTarget,
  parentPath,
  syncDirectory,
  writeDurable,
  replaceDurable,
  missing,
} from './save-io';

const versions: RecoveryVersion[] = ['before', 'after', 'current'];
const digest = (data: Buffer | null) => (data === null ? null : fileDigest(data));
const validHash = (value: unknown) =>
  value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const MAX_REVIEW_BYTES = 500 * 1024 * 1024;
type Snapshot = {
  review: SaveRecoveryReview;
  values: Record<RecoveryVersion, Buffer | null | undefined>[];
  modes: number[];
};
type Resolution = {
  schema: 1;
  nonce: string;
  id: string;
  phase: 'prepared' | 'completed';
  copies: string[];
  entries: { path: string; observed: string | null; selected: string | null; mode: number }[];
};

async function readResolution(directory: string, journal: SaveJournal): Promise<Resolution | null> {
  const bytes = await readTarget(directory, 'resolution.json');
  if (bytes === null) return null;
  try {
    if (bytes.length > 200_000) throw new Error();
    const value = JSON.parse(bytes.toString()) as Resolution;
    if (
      !value ||
      value.schema !== 1 ||
      value.nonce !== journal.nonce ||
      typeof value.id !== 'string' ||
      !/^[\w-]{1,80}$/.test(value.id) ||
      !['prepared', 'completed'].includes(value.phase) ||
      !Array.isArray(value.copies) ||
      value.copies.length > 1212 ||
      new Set(value.copies).size !== value.copies.length ||
      value.copies.some((hash) => typeof hash !== 'string' || !validHash(hash)) ||
      !Array.isArray(value.entries) ||
      value.entries.length !== journal.entries.length
    )
      throw new Error();
    value.entries.forEach((entry, index) => {
      if (
        !entry ||
        entry.path !== journal.entries[index].path ||
        !validHash(entry.observed) ||
        !validHash(entry.selected) ||
        (entry.observed !== null && !value.copies.includes(entry.observed)) ||
        (entry.selected !== null && !value.copies.includes(entry.selected)) ||
        !Number.isInteger(entry.mode) ||
        entry.mode < 0 ||
        entry.mode > 0o777
      )
        throw new Error();
    });
    return value;
  } catch {
    throw new Error('The save recovery choices could not be read. All copies were kept.');
  }
}

async function snapshot(root: string, directory: string, journal: SaveJournal): Promise<Snapshot> {
  if (journal.phase !== 'prepared')
    throw new Error('This save is already finished. Reopen the project to finish cleanup.');
  const resolution = await readResolution(directory, journal);
  if (resolution?.phase === 'completed')
    throw new Error('Recovery is already finished. Reopen the project to finish cleanup.');
  const values: Snapshot['values'] = [],
    modes: number[] = [];
  const files: SaveRecoveryReview['files'] = [];
  let bytes = 0;
  for (const [index, entry] of journal.entries.entries()) {
    const current = await readTarget(root, entry.path);
    // Missing or damaged old/new copies may be reviewed, but never selected.
    // Unsafe current targets stop review instead of treating them as deletions.
    const copy = async (name: string, expected: string | null) => {
      if (expected === null) return null;
      try {
        const data = await readTarget(directory, name);
        return data && fileDigest(data) === expected ? data : undefined;
      } catch {
        return undefined;
      }
    };
    const before = await copy(`old-${index}`, entry.before);
    const after = await copy(`new-${index}`, entry.after);
    const item = { before, after, current };
    values.push(item);
    modes.push(
      current === null ? entry.mode : (await fs.lstat(path.join(root, entry.path))).mode & 0o777,
    );
    const descriptions = Object.fromEntries(
      versions.map((version) => {
        const data = item[version];
        bytes += data?.length ?? 0;
        if (bytes > MAX_REVIEW_BYTES)
          throw new Error(
            'These recovery copies exceed the 500 MB review limit. All files were kept.',
          );
        return [
          version,
          {
            available: data !== undefined,
            exists: data !== null,
            bytes: data?.length ?? (data === null ? 0 : null),
            sha256:
              data === undefined ? entry[version === 'before' ? 'before' : 'after'] : digest(data),
          },
        ];
      }),
    ) as SaveRecoveryReview['files'][number]['versions'];
    files.push({
      path: entry.path,
      changedAfterward: digest(current) !== entry.before && digest(current) !== entry.after,
      versions: descriptions,
    });
  }
  // Permission changes and every available copy participate in the review token.
  const token = fileDigest(JSON.stringify([journal, resolution, files, modes]));
  return { review: { token, directory: root, files }, values, modes };
}

export async function previewSaveRecovery(root: string, directory: string, journal: SaveJournal) {
  return (await snapshot(root, directory, journal)).review;
}

export async function readSaveRecoveryText(
  root: string,
  directory: string,
  journal: SaveJournal,
  token: string,
  filename: string,
  version: RecoveryVersion,
): Promise<SaveRecoveryText> {
  const current = await snapshot(root, directory, journal);
  if (current.review.token !== token)
    throw new Error('The recovery files changed. Refresh the review before choosing.');
  const index = journal.entries.findIndex((entry) => entry.path === filename);
  if (index < 0 || !versions.includes(version))
    throw new Error('Unknown recovery file or version.');
  const data = current.values[index][version];
  if (data === undefined)
    throw new Error('This copy is missing or damaged. Choose another version.');
  if (data === null) return { text: '', truncated: false };
  // Binary copies remain selectable and are retained byte for byte. Do not send
  // binary files or whole history archives into the renderer as text.
  if (!/\.(tex|sty|cls|bib|txt|json)$/i.test(filename)) return { text: null, truncated: false };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (text.includes('\0')) return { text: null, truncated: false };
    return { text: text.slice(0, 64_000), truncated: text.length > 64_000 };
  } catch {
    return { text: null, truncated: false };
  }
}

async function retain(directory: string, data: Buffer) {
  const name = `kept-${fileDigest(data)}`;
  const old = await readTarget(directory, name);
  if (old !== null) {
    if (!old.equals(data))
      throw new Error('A retained recovery copy is damaged. All files were kept.');
    return;
  }
  // Publish a complete copy atomically. A kill during this write may leave a
  // temporary file, but never poisons the content-addressed retained copy.
  await replaceDurable(path.join(directory, name), data, randomUUID());
}

export async function resolveSaveRecovery(
  root: string,
  directory: string,
  dataRoot: string,
  journal: SaveJournal,
  token: string,
  choices: SaveRecoveryChoice[],
  hooks: SaveHooks,
): Promise<string> {
  const current = await snapshot(root, directory, journal);
  if (token !== current.review.token)
    throw new Error('The recovery files changed. Refresh the review before choosing.');
  if (!Array.isArray(choices) || choices.length !== journal.entries.length)
    throw new Error('Choose a version for every recovery file.');
  const seen = new Set<string>();
  for (const choice of choices) {
    if (
      !choice ||
      typeof choice.path !== 'string' ||
      seen.has(choice.path) ||
      !versions.includes(choice.version) ||
      !journal.entries.some((entry) => entry.path === choice.path)
    )
      throw new Error('Invalid or duplicate recovery choice.');
    seen.add(choice.path);
  }
  const selected = journal.entries.map((entry, index) => {
    const version = choices.find((choice) => choice.path === entry.path)!.version;
    const data = current.values[index][version];
    if (data === undefined)
      throw new Error(`The selected copy of ${entry.path} is missing or damaged.`);
    return {
      path: entry.path,
      observed: digest(current.values[index].current!),
      selected: digest(data),
      mode: version === 'current' ? current.modes[index] : entry.mode,
    };
  });
  // Retain every available version, not only the ones selected. No project
  // writes occur until all copies and the decision are durably published.
  for (const item of current.values)
    for (const version of versions)
      if (item[version] != null) await retain(directory, item[version]);
  const copies = [
    ...new Set(
      current.values.flatMap((item) =>
        versions.flatMap((version) => (item[version] == null ? [] : [fileDigest(item[version])])),
      ),
    ),
  ].sort();
  const id = randomUUID();
  const decision = {
    schema: 1,
    reviewedAt: new Date().toISOString(),
    review: current.review,
    choices,
    copies: 'kept-<sha256>; null means the file was absent',
  };
  await writeDurable(
    path.join(directory, `decision-${id}.json`),
    JSON.stringify(decision, null, 2),
  );
  await syncDirectory(directory);
  const plan: Resolution = {
    schema: 1,
    nonce: journal.nonce,
    id,
    phase: 'prepared',
    copies,
    entries: selected,
  };
  await replaceDurable(path.join(directory, 'resolution.json'), JSON.stringify(plan), id);
  await hooks.afterResolutionPrepared?.();
  return (await finishSaveRecovery(root, directory, dataRoot, journal, hooks))!;
}

export async function finishSaveRecovery(
  root: string,
  directory: string,
  dataRoot: string,
  journal: SaveJournal,
  hooks: SaveHooks,
): Promise<string | null> {
  const plan = await readResolution(directory, journal);
  if (plan === null) return null;
  if (journal.phase !== 'prepared')
    throw new Error('Unexpected save recovery state. All copies were kept.');
  const check = async (entry: Resolution['entries'][number]) => {
    const hash = digest(await readTarget(root, entry.path));
    if (hash !== entry.observed && hash !== entry.selected)
      throw new Error(
        `The file ${entry.path} changed during recovery. Refresh the review; your edit and all copies were kept.`,
      );
    return hash;
  };
  const selectedBytes = async (entry: Resolution['entries'][number]) => {
    if (entry.selected === null) return null;
    const data = await readTarget(directory, `kept-${entry.selected}`);
    if (data === null || digest(data) !== entry.selected)
      throw new Error('A selected recovery copy is missing or damaged. All files were kept.');
    return data;
  };
  if (plan.phase === 'prepared') {
    // Check all files and retained copies before changing any project file.
    // Unselected copies matter too: overwriting an outside edit is only safe
    // while the retained bytes of that edit are still available.
    for (const hash of plan.copies) {
      const copy = await readTarget(directory, `kept-${hash}`);
      if (copy === null || digest(copy) !== hash)
        throw new Error('A retained recovery copy is missing or damaged. All files were kept.');
    }
    for (const entry of plan.entries) {
      await check(entry);
      await selectedBytes(entry);
    }
    for (const [index, entry] of plan.entries.entries()) {
      if ((await check(entry)) !== entry.selected) {
        const bytes = await selectedBytes(entry);
        await parentPath(root, entry.path, bytes !== null);
        if (bytes === null) {
          await fs.unlink(path.join(root, entry.path));
          await syncDirectory(path.dirname(path.join(root, entry.path)));
        } else {
          const suffix = `recover-${plan.id}`;
          await fs.rm(`${path.join(root, entry.path)}.${suffix}.tmp`, { force: true });
          await replaceDurable(path.join(root, entry.path), bytes, suffix, entry.mode);
        }
      }
      await hooks.afterResolutionApply?.(index);
    }
    for (const entry of plan.entries)
      if (digest(await readTarget(root, entry.path)) !== entry.selected)
        throw new Error(`The file ${entry.path} changed during recovery. All copies were kept.`);
    plan.phase = 'completed';
    await replaceDurable(path.join(directory, 'resolution.json'), JSON.stringify(plan), plan.id);
    await hooks.afterResolutionCommit?.();
  }
  // After the durable completion marker, later outside edits are left alone.
  // Archive the entire original journal, decisions and all copies together.
  for (const entry of journal.entries) {
    try {
      await parentPath(root, entry.path);
      for (const suffix of [
        `save-${journal.nonce}`,
        `restore-${journal.nonce}`,
        `recover-${plan.id}`,
      ])
        await fs.rm(`${path.join(root, entry.path)}.${suffix}.tmp`, { force: true });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  const parent = path.join(dataRoot, 'save-recovery-copies');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw new Error('The recovery archive must be a real directory. All copies were kept.');
  await syncDirectory(dataRoot);
  const archive = path.join(parent, journal.nonce);
  try {
    await fs.lstat(archive);
  } catch (error) {
    if (!missing(error)) throw error;
    await fs.rename(directory, archive);
    await syncDirectory(parent);
    await syncDirectory(path.dirname(directory));
    await hooks.afterResolutionArchive?.();
    return archive;
  }
  throw new Error('The recovery archive already exists. All copies were kept for review.');
}
