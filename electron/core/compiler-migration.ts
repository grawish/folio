import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { Project, BuildResult } from '../../src/shared/types';
import type { RuntimePin } from '../../src/shared/runtime';
import type {
  CompilerBackup,
  CompilerComparison,
  CompilerMigrationResult,
} from '../../src/shared/migration';
import { validateRuntimePin } from '../../src/shared/runtime';
import { fingerprint, validateProject, removedFileArchive } from './project';
import { safeId, type WorkspaceStore } from './workspace';
import { runtimeFile } from './runtime';

type Dependencies = {
  target(): RuntimePin | undefined;
  start?(): Promise<void>;
  assets(project: Project): Promise<Map<string, Buffer>>;
  checkDisk(project: Project): Promise<void>;
  compile(project: Project, assets: Map<string, Buffer>): Promise<BuildResult>;
  cancel(): Promise<void>;
  recover(project: Project): Promise<void>;
  workspace: WorkspaceStore;
  checkpoint?(phase: 'backed-up' | 'committed'): Promise<void>;
};
type Pending = {
  project: Project;
  next: Project;
  assetsKey: string;
  projectKey: string;
  comparison: CompilerComparison;
  build: BuildResult;
};
const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const projectKey = (project: Project) => digest(JSON.stringify(validateProject(project)));
const assetKey = (assets: Map<string, Buffer>) =>
  digest(
    JSON.stringify(
      [...assets]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, bytes]) => [name, digest(bytes)]),
    ),
  );
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MiB = 1024 * 1024;

// Backups are immutable, app-owned files. Publish the record last, after the
// complete source archive and both PDFs have reached disk.
async function durableFile(filename: string, bytes: Uint8Array | string) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function plainDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory())
    throw new Error('Compiler backups must be stored in a regular folder.');
}

export class CompilerMigration {
  private operation?: { id: string; cancelled: boolean; done: Promise<unknown> };
  private pending?: Pending;
  private applying?: Promise<CompilerMigrationResult>;
  constructor(
    readonly root: string,
    private deps: Dependencies,
  ) {}
  get active() {
    return !!this.operation || !!this.pending || !!this.applying;
  }
  requireIdle() {
    if (this.active) throw new Error('Finish or cancel the compiler comparison first.');
  }

