import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite, safeRelative, readWithin } from './file-io';
import { SaveTransactions, fileDigest, readTarget, type SaveEntry } from './save-transactions';
import { replaceDurable, parentPath } from './save-io';
import type {
  RecoveryVersion,
  SaveRecoveryChoice,
  SaveRecoveryResult,
} from '../../src/shared/save-recovery';
import { validateRemovedFiles } from '../../src/shared/project-files';
import { ProjectScanner, compareDisk, diskKind } from './project-scan';
import { PROJECT_MANIFEST_LIMIT, readProjectManifest } from './project-manifest';
import { templateCatalog } from '../../src/shared/template-catalog';
import {
  adoptRuntime,
  projectRuntime,
  validateRuntimePin,
  type RuntimePin,
} from '../../src/shared/runtime';
export { atomicWrite, safeRelative } from './file-io';
import type {
  Project,
  ProjectFile,
  RecentProject,
  RemovedProjectFile,
} from '../../src/shared/types';

export const TEXT_EXTENSIONS = new Set(['.tex', '.sty', '.cls', '.bib', '.txt']);
export const ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.otf', '.ttf', '.eps']);
const MAX_BYTES = 25 * 1024 * 1024;

export function validateProject(value: unknown): Project {
  const p = value as Project;
  if (
    !p ||
    typeof p.id !== 'string' ||
    !/^[\w-]{1,80}$/.test(p.id) ||
    typeof p.name !== 'string' ||
    p.name.length > 120 ||
    !Number.isSafeInteger(p.revision) ||
    p.revision < 0 ||
    !Array.isArray(p.files) ||
    p.files.length < 1 ||
    p.files.length > 100
  ) {
    throw new Error('This project is invalid or exceeds the 100-file limit.');
  }
  const seen = new Set<string>();
  let bytes = 0;
  const files = p.files.map((file) => {
    const name = safeRelative(file.path);
    if (!TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) || typeof file.content !== 'string')
      throw new Error('Unsupported source file.');
    if (seen.has(name.toLowerCase()))
      throw new Error('Project filenames must be unique, ignoring case.');
    seen.add(name.toLowerCase());
    bytes += Buffer.byteLength(file.content);
    if (Buffer.byteLength(file.content) > 2 * 1024 * 1024 || bytes > 5 * 1024 * 1024)
      throw new Error('Project source is too large.');
    return { path: name, content: file.content };
  });
  const mainFile = safeRelative(p.mainFile);
  if (!mainFile.endsWith('.tex') || !files.some((f) => f.path === mainFile))
    throw new Error('Choose a .tex file in this project as the main file.');
  return {
    id: p.id,
    name: p.name,
    revision: p.revision,
    files,
    mainFile,
    removedFiles: validateRemovedFiles(p.removedFiles),
    runtime: validateRuntimePin(p.runtime),
    templateId: templateCatalog.some((template) => template.id === p.templateId)
      ? p.templateId
      : undefined,
    templateVersion:
      templateCatalog.some((template) => template.id === p.templateId) &&
      Number.isSafeInteger(p.templateVersion) &&
      p.templateVersion! > 0
        ? p.templateVersion
        : undefined,
  };
}

export function removedFileArchive(files: RemovedProjectFile[] = []): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, files: validateRemovedFiles(files) }));
}

export function readRemovedFileArchive(data: Uint8Array): RemovedProjectFile[] {
  if (data.byteLength > 10 * 1024 * 1024 + 128)
    throw new Error('The removed-file archive exceeds 10 MB.');
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.files))
    throw new Error('The removed-file archive is invalid.');
  return validateRemovedFiles(raw.files);
}

export function fingerprint(project: Project): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        project.mainFile,
        [...project.files].sort((a, b) => a.path.localeCompare(b.path)),
        ...(project.runtime ? [validateRuntimePin(project.runtime)] : []),
      ]),
    )
    .digest('hex');
}

