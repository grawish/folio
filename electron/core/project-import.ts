import { randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { projectRuntime } from '../../src/shared/runtime';
import { readSafeZip } from './safe-zip';
import {
  ASSET_EXTENSIONS,
  TEXT_EXTENSIONS,
  validateProject,
  readRemovedFileArchive,
} from './project';
import { safeRelative } from './file-io';
import { copyWorkspaceArchive } from './workspace';
import { ImportTransactions, writeImportFile, type ImportHooks } from './import-transactions';
import type { Project, ProjectImportPreview } from '../../src/shared/types';

const MB = 1024 * 1024;
const ignored = (name: string) =>
  name
    .split('/')
    .some(
      (part) =>
        part.startsWith('.') ||
        ['__MACOSX', 'node_modules', 'build', 'dist', 'Thumbs.db'].includes(part),
    );

export function inspectProjectArchive(archive: Uint8Array, archiveName: string) {
  const entries = readSafeZip(archive, {
    compressed: 136 * MB,
    expanded: 136 * MB,
    entries: 1000,
    entryBytes: (name) => (path.posix.basename(name) === 'resume.folio' ? 100 * MB : 25 * MB),
  });
  const names = [...entries.keys()].filter((name) => !ignored(name));
  const first = names[0]?.split('/')[0];
  const prefix = first && names.every((name) => name.startsWith(`${first}/`)) ? `${first}/` : '';
  const files = new Map<string, Buffer>();
  const skipped: string[] = [];
  let bytes = 0,
    metadata: Record<string, unknown> = {};
  for (const [original, data] of entries) {
    if (ignored(original)) {
      skipped.push(original);
      continue;
    }
    const name = original.slice(prefix.length);
    safeRelative(name);
    if (name === 'resume.project.json') {
      if (data.length > 64 * 1024) throw new Error('The project manifest exceeds 64 KB.');
      try {
        metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
      } catch {
        throw new Error('The project manifest is damaged.');
      }
      if (
        !metadata ||
        Array.isArray(metadata) ||
        typeof metadata !== 'object' ||
        ![1, 2].includes(Number(metadata.schemaVersion))
      )
        throw new Error('This project manifest version is not supported.');
      continue;
    }
    if (name === 'resume.folio' || name === 'resume.trash') {
      files.set(name, data);
      continue;
    }
    const extension = path.extname(name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && !ASSET_EXTENSIONS.has(extension)) {
      skipped.push(original);
      continue;
    }
    if (name.split('/').length > 9) throw new Error('Project folders are nested too deeply.');
    bytes += data.length;
    if (
      bytes > 25 * MB ||
      files.size - Number(files.has('resume.folio')) - Number(files.has('resume.trash')) >= 200
    )
      throw new Error('Imported projects support up to 200 source and asset files and 25 MB.');
    files.set(name, data);
  }
  const source = [...files]
    .filter(([name]) => TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map(([name, data]) => {
      if (data.length > 2 * MB) throw new Error('A source file exceeds the 2 MB limit.');
      try {
        return { path: name, content: new TextDecoder('utf-8', { fatal: true }).decode(data) };
      } catch {
        throw new Error(`Save ${name} as UTF-8 text before importing it.`);
      }
    });
  const mainFiles = source
    .map((file) => file.path)
    .filter((name) => name.endsWith('.tex'))
    .sort();
  if (!mainFiles.length) throw new Error('This ZIP does not contain a supported .tex document.');
  const suggestedMain =
    typeof metadata.mainFile === 'string' && mainFiles.includes(metadata.mainFile)
      ? metadata.mainFile
      : mainFiles.includes('main.tex')
        ? 'main.tex'
        : mainFiles[0];
  const fallbackName =
    (prefix ? prefix.slice(0, -1) : path.basename(archiveName, '.zip')).slice(0, 120) ||
    'Imported resume';
  const project = validateProject({
    id: randomUUID(),
    name: typeof metadata.name === 'string' ? metadata.name : fallbackName,
    mainFile: suggestedMain,
    files: source,
    revision: Number.isSafeInteger(metadata.revision) ? metadata.revision : 0,
    templateId: metadata.templateId,
    templateVersion: metadata.templateVersion,
    runtime: projectRuntime(metadata),
    removedFiles: files.has('resume.trash')
      ? readRemovedFileArchive(files.get('resume.trash')!)
      : [],
  });
  // Validate and reidentify all saved source/PDF history before creating a folder.
  if (files.has('resume.folio'))
    files.set(
      'resume.folio',
      Buffer.from(copyWorkspaceArchive(files.get('resume.folio')!, project.id)),
    );
  const preview: ProjectImportPreview = {
    token: randomUUID(),
    name: project.name,
    mainFiles,
    suggestedMain,
    sourceCount: source.length,
    assetCount:
      files.size -
      source.length -
      Number(files.has('resume.folio')) -
      Number(files.has('resume.trash')),
    bytes,
    hasHistory: files.has('resume.folio'),
    skipped,
  };
  return { preview, project, files };
}

type Pending = ReturnType<typeof inspectProjectArchive> & { expires: number };
export class ProjectImporter {
  private pending?: Pending;
  private busy = false;
  private expiration?: ReturnType<typeof setTimeout>;
  readonly recovery: ImportTransactions;
  constructor(dataRoot: string, write = writeImportFile, hooks: ImportHooks = {}) {
    this.recovery = new ImportTransactions(dataRoot, write, hooks);
  }

  async prepare(filename: string): Promise<ProjectImportPreview> {
    if (this.busy) throw new Error('Wait for the current import to finish.');
    this.busy = true;
    clearTimeout(this.expiration);
    this.pending = undefined;
    try {
      const handle = await fs.open(
        filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      let archive: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 136 * MB)
          throw new Error('Choose a ZIP file no larger than 136 MB.');
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== stat.size)
          throw new Error('The ZIP changed while it was being read. Try again.');
        archive = buffer.subarray(0, length);
      } finally {
        await handle.close();
      }
      const inspected = inspectProjectArchive(archive, filename);
      this.pending = { ...inspected, expires: Date.now() + 10 * 60_000 };
      this.expiration = setTimeout(() => {
        if (!this.busy) this.pending = undefined;
      }, 10 * 60_000);
      this.expiration.unref();
      return inspected.preview;
    } finally {
      this.busy = false;
    }
  }

  cancel(token: string) {
    if (!this.busy && this.pending?.preview.token === token) {
      this.pending = undefined;
      clearTimeout(this.expiration);
    }
  }

  async finish(token: string, mainFile: string, parent: string): Promise<string> {
    if (this.busy) throw new Error('Wait for the current import to finish.');
    const pending = this.pending;
    if (!pending || token !== pending.preview.token || pending.expires < Date.now())
      throw new Error('This import expired. Choose the ZIP again.');
    if (!pending.preview.mainFiles.includes(mainFile))
      throw new Error('Choose a main document from this ZIP.');
    this.busy = true;
    try {
      const project: Project = { ...pending.project, mainFile };
      const files = new Map(pending.files);
      files.set(
        'resume.project.json',
        Buffer.from(
          JSON.stringify(
            {
              schemaVersion: 2,
              id: project.id,
              name: project.name,
              mainFile,
              revision: project.revision,
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
      await this.recovery.create(token, project.name, mainFile, parent, files);
      const { directory } = await this.recovery.resume(token);
      this.pending = undefined;
      clearTimeout(this.expiration);
      return directory;
    } catch (error) {
      if (await this.recovery.has(token)) {
        try {
          await this.recovery.discard(token);
        } catch {
          throw new Error(
            'Import stopped. Review Interrupted imports to finish it or inspect its files. ' +
              (error as Error).message,
          );
        }
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async resume(id: string) {
    if (this.busy) throw new Error('Wait for the current import to finish.');
    this.busy = true;
    try {
      return await this.recovery.resume(id);
    } finally {
      this.busy = false;
    }
  }
  async interrupted() {
    if (this.busy) throw new Error('Wait for the current import to finish.');
    return this.recovery.list();
  }
  async discard(
    id: string,
    remove: (directory: string) => Promise<void>,
    beforeRemove?: (directory: string) => void,
  ) {
    if (this.busy) throw new Error('Wait for the current import to finish.');
    this.busy = true;
    try {
      await this.recovery.discard(id, remove, beforeRemove);
    } finally {
      this.busy = false;
    }
  }
  async forget(id: string) {
    if (this.busy) throw new Error('Wait for the current import to finish.');
    this.busy = true;
    try {
      await this.recovery.forget(id);
    } finally {
      this.busy = false;
    }
  }
}