  private folder(projectId: string, id: string) {
    if (!uuid.test(id)) throw new Error('Invalid compiler backup.');
    return path.join(this.root, safeId(projectId), id);
  }
  private async readFile(projectId: string, id: string, name: string, limit: number) {
    this.folder(projectId, id);
    if (!(await fs.lstat(this.root)).isDirectory())
      throw new Error('Compiler backups must be stored in a regular folder.');
    return runtimeFile(this.root, `${projectId}/${id}/${name}`, limit);
  }
  private async readBackup(projectId: string, id: string): Promise<CompilerBackup> {
    const record = JSON.parse((await this.readFile(projectId, id, 'record.json', 4096)).toString());
    const from = validateRuntimePin(record.from),
      to = validateRuntimePin(record.to);
    if (
      record.id !== id ||
      !from ||
      !to?.id ||
      typeof record.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(record.createdAt))
    )
      throw new Error('This compiler backup record is damaged.');
    return { id, createdAt: record.createdAt, from, to };
  }
  async backups(projectId: string): Promise<CompilerBackup[]> {
    const base = path.join(this.root, safeId(projectId));
    let entries;
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (entries.length > 100)
      throw new Error('Too many compiler backups. Move older backups out of the backup folder.');
    const records: CompilerBackup[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      try {
        records.push(await this.readBackup(projectId, entry.name));
      } catch {
        /* Incomplete stages are not offered as valid backups. */
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async backupPath(projectId: string, id: string) {
    await this.readBackup(projectId, id);
    const folder = this.folder(projectId, id);
    await this.readFile(projectId, id, 'source.zip', 100 * MiB);
    return path.join(folder, 'source.zip');
  }
  private async spaceBudget(extra: number) {
    await plainDirectory(this.root);
    let total = extra,
      entries = 0;
    const walk = async (folder: string, depth = 0) => {
      if (depth > 3) throw new Error('Unexpected compiler backup folder.');
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (++entries > 1000)
          throw new Error(
            'Compiler backup storage is full. Move older backups out of the backup folder.',
          );
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile()) total += (await fs.lstat(full)).size;
        else throw new Error('Compiler backups cannot contain linked files.');
        if (total > 1024 * MiB)
          throw new Error(
            'Compiler backups reached the 1 GB storage limit. Move older backups out of the backup folder.',
          );
      }
    };
    await walk(this.root);
  }
  prepare(id: string, value: unknown): Promise<CompilerComparison> {
    this.requireIdle();
    if (!uuid.test(id)) throw new Error('Invalid compiler comparison.');
    const operation = { id, cancelled: false, done: Promise.resolve() as Promise<unknown> };
    this.operation = operation;
    const check = () => {
      if (operation.cancelled) throw new Error('Compiler comparison cancelled.');
    };
    const work = async () => {
      const project = validateProject(value),
        target = validateRuntimePin(this.deps.target());
      if (!project.runtime || !target?.id || project.runtime.id === target.id)
        throw new Error(
          'This project already uses the included compiler, or no complete compiler is available.',
        );
      if (target.platform !== `${process.platform}-${process.arch}`)
        throw new Error('The included compiler does not support this computer.');
      await this.deps.start?.();
      check();
      await this.deps.checkDisk(project);
      const assets = await this.deps.assets(project);
      check();
      const beforeBuild = await this.deps.compile(project, assets);
      check();
      let before = beforeBuild.pdf,
        baseline: CompilerComparison['baseline'] = 'rebuilt';
      if (beforeBuild.status !== 'success' || !before) {
        if (!beforeBuild.runtimeUnavailable)
          throw new Error(
            `The recorded compiler could not build this resume. Fix its errors before comparing compilers. ${beforeBuild.log.slice(-1200)}`,
          );
        const saved = (await this.deps.workspace.load(project.id)).versions
          .slice()
          .reverse()
          .find((v) => v.fingerprint === fingerprint(project));
        if (!saved)
          throw new Error(
            'The recorded compiler is unavailable and there is no saved PDF matching this source. Repair that compiler or restore a saved version before comparing. Your compiler choice is unchanged.',
          );
        before = (await this.deps.workspace.version(project.id, saved.id)).pdf;
        baseline = 'saved-pdf';
      }
      const next = validateProject({ ...project, runtime: target, revision: project.revision + 1 });
      const build = await this.deps.compile(next, assets);
      check();
      if (build.status !== 'success' || !build.pdf)
        throw new Error(
          `The included compiler could not build this resume. Your compiler choice is unchanged. ${build.log.slice(-1200)}`,
        );
      if (before.byteLength > 25 * MiB || build.pdf.byteLength > 25 * MiB)
        throw new Error('The comparison PDF exceeds the 25 MB limit.');
      await this.deps.checkDisk(project);
      if (assetKey(await this.deps.assets(project)) !== assetKey(assets))
        throw new Error('Project assets changed during the comparison. Start a new comparison.');
      check();
      const backup: CompilerBackup = {
        id,
        from: project.runtime,
        to: target,
        createdAt: new Date().toISOString(),
      };
      const exportId = randomUUID();
      const files: Record<string, Uint8Array> = Object.fromEntries(assets);
      for (const file of project.files) files[file.path] = strToU8(file.content);
      files['resume.project.json'] = strToU8(
        JSON.stringify({
          schemaVersion: 2,
          ...project,
          id: exportId,
          files: undefined,
          removedFiles: undefined,
          directory: undefined,
          engine: `tectonic@${project.runtime.version}`,
          bundle: project.runtime.bundle,
        }),
      );
      files['resume.folio'] = await this.deps.workspace.archive(project.id, exportId);
      files['resume.trash'] = removedFileArchive(project.removedFiles);
      const archive = zipSync(files);
      if (archive.byteLength > 100 * MiB)
        throw new Error('The source backup exceeds the 100 MB limit.');
      await this.spaceBudget(archive.byteLength + before.byteLength + build.pdf.byteLength + 4096);
      check();
      const base = path.join(this.root, project.id);
      await plainDirectory(base);
      const existing = await fs.readdir(base);
      if (existing.length >= 100)
        throw new Error(
          'This project has 100 compiler backups. Move older backups out of the backup folder.',
        );
      const folder = this.folder(project.id, id);
      await fs.mkdir(folder, { mode: 0o700 });
      try {
        await durableFile(path.join(folder, 'source.zip'), archive);
        await durableFile(path.join(folder, 'before.pdf'), before);
        await durableFile(path.join(folder, 'after.pdf'), build.pdf);
        await durableFile(
          path.join(folder, 'record.json'),
          JSON.stringify({
            ...backup,
            baseline,
            archiveHash: digest(archive),
            beforeHash: digest(before),
            afterHash: digest(build.pdf),
          }),
        );
        const directory = await fs.open(folder, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        await fs.rm(folder, { recursive: true, force: true });
        throw error;
      }
      await this.deps.checkpoint?.('backed-up');
      check();
      const comparison = {
        ...backup,
        before: new Uint8Array(before),
        after: new Uint8Array(build.pdf),
        baseline,
      };
      this.pending = {
        project,
        next,
        assetsKey: assetKey(assets),
        projectKey: projectKey(project),
        comparison,
        build,
      };
      return comparison;
    };
    const result = work().finally(() => {
      if (this.operation === operation) this.operation = undefined;
    });
    operation.done = result;
    return result;
  }
  apply(id: string, value: unknown): Promise<CompilerMigrationResult> {
    if (this.applying) throw new Error('The compiler change is already being applied.');
    const pending = this.pending;
    if (!pending || pending.comparison.id !== id)
      throw new Error('Start a new compiler comparison.');
    const work = async () => {
      const current = validateProject(value);
      if (projectKey(current) !== pending.projectKey)
        throw new Error(
          'The resume changed since this comparison. Keep your edits and compare again.',
        );
      await this.deps.checkDisk(current);
      if (assetKey(await this.deps.assets(current)) !== pending.assetsKey)
        throw new Error('Project assets changed since this comparison. Compare again.');
      const record = JSON.parse(
        (await this.readFile(current.id, id, 'record.json', 4096)).toString(),
      );
      for (const [name, hash] of [
        ['source.zip', record.archiveHash],
        ['before.pdf', record.beforeHash],
        ['after.pdf', record.afterHash],
      ]) {
        if (digest(await this.readFile(current.id, id, name, 100 * MiB)) !== hash)
          throw new Error(
            'The compiler backup failed its integrity check. Compare again before changing compilers.',
          );
      }
      await this.deps.workspace.checkpoint(
        current,
        pending.comparison.before,
        'Before compiler change',
      );
      // Recovery is the commit point. The project folder changes only through
      // the normal explicit Save/autosave transaction after this draft is used.
      await this.deps.recover(pending.next);
      this.pending = undefined;
      const warnings: string[] = [];
      try {
        await this.deps.checkpoint?.('committed');
      } catch {
        warnings.push(
          'The compiler changed, but its completion check failed. Your backup has been kept.',
        );
      }
      try {
        pending.build.versionId = (
          await this.deps.workspace.checkpoint(
            pending.next,
            pending.comparison.after,
            'Changed compiler',
          )
        ).id;
      } catch {
        warnings.push(
          'The compiler changed, but its new history entry could not be saved. The comparison PDFs are kept with your backup.',
        );
      }
      return {
        project: pending.next,
        build: pending.build,
        backup: {
          id,
          createdAt: pending.comparison.createdAt,
          from: pending.comparison.from,
          to: pending.comparison.to,
        },
        warning: warnings.join(' ') || undefined,
      };
    };
    this.applying = work().finally(() => {
      this.applying = undefined;
    });
    return this.applying;
  }
  async cancel(id?: string) {
    if (this.applying) {
      await this.applying.catch(() => {});
      return;
    }
    if (this.operation && (!id || id === this.operation.id)) {
      this.operation.cancelled = true;
      await this.deps.cancel();
      await this.operation?.done.catch(() => {});
    }
    if (!id || this.pending?.comparison.id === id) this.pending = undefined;
  }
}