export async function readProjectTree(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  let bytes = 0;
  const visit = async (relative = '') => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'build', 'dist'].includes(entry.name))
        continue;
      if (entry.isSymbolicLink())
        throw new Error('Remove symbolic links from the project before opening it.');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      safeRelative(name);
      if (entry.isDirectory()) {
        if (name.split('/').length > 8) throw new Error('Project folders are nested too deeply.');
        await visit(name);
      } else if (
        TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) ||
        ASSET_EXTENSIONS.has(path.extname(name).toLowerCase())
      ) {
        if (result.size >= 200)
          throw new Error('This preview supports projects with up to 200 source and asset files.');
        const data = await readWithin(root, name);
        bytes += data.length;
        if (bytes > MAX_BYTES) throw new Error('This preview supports projects up to 25 MB.');
        result.set(name, data);
      }
    }
  };
  await visit();
  return result;
}

type Registration = { directory: string; baseline: Map<string, string> };

export class ProjectStore {
  private registered = new Map<string, Registration>();
  private scanner = new ProjectScanner();

  private saves: Promise<unknown> = Promise.resolve();
  resolvedSaveCopies: string | null = null;
  constructor(
    readonly dataRoot: string,
    private transactions = new SaveTransactions(dataRoot),
    private defaultRuntime?: () => RuntimePin | undefined,
  ) {}

  private hash(data: Uint8Array | string) {
    return createHash('sha256').update(data).digest('hex');
  }

  directory(id: string) {
    return this.registered.get(id)?.directory;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.saves.then(action);
    this.saves = operation.catch(() => {});
    return operation;
  }

  open(directory: string, selectedMain?: string): Promise<Project> {
    return this.serial(async () => {
      await this.requireNoPendingResolution();
      return this.openSnapshot(directory, selectedMain);
    });
  }

  private async openSnapshot(directory: string, selectedMain?: string): Promise<Project> {
    const root = await fs.realpath(directory);
    await this.transactions.recover(root);
    const tree = await readProjectTree(root);
    const files: ProjectFile[] = [...tree]
      .filter(([p]) => TEXT_EXTENSIONS.has(path.extname(p).toLowerCase()))
      .map(([p, data]) => ({ path: p, content: data.toString('utf8') }));
    let manifest: Uint8Array | undefined;
    try {
      manifest = await readWithin(root, 'resume.project.json', PROJECT_MANIFEST_LIMIT);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'The project manifest could not be read. It must be a regular file no larger than 64 KB inside your project.',
        );
    }
    const metadata = manifest ? readProjectManifest(manifest) : {};
    const mainFile =
      selectedMain ??
      metadata.mainFile ??
      files.find((f) => f.path === 'main.tex')?.path ??
      files.find((f) => f.path.endsWith('.tex'))?.path;
    const project = validateProject({
      id:
        typeof metadata.id === 'string' && /^[\w-]{1,80}$/.test(metadata.id)
          ? metadata.id
          : randomUUID(),
      name: metadata.name ?? path.basename(root),
      revision:
        typeof metadata.revision === 'number' &&
        Number.isSafeInteger(metadata.revision) &&
        metadata.revision >= 0
          ? metadata.revision
          : 0,
      files,
      mainFile,
      templateId: metadata.templateId,
      templateVersion: metadata.templateVersion,
      runtime: adoptRuntime(projectRuntime(metadata), this.defaultRuntime?.()),
    });
    try {
      project.removedFiles = readRemovedFileArchive(
        await readWithin(root, 'resume.trash', 10 * 1024 * 1024 + 128),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`Saved file copies could not be read: ${(error as Error).message}`);
    }
    const baseline = new Map([...tree].map(([name, data]) => [name, this.hash(data)]));
    for (const name of ['resume.project.json', 'resume.folio', 'resume.trash']) {
      const data = await readTarget(root, name);
      if (data) baseline.set(name, this.hash(data));
    }
    this.registered.set(project.id, { directory: root, baseline });
    await this.addRecent(root, project.name);
    return { ...project, directory: root };
  }

  async assets(project: Project) {
    await this.saves;
    await this.requireNoPendingResolution();
    const directory = this.directory(project.id);
    if (!directory) return new Map<string, Buffer>();
    await this.transactions.recover(directory);
    const tree = await readProjectTree(directory);
    return new Map([...tree].filter(([p]) => ASSET_EXTENSIONS.has(path.extname(p).toLowerCase())));
  }

  inspectChanges(id: string) {
    const operation = this.saves.then(async () => {
      const registration = this.registered.get(id);
      if (!registration) return null;
      return compareDisk(
        id,
        registration.baseline,
        await this.scanner.scan(registration.directory),
      );
    });
    this.saves = operation.catch(() => {});
    return operation;
  }

  async requireReviewedDisk(id: string) {
    const changes = await this.inspectChanges(id);
    if (changes?.changes.some((file) => file.kind !== 'project'))
      throw new Error(
        'Files changed outside Folio. Review the changes before building, sending a request or exporting.',
      );
  }

  useDiskSource(value: unknown, token: string, mainFile: string): Promise<Project> {
    const project = validateProject(value);
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
      throw new Error('Check the current disk changes before reloading.');
    const operation = this.saves.then(async () => {
      const registration = this.registered.get(project.id);
      if (!registration) throw new Error('Open the project before reloading its source.');
      const snapshot = await this.scanner.scan(registration.directory, true);
      const report = compareDisk(project.id, registration.baseline, snapshot);
      if (report.token !== token)
        throw new Error(
          'Files changed again while you were reviewing. Check again before reloading.',
        );
      const copies = [...(project.removedFiles ?? [])];
      for (const file of project.files) {
        if (
          snapshot.sources.some((disk) => disk.path === file.path && disk.content === file.content)
        )
          continue;
        if (!copies.some((copy) => copy.path === file.path && copy.content === file.content))
          copies.push({
            ...file,
            id: randomUUID(),
            removedAt: new Date().toISOString(),
            reason: 'editor-copy',
          });
      }
      const next = validateProject({
        ...project,
        files: snapshot.sources,
        mainFile,
        removedFiles: copies,
        revision: project.revision + 1,
      });
      // Accept source and current assets only. Changed manifest/history/trash
      // still require the existing explicit save conflict choice.
      const baseline = new Map(
        [...registration.baseline].filter(([name]) => diskKind(name) === 'project'),
      );
      for (const [name, hash] of snapshot.hashes)
        if (diskKind(name) !== 'project') baseline.set(name, hash);
      const updated = { directory: registration.directory, baseline };
      // Commit recovery before acknowledging the baseline or replacing UI text.
      await this.writeRecovery(next, updated);
      this.registered.set(project.id, updated);
      return { ...next, directory: registration.directory };
    });
    this.saves = operation.catch(() => {});
    return operation;
  }

  save(
    value: Project,
    selectedDirectory?: string,
    overwrite = false,
    history?: (projectId: string) => Promise<Uint8Array>,
    requireCleanDisk = false,
  ): Promise<{
    conflict: boolean;
    directory: string;
    projectId?: string;
    warning?: string;
    removedFiles?: RemovedProjectFile[];
  }> {
    const project = validateProject(value);
    const operation = this.saves.then(() =>
      this.saveSnapshot(project, selectedDirectory, overwrite, history, requireCleanDisk),
    );
    this.saves = operation.catch(() => {});
    return operation;
  }

  saveWithAssets(
    value: Project,
    additions: Map<string, Buffer>,
    history?: (id: string) => Promise<Uint8Array>,
  ) {
    const project = validateProject(value);
    if (
      additions.size > 200 ||
      [...additions.values()].reduce((sum, bytes) => sum + bytes.length, 0) > MAX_BYTES
    )
      throw new Error('New assets exceed the project size limit.');
    const assets = new Map(
      [...additions].map(([name, bytes]) => {
        safeRelative(name);
        if (!ASSET_EXTENSIONS.has(path.extname(name).toLowerCase()))
          throw new Error('Unsupported project asset.');
        return [name, Buffer.from(bytes)] as const;
      }),
    );
    const operation = this.saves.then(() =>
      this.saveSnapshot(project, undefined, false, history, true, assets),
    );
    this.saves = operation.catch(() => {});
    return operation;
  }

  private async saveSnapshot(
    project: Project,
    selectedDirectory?: string,
    overwrite = false,
    history?: (projectId: string) => Promise<Uint8Array>,
    requireCleanDisk = false,
    additions = new Map<string, Buffer>(),
  ) {
    await this.requireNoPendingResolution();
    const registration = this.registered.get(project.id);
    if (requireCleanDisk && (!registration || selectedDirectory || overwrite))
      throw new Error('Save this project once before using autosave.');
    const directory = await fs.realpath(selectedDirectory ?? registration?.directory ?? '');
    await this.transactions.recover(directory);
    if (requireCleanDisk) {
      const changes = compareDisk(
        project.id,
        registration!.baseline,
        await this.scanner.scan(directory, true),
      );
      if (changes.changes.length) return { conflict: true, directory };
    }
    const copying = registration && registration.directory !== directory;
    const projectId = copying ? randomUUID() : project.id;
    const files = new Map<string, Buffer>(
      project.files.map((file) => [file.path, Buffer.from(file.content)]),
    );
    const assets = new Set<string>();
    if (additions.size) {
      const tree = await readProjectTree(directory);
      const spellings = new Map<string, string>();
      for (const name of [...tree.keys(), ...files.keys(), ...additions.keys()]) {
        const parts = name.split('/');
        for (let length = 1; length < parts.length; length++) {
          const parent = parts.slice(0, length).join('/');
          const folded = parent.normalize('NFC').toLowerCase();
          if (spellings.has(folded) && spellings.get(folded) !== parent)
            throw new Error('Use the existing folder spelling, including letter case and accents.');
          spellings.set(folded, parent);
        }
      }
      const existing = new Set(
        [...tree.keys(), ...files.keys()].map((name) => name.normalize('NFC').toLowerCase()),
      );
      for (const [name, bytes] of additions) {
        const folded = name.normalize('NFC').toLowerCase();
        if (existing.has(folded))
          throw new Error(`A file named ${name} already exists. Choose a new font setup.`);
        existing.add(folded);
        files.set(name, bytes);
        assets.add(name);
      }
      const combined = new Map(
        [...tree].filter(([name]) => !TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())),
      );
      for (const [name, bytes] of files) combined.set(name, bytes);
      if (
        combined.size > 200 ||
        [...combined.values()].reduce((sum, data) => sum + data.length, 0) > MAX_BYTES
      )
        throw new Error('Adding these fonts would exceed the project limit of 200 files or 25 MB.');
    }
    const removedFiles = [...(project.removedFiles ?? [])];
    const removals: SaveEntry[] = [];
    if (registration?.directory === directory) {
      for (const [name, expected] of registration.baseline) {
        if (!TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) || files.has(name)) continue;
        if ([...files.keys()].some((next) => next.toLowerCase() === name.toLowerCase()))
          throw new Error('Save a different filename first when changing only letter case.');
        const before = await readTarget(directory, name);
        if (!before) continue;
        if (!overwrite && fileDigest(before) !== expected) return { conflict: true, directory };
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before);
        } catch {
          throw new Error(
            `The file ${name} is not UTF-8 text. Keep or move it before saving this removal.`,
          );
        }
        // Preserve even a newer external version before an explicitly approved
        // replacement. The user's unsaved removed buffer is a separate copy.
        if (!removedFiles.some((copy) => copy.path === name && copy.content === content))
          removedFiles.push({
            id: randomUUID(),
            path: name,
            content,
            removedAt: new Date().toISOString(),
            reason: 'disk-copy',
          });
        removals.push({ path: name, data: null, before });
      }
    }
    if (copying) {
      await this.transactions.recover(registration.directory);
      for (const [name, data] of await readProjectTree(registration.directory)) {
        if (!ASSET_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
        files.set(name, data);
        assets.add(name);
      }
    }
    files.set(
      'resume.project.json',
      Buffer.from(
        JSON.stringify(
          {
            schemaVersion: 2,
            id: projectId,
            revision: project.revision,
            name: project.name,
            mainFile: project.mainFile,
            templateId: project.templateId,
            templateVersion: project.templateVersion,
            runtime: project.runtime,
            engine: project.runtime ? `tectonic@${project.runtime.version}` : undefined,
            bundle: project.runtime?.bundle,
          },
          null,
          2,
        ),
      ),
    );
    // Assemble history before touching source or assets. Save As embeds the new
    // identity in the same transaction as its manifest and file contents.
    if (history) files.set('resume.folio', Buffer.from(await history(projectId)));
    const changes: SaveEntry[] = [];
    const prepareFile = async (name: string, data: Buffer) => {
      const before = await readTarget(directory, name);
      const currentHash = before && fileDigest(before),
        nextHash = fileDigest(data);
      const baseline =
        registration?.directory === directory ? registration.baseline.get(name) : undefined;
      if (assets.has(name) && before && currentHash !== nextHash)
        throw new Error(`Save As would overwrite asset ${name}. Choose a new folder.`);
      if (
        !overwrite &&
        currentHash !== nextHash &&
        (baseline ? currentHash !== baseline : before !== null)
      )
        return false;
      if (
        overwrite &&
        before &&
        currentHash !== nextHash &&
        currentHash !== baseline &&
        TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())
      ) {
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before);
        } catch {
          throw new Error(
            `The file ${name} is not UTF-8 text. Keep or move it before replacing it.`,
          );
        }
        if (!removedFiles.some((copy) => copy.path === name && copy.content === content))
          removedFiles.push({
            path: name,
            content,
            id: randomUUID(),
            removedAt: new Date().toISOString(),
            reason: 'disk-copy',
          });
      }
      if (currentHash !== nextHash) changes.push({ path: name, data, before });
      return true;
    };
    for (const [name, data] of files)
      if (!(await prepareFile(name, data))) return { conflict: true, directory };
    const removedArchive = removedFileArchive(removedFiles);
    files.set('resume.trash', removedArchive);
    if (!(await prepareFile('resume.trash', removedArchive))) return { conflict: true, directory };
    const warning = await this.transactions.commit(directory, [...changes, ...removals]);
    this.registered.set(projectId, {
      directory,
      baseline: new Map([
        ...(registration?.directory === directory
          ? [...registration.baseline].filter(
              ([name]) => !TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()),
            )
          : []),
        ...[...files].map(([name, data]) => [name, fileDigest(data)] as [string, string]),
      ]),
    });
    let recentWarning: string | undefined;
    try {
      await this.addRecent(directory, project.name);
    } catch {
      recentWarning = 'Project saved, but the recent-project list could not be updated.';
    }
    return {
      conflict: false,
      directory,
      projectId,
      removedFiles,
      warning: [warning, recentWarning].filter(Boolean).join(' ') || undefined,
    };
  }

  recover(project: Project) {
    return this.serial(() => this.writeRecovery(project, this.registered.get(project.id)));
  }

  private async requireNoPendingResolution() {
    let saved;
    try {
      saved = JSON.parse((await readTarget(this.dataRoot, 'recovery.json'))?.toString() ?? 'null');
    } catch {
      return;
    }
    if (saved?.pendingSaveResolution)
      throw new Error(
        'Reopen save recovery before changing the workspace. Your file choices and draft copies have been kept.',
      );
  }

  private async writeRecovery(project: Project, registration?: Registration, resolved = false) {
    if (!resolved) await this.requireNoPendingResolution();
    await atomicWrite(
      path.join(this.dataRoot, 'recovery.json'),
      JSON.stringify({
        project,
        directory: registration?.directory,
        baseline: registration ? [...registration.baseline] : undefined,
      }),
    );
  }

  loadRecovery(): Promise<Project | null> {
    return this.serial(() => this.loadRecoverySnapshot());
  }

  private async loadRecoverySnapshot(): Promise<Project | null> {
    this.resolvedSaveCopies = null;
    let saved: any;
    try {
      saved = JSON.parse((await readTarget(this.dataRoot, 'recovery.json'))?.toString() ?? 'null');
    } catch {
      return null;
    }
    // This marker is durable before the user's choices can touch project files.
    // It survives a kill after completion/archive movement and prevents an old
    // autosaved editor buffer from replacing the selected disk result on launch.
    if (saved?.pendingSaveResolution) {
      const { root, nonce } = saved.pendingSaveResolution;
      if (typeof root !== 'string' || !path.isAbsolute(root) || typeof nonce !== 'string')
        throw new Error('The pending save recovery marker is invalid. All copies were kept.');
      if ((await fs.realpath(root)) !== root)
        throw new Error(
          'The recovery project folder now points somewhere else. All copies were kept.',
        );
      await this.transactions.recover(root);
      const copies = await this.transactions.completedCopies(nonce, root);
      if (copies) {
        const project = await this.openSnapshot(root);
        this.resolvedSaveCopies = copies;
        return project;
      }
      // No guided decision was published, and ordinary recovery completed.
      // Resume the original draft instead of leaving an orphaned marker.
      delete saved.pendingSaveResolution;
      await replaceDurable(
        path.join(this.dataRoot, 'recovery.json'),
        JSON.stringify(saved),
        randomUUID(),
      );
    }
    let project: Project;
    let registration: Registration | undefined;
    try {
      project = validateProject(saved.project);
      project.runtime = adoptRuntime(project.runtime, this.defaultRuntime?.());
      if (typeof saved.directory === 'string') {
        const directory = await fs.realpath(saved.directory);
        registration = { directory, baseline: new Map(saved.baseline ?? []) };
      }
    } catch {
      return null;
    }
    // A journal recovery failure must be shown, not mistaken for absent recovery.
    if (registration) {
      await this.transactions.recover(registration.directory);
      this.registered.set(project.id, registration);
      return { ...project, directory: registration.directory };
    }
    return project;
  }

  interruptedSaves() {
    return this.serial(async () => {
      const items = await this.transactions.interrupted();
      let pending;
      try {
        pending = JSON.parse(
          (await readTarget(this.dataRoot, 'recovery.json'))?.toString() ?? 'null',
        )?.pendingSaveResolution;
      } catch {
        return items;
      }
      if (
        typeof pending?.root === 'string' &&
        typeof pending?.nonce === 'string' &&
        !items.some((item) => item.id === fileDigest(pending.root))
      ) {
        const copies = await this.transactions.completedCopies(pending.nonce, pending.root);
        if (copies)
          items.push({
            id: fileDigest(pending.root),
            name: path.basename(pending.root),
            directory: pending.root,
            copyId: pending.nonce,
            issue:
              'Your file choices were saved. Repair the project files and try opening it again. Earlier copies are in the backup folder.',
          });
      }
      return items;
    });
  }
  reviewSave(id: string) {
    return this.serial(async () =>
      this.transactions.review((await this.transactions.record(id)).root),
    );
  }
  reviewSaveText(id: string, token: string, filename: string, version: RecoveryVersion) {
    return this.serial(async () =>
      this.transactions.reviewText(
        (await this.transactions.record(id)).root,
        token,
        filename,
        version,
      ),
    );
  }
  resolveSave(
    id: string,
    token: string,
    choices: SaveRecoveryChoice[],
    workspace?: (id: string) => Promise<Uint8Array>,
  ): Promise<SaveRecoveryResult> {
    return this.serial(async () => {
      const record = await this.transactions.record(id);
      const review = await this.transactions.review(record.root);
      if (!review || review.token !== token)
        throw new Error('The recovery files changed. Refresh the review before choosing.');
      const recovery = await readTarget(this.dataRoot, 'recovery.json');
      let saved: any = {};
      try {
        saved = recovery ? JSON.parse(recovery.toString()) : {};
      } catch {
        /* Raw bytes are retained below. */
      }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
      const retained = new Map<string, Uint8Array>();
      if (recovery) retained.set(`draft-${fileDigest(recovery)}.json`, recovery);
      let draft: Project | undefined;
      try {
        draft = validateProject(saved.project);
      } catch {
        /* A damaged profile is still retained byte for byte. */
      }
      if (draft) {
        const history = workspace ? await workspace(draft.id) : undefined;
        const prefix = `draft-${fileDigest(JSON.stringify([draft, history && fileDigest(history)])).slice(0, 24)}`;
        for (const file of draft.files)
          retained.set(`${prefix}/${file.path}`, Buffer.from(file.content));
        if (history) retained.set(`${prefix}/resume.folio`, history);
        retained.set(`${prefix}/draft.json`, Buffer.from(JSON.stringify(draft, null, 2)));
      }
      retained.set(
        'DRAFT-COPIES.txt',
        Buffer.from(
          'Draft folders keep the editor source before recovery. The draft JSON keeps its project details. A resume.folio file, when present, keeps the local conversation and PDF history. These copies are private and are not uploaded. Keep the entire folder until you no longer need any version.\n',
        ),
      );
      await this.transactions.preserveDraft(record.root, retained);
      await replaceDurable(
        path.join(this.dataRoot, 'recovery.json'),
        JSON.stringify({
          ...saved,
          pendingSaveResolution: { root: record.root, nonce: record.nonce },
        }),
        randomUUID(),
      );
      await this.transactions.resolve(record.root, token, choices);
      try {
        const project = await this.openSnapshot(record.root);
        return { project, copyId: record.nonce };
      } catch (error) {
        return {
          project: null,
          copyId: record.nonce,
          warning: `Your choices were saved, but the project could not be opened: ${(error as Error).message}`,
        };
      }
    });
  }
  recoveryFolder(id: string, kind: 'record' | 'project' | 'copies' | 'all-copies') {
    return this.serial(async () => {
      if (kind === 'all-copies') {
        const directory = path.join(this.dataRoot, 'save-recovery-copies');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Invalid recovery copies folder.');
        return directory;
      }
      if (kind === 'copies') {
        const directory = await this.transactions.completedCopies(id);
        if (!directory) throw new Error('These recovery copies could not be found.');
        return directory;
      }
      if (kind === 'record') {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Unknown interrupted save.');
        // Even an unreadable journal can be revealed for manual repair.
        const directory = path.join(this.dataRoot, 'save-transactions', id);
        await parentPath(this.dataRoot, `save-transactions/${id}/journal.json`);
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid save folder.');
        return directory;
      }
      if (kind !== 'project') throw new Error('Unknown recovery folder.');
      return (await this.transactions.record(id)).root;
    });
  }
  preserveResolvedWorkspace(copyId: string, projectId: string, bytes: Uint8Array) {
    return this.serial(async () => {
      if (!/^[\w-]{1,80}$/.test(projectId) || bytes.byteLength > 100 * 1024 * 1024)
        throw new Error('Invalid conversation recovery copy.');
      const directory = await this.transactions.completedCopies(copyId);
      if (!directory) throw new Error('The recovery copies could not be found.');
      const filename = `workspace-${projectId}-${fileDigest(bytes)}.folio`;
      const prior = await readTarget(directory, filename);
      if (prior && !prior.equals(bytes))
        throw new Error('A conversation recovery copy differs. All copies were kept.');
      if (!prior) await replaceDurable(path.join(directory, filename), bytes, randomUUID());
    });
  }
  finishResolvedRecovery(project: Project) {
    return this.serial(async () => {
      const saved = JSON.parse(
        (await readTarget(this.dataRoot, 'recovery.json'))?.toString() ?? 'null',
      );
      const pending = saved?.pendingSaveResolution;
      const registration = this.registered.get(project.id);
      if (
        !pending ||
        registration?.directory !== pending.root ||
        !(await this.transactions.completedCopies(pending.nonce, pending.root))
      )
        throw new Error('The recovered workspace could not be matched to its saved choices.');
      await this.writeRecovery(project, registration, true);
    });
  }

  async clearRecovery() {
    await this.requireNoPendingResolution();
    await fs.rm(path.join(this.dataRoot, 'recovery.json'), { force: true });
  }

  async recent(): Promise<RecentProject[]> {
    try {
      const list = JSON.parse(await fs.readFile(path.join(this.dataRoot, 'recent.json'), 'utf8'));
      return Array.isArray(list)
        ? list.filter((x) => typeof x.path === 'string' && typeof x.name === 'string').slice(0, 8)
        : [];
    } catch {
      return [];
    }
  }

  private async addRecent(directory: string, name: string) {
    const list = [
      { path: directory, name },
      ...(await this.recent()).filter((p) => p.path !== directory),
    ].slice(0, 8);
    await atomicWrite(path.join(this.dataRoot, 'recent.json'), JSON.stringify(list));
  }
}
