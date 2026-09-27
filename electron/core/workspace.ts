import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { readSafeZip } from './safe-zip';
import { historyArchiver } from './history-archive';
import { SaveTransactions, readTarget, type SaveHooks } from './save-transactions';
import { parentPath } from './save-io';
import {
  emptyWorkspace,
  type PdfAnnotation,
  type VersionInfo,
  type VersionSnapshot,
  type WorkspaceState,
  type RunMetadata,
  type HistoryStorage,
} from '../../src/shared/ai';
import type { Project } from '../../src/shared/types';
import { atomicWrite, fingerprint, validateProject } from './project';
const pdfFingerprint = (pdf: Uint8Array) => createHash('sha256').update(pdf).digest('hex');
// Leave room for conversation JSON and ZIP overhead below the 100 MiB archive
// ceiling, even when none of the PDF/source bytes compress.
export const HISTORY_BYTES = 64 * 1024 * 1024;
export const HISTORY_VERSIONS = 1000;

export function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error('Invalid workspace record.');
  return value;
}
const string = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length > max)
    throw new Error('Workspace text is too large or invalid.');
  return value;
};
function execution(value: RunMetadata | undefined): RunMetadata | undefined {
  if (!value) return undefined;
  if (
    !Array.isArray(value.models) ||
    value.models.length > 12 ||
    !value.timings ||
    typeof value.timings !== 'object'
  )
    throw new Error('Invalid run metadata.');
  const timings: RunMetadata['timings'] = {};
  for (const key of [
    'setup',
    'inference',
    'compile',
    'render',
    'inspect',
    'review',
    'total',
  ] as const) {
    const ms = value.timings[key];
    if (ms !== undefined) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
        throw new Error('Invalid run timing.');
      timings[key] = ms;
    }
  }
  return {
    models: value.models.map((m) => string(m, 160)),
    escalated: value.escalated === true,
    validation: ['compiled', 'visual'].includes(value.validation ?? '')
      ? value.validation
      : undefined,
    timings,
  };
}
const coordinate = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error('Invalid annotation position.');
  return value;
};
export function validateAnnotation(value: unknown): PdfAnnotation {
  const a = value as PdfAnnotation;
  if (
    !a ||
    !['highlight', 'rectangle', 'pen', 'note'].includes(a.kind) ||
    !Number.isSafeInteger(a.page) ||
    a.page < 1 ||
    a.page > 500 ||
    !a.rect
  )
    throw new Error('Invalid PDF note.');
  const rect = {
    x: coordinate(a.rect.x),
    y: coordinate(a.rect.y),
    width: coordinate(a.rect.width),
    height: coordinate(a.rect.height),
  };
  if (rect.x + rect.width > 1.001 || rect.y + rect.height > 1.001)
    throw new Error('PDF note falls outside the page.');
  if (a.points && (!Array.isArray(a.points) || a.points.length > 2000))
    throw new Error('Drawing is too large.');
  return {
    id: safeId(a.id),
    versionId: safeId(a.versionId),
    page: a.page,
    kind: a.kind,
    rect,
    text: string(a.text, 4000),
    selectedText: a.selectedText ? string(a.selectedText, 8000) : undefined,
    points: a.points?.map((p) => ({ x: coordinate(p.x), y: coordinate(p.y) })),
    createdAt: string(a.createdAt, 40),
  };
}
export function validateWorkspace(value: unknown): WorkspaceState {
  const w = value as WorkspaceState;
  if (
    !w ||
    w.schemaVersion !== 1 ||
    !Array.isArray(w.messages) ||
    w.messages.length > 2000 ||
    !Array.isArray(w.annotations) ||
    w.annotations.length > 2000 ||
    !Array.isArray(w.attachedNoteIds)
  )
    throw new Error('Invalid workspace.');
  const annotations = w.annotations.map(validateAnnotation);
  const messages = w.messages.map((m) => {
    if (
      !m ||
      !['user', 'assistant'].includes(m.role) ||
      !Array.isArray(m.annotationIds) ||
      m.annotationIds.length > 100 ||
      (m.annotationSnapshot &&
        (!Array.isArray(m.annotationSnapshot) || m.annotationSnapshot.length > 100))
    )
      throw new Error('Invalid chat message.');
    return {
      id: safeId(m.id),
      role: m.role,
      text: string(m.text, 100_000),
      createdAt: string(m.createdAt, 40),
      annotationIds: m.annotationIds.map(safeId),
      annotationSnapshot: m.annotationSnapshot?.map(validateAnnotation),
      versionId: m.versionId ? safeId(m.versionId) : undefined,
      runId: m.runId ? safeId(m.runId) : undefined,
      execution: execution(m.execution),
      status:
        m.status && ['complete', 'error', 'cancelled'].includes(m.status) ? m.status : undefined,
    };
  });
  const result: WorkspaceState = {
    schemaVersion: 1,
    projectId: safeId(w.projectId),
    messages,
    annotations,
    draft: string(w.draft, 20_000),
    attachedNoteIds: w.attachedNoteIds.slice(0, 100).map(safeId),
    versions: [],
  };
  if (w.historyRevision !== undefined) {
    if (!Number.isSafeInteger(w.historyRevision) || w.historyRevision < 0)
      throw new Error('Invalid history revision.');
    result.historyRevision = w.historyRevision;
  }
  if (JSON.stringify(result).length > 8_000_000)
    throw new Error('This conversation exceeds the 8 MB workspace limit.');
  return result;
}
function validateVersion(value: unknown): VersionInfo {
  const v = value as VersionInfo;
  if (
    !v ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    !/^[a-f0-9]{64}$/.test(v.fingerprint) ||
    (v.pdfFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(v.pdfFingerprint)) ||
    (v.buildFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(v.buildFingerprint))
  )
    throw new Error('Invalid saved version.');
  return {
    id: safeId(v.id),
    label: string(v.label, 160),
    createdAt: string(v.createdAt, 40),
    fingerprint: v.fingerprint,
    pdfFingerprint: v.pdfFingerprint,
    buildFingerprint: v.buildFingerprint,
    revision: v.revision,
    verified: v.verified === true,
  };
}

function decodeWorkspaceArchive(archive: Uint8Array, projectId: string) {
  const files = readSafeZip(archive, {
    compressed: 100 * 1024 * 1024,
    expanded: 200 * 1024 * 1024,
    entries: 2001,
    entryBytes: () => 25 * 1024 * 1024,
  });
  const entries = Object.fromEntries(files);
  const raw = JSON.parse(strFromU8(entries['state.json'] ?? new Uint8Array()));
  const state = validateWorkspace({ ...raw, projectId });
  if (!Array.isArray(raw.versions ?? []) || (raw.versions?.length ?? 0) > 1000)
    throw new Error('Conversation archive exceeds the 1,000-version limit.');
  state.versions = (raw.versions ?? []).map(validateVersion);
  if (new Set(state.versions.map((version) => version.id)).size !== state.versions.length)
    throw new Error('Conversation archive contains duplicate version records.');
  for (const v of state.versions) {
    const source = entries[`versions/${v.id}/source.json`];
    const pdf = entries[`versions/${v.id}/resume.pdf`];
    if (!source || !pdf || strFromU8(pdf.subarray(0, 5)) !== '%PDF-')
      throw new Error('Incomplete conversation archive.');
    if (fingerprint(validateProject(JSON.parse(strFromU8(source)))) !== v.fingerprint)
      throw new Error('The saved source does not match its version record.');
    if (v.pdfFingerprint && pdfFingerprint(pdf) !== v.pdfFingerprint)
      throw new Error('The saved PDF does not match its version record.');
  }
  return { state, entries };
}

export function copyWorkspaceArchive(archive: Uint8Array, projectId: string): Uint8Array {
  const { state, entries } = decodeWorkspaceArchive(archive, safeId(projectId));
  const files: Record<string, Uint8Array> = { 'state.json': strToU8(JSON.stringify(state)) };
  for (const version of state.versions)
    for (const name of ['source.json', 'resume.pdf']) {
      const key = `versions/${version.id}/${name}`;
      files[key] = entries[key];
    }
  const result = zipSync(files);
  if (result.byteLength > 100 * 1024 * 1024)
    throw new Error('Compressed history exceeds the 100 MB archive limit.');
  return result;
}

export class WorkspaceStore {
  private queues = new Map<string, Promise<unknown>>();
  private pending = new Map<string, number>();
  private pendingTotal = 0;
  private pendingReads = new Map<string, number>();
  private pendingReadTotal = 0;
  private archives = new Set<Promise<Uint8Array>>();
  private transactions: SaveTransactions;
  constructor(
    readonly dataRoot: string,
    hooks: SaveHooks = {},
  ) {
    this.transactions = new SaveTransactions(path.join(dataRoot, 'workspace-maintenance'), hooks);
  }
  private root(id: string) {
    return path.join(this.dataRoot, 'workspaces', safeId(id));
  }
  private enqueue<T>(id: string, operation: () => Promise<T>, readOnly = false): Promise<T> {
    // Include the active operation in both limits. Each accepted request can
    // retain source/PDF bytes until its turn; never silently discard a save.
    const counts = readOnly ? this.pendingReads : this.pending;
    const pending = counts.get(id) ?? 0;
    if (
      pending >= (readOnly ? 8 : 4) ||
      (readOnly ? this.pendingReadTotal >= 16 : this.pendingTotal >= 8)
    )
      return Promise.reject(
        new Error(
          readOnly
            ? 'Folio is loading other history previews. Try again in a moment.'
            : 'Folio is finishing other workspace saves. Try again in a moment.',
        ),
      );
    counts.set(id, pending + 1);
    if (readOnly) this.pendingReadTotal++;
    else this.pendingTotal++;
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, next);
    const settled = () => {
      if (readOnly) this.pendingReadTotal--;
      else this.pendingTotal--;
      const remaining = counts.get(id)! - 1;
      if (remaining) counts.set(id, remaining);
      else counts.delete(id);
      // A newer request may already be waiting on this promise.
      if (this.queues.get(id) === next) this.queues.delete(id);
    };
    void next.then(settled, settled);
    return next;
  }
  async flush() {
    await Promise.all([...this.queues.values(), ...this.archives]);
  }
  private async read(id: string): Promise<WorkspaceState> {
    try {
      await parentPath(this.dataRoot, `workspaces/${safeId(id)}/state.json`);
      await this.transactions.recover(this.root(id));
      const raw = JSON.parse(await fs.readFile(path.join(this.root(id), 'state.json'), 'utf8'));
      const state = validateWorkspace(raw);
      if (state.projectId !== id) throw new Error('Mismatched workspace identity.');
      state.versions = (raw.versions ?? []).map(validateVersion);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyWorkspace(id);
      throw new Error('The saved conversation could not be read. Your source files are unchanged.');
    }
  }
  load(id: string) {
    return this.enqueue(safeId(id), () => this.read(id), true);
  }
  save(value: unknown): Promise<void> {
    const state = validateWorkspace(value);
    return this.enqueue(state.projectId, async () => {
      const previous = await this.read(state.projectId);
      if ((state.historyRevision ?? 0) !== (previous.historyRevision ?? 0))
        throw new Error(
          'History changed while this conversation was open. Reload it before saving.',
        );
      state.versions = previous.versions;
      await atomicWrite(path.join(this.root(state.projectId), 'state.json'), JSON.stringify(state));
    });
  }
  checkpoint(
    project: Project,
    pdf: Uint8Array,
    label = 'Resume updated',
    verified = false,
    buildFingerprint?: string,
  ): Promise<VersionInfo> {
    return this.enqueue(project.id, async () => {
      if (
        pdf.byteLength > 25 * 1024 * 1024 ||
        Buffer.from(pdf).subarray(0, 5).toString() !== '%PDF-'
      )
        throw new Error('Cannot save an invalid PDF version.');
      const state = await this.read(project.id);
      const hash = fingerprint(project);
      const pdfHash = pdfFingerprint(pdf);
      const latest = state.versions.at(-1);
      if (latest?.fingerprint === hash && latest.pdfFingerprint === pdfHash) {
        if (
          (verified && !latest.verified) ||
          (buildFingerprint && latest.buildFingerprint !== buildFingerprint)
        ) {
          latest.verified ||= verified;
          latest.buildFingerprint = buildFingerprint ?? latest.buildFingerprint;
          await atomicWrite(path.join(this.root(project.id), 'state.json'), JSON.stringify(state));
        }
        return latest;
      }
      const info: VersionInfo = {
        id: randomUUID(),
        label: label.slice(0, 160),
        createdAt: new Date().toISOString(),
        fingerprint: hash,
        pdfFingerprint: pdfHash,
        buildFingerprint,
        revision: project.revision,
        verified,
      };
      // Removed copies belong to the project archive, not every PDF version.
      // Repeating a full trash record here would exhaust history after a few builds.
      const source = validateProject(project);
      delete source.removedFiles;
      const sourceBytes = Buffer.from(JSON.stringify(source));
      if (sourceBytes.length > 25 * 1024 * 1024)
        throw new Error('This source snapshot exceeds the 25 MB history limit.');
      const usage = await this.measure(state);
      if (
        state.versions.length >= HISTORY_VERSIONS ||
        usage.bytes + sourceBytes.length + pdf.byteLength > HISTORY_BYTES
      )
        throw new Error(
          'History is full. Open History and remove older versions before building another PDF. Your source and saved versions are unchanged.',
        );
      state.versions.push(info);
      const root = this.root(project.id);
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.mkdir(this.transactions.dataRoot, { recursive: true, mode: 0o700 });
      await this.transactions.commit(root, [
        { path: `versions/${info.id}/source.json`, before: null, data: sourceBytes },
        { path: `versions/${info.id}/resume.pdf`, before: null, data: pdf },
        {
          path: 'state.json',
          before: await readTarget(root, 'state.json'),
          data: Buffer.from(JSON.stringify(state)),
        },
      ]);
      return info;
    });
  }
  version(projectId: string, versionId: string): Promise<VersionSnapshot> {
    return this.enqueue(
      safeId(projectId),
      async () => {
        const state = await this.read(projectId);
        const info = state.versions.find((v) => v.id === safeId(versionId));
        if (!info) throw new Error('This PDF version is no longer available.');
        const directory = path.join(this.root(projectId), 'versions', info.id);
        const source = validateProject(
          JSON.parse(await fs.readFile(path.join(directory, 'source.json'), 'utf8')),
        );
        const pdf = new Uint8Array(await fs.readFile(path.join(directory, 'resume.pdf')));
        if (
          fingerprint(source) !== info.fingerprint ||
          Buffer.from(pdf).subarray(0, 5).toString() !== '%PDF-' ||
          (info.pdfFingerprint && pdfFingerprint(pdf) !== info.pdfFingerprint)
        )
          throw new Error(
            'This saved version is damaged. Its source and PDF could not be verified.',
          );
        return {
          info,
          name: source.name,
          mainFile: source.mainFile,
          files: source.files,
          templateId: source.templateId,
          templateVersion: source.templateVersion,
          runtime: source.runtime,
          pdf,
        };
      },
      true,
    );
  }
  private async measure(state: WorkspaceState): Promise<HistoryStorage> {
    const versions: HistoryStorage['versions'] = [];
    for (const version of state.versions) {
      let bytes = 0,
        missing = false;
      for (const file of ['source.json', 'resume.pdf']) {
        const relative = `versions/${safeId(version.id)}/${file}`;
        try {
          await parentPath(this.root(state.projectId), relative);
          const stat = await fs.lstat(path.join(this.root(state.projectId), relative));
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error('A history file is not a regular file.');
          bytes += stat.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          missing = true;
        }
      }
      versions.push({ id: version.id, bytes, missing });
    }
    return {
      bytes: versions.reduce((sum, v) => sum + v.bytes, 0),
      limitBytes: HISTORY_BYTES,
      versionLimit: HISTORY_VERSIONS,
      versions,
    };
  }
  storage(projectId: string): Promise<HistoryStorage> {
    return this.enqueue(
      safeId(projectId),
      async () => this.measure(await this.read(projectId)),
      true,
    );
  }
  removeVersion(projectId: string, versionId: string, currentId?: string): Promise<WorkspaceState> {
    return this.enqueue(safeId(projectId), async () => {
      safeId(versionId);
      if (currentId !== undefined) safeId(currentId);
      const state = await this.read(projectId);
      if (!state.versions.some((v) => v.id === versionId))
        throw new Error('This saved version is no longer available.');
      if (versionId === currentId || versionId === state.versions.at(-1)?.id)
        throw new Error(
          'Keep the current PDF and newest saved version. Select an older version to remove.',
        );
      const revision = (state.historyRevision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('History revision limit reached.');
      const noteIds = new Set(
        state.annotations.filter((n) => n.versionId === versionId).map((n) => n.id),
      );
      const next: WorkspaceState = {
        ...state,
        historyRevision: revision,
        versions: state.versions.filter((v) => v.id !== versionId),
        annotations: state.annotations.filter((n) => n.versionId !== versionId),
        attachedNoteIds: state.attachedNoteIds.filter((id) => !noteIds.has(id)),
        // Keep sent note text in chat; its PDF is explicitly no longer available.
        messages: state.messages.map((m) => ({
          ...m,
          versionId: m.versionId === versionId ? undefined : m.versionId,
        })),
      };
      const root = this.root(projectId);
      const changes = [];
      for (const name of ['source.json', 'resume.pdf']) {
        const relative = `versions/${versionId}/${name}`;
        changes.push({ path: relative, before: await readTarget(root, relative), data: null });
      }
      changes.push({
        path: 'state.json',
        before: await readTarget(root, 'state.json'),
        data: Buffer.from(JSON.stringify(next)),
      });
      await fs.mkdir(this.transactions.dataRoot, { recursive: true, mode: 0o700 });
      await this.transactions.commit(root, changes);
      // The transaction commits bytes and references together. Only the now-empty
      // directory is removed afterward; interruption here cannot lose a version.
      await fs.rmdir(path.join(root, 'versions', versionId)).catch(() => {});
      return next;
    });
  }
  async clone(from: string, to: string) {
    await this.flush();
    try {
      await fs.cp(this.root(from), this.root(to), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const state = await this.read(from);
    state.projectId = safeId(to);
    await atomicWrite(path.join(this.root(to), 'state.json'), JSON.stringify(state));
  }
  archive(projectId: string, exportId = projectId): Promise<Uint8Array> {
    const operation = historyArchiver.run(() => this.archiveEntries(projectId, exportId));
    this.archives.add(operation);
    const done = () => this.archives.delete(operation);
    void operation.then(done, done);
    return operation;
  }
  private archiveEntries(projectId: string, exportId: string) {
    return this.enqueue(
      safeId(projectId),
      async () => {
        const state = await this.read(projectId);
        if (state.versions.length > 1000)
          throw new Error(
            'History exceeds the 1,000-version archive limit. Your project files have not been changed.',
          );
        const entries: Record<string, Uint8Array> = {
          'state.json': strToU8(JSON.stringify({ ...state, projectId: safeId(exportId) })),
        };
        let bytes = entries['state.json'].length;
        for (const v of state.versions) {
          for (const name of ['source.json', 'resume.pdf']) {
            const data = await fs.readFile(path.join(this.root(projectId), 'versions', v.id, name));
            if (data.byteLength > 25 * 1024 * 1024)
              throw new Error('A history entry exceeds the 25 MB archive limit.');
            // Validate exactly the bytes being archived, without repeatedly loading
            // the entire chat for each snapshot in a long history.
            if (
              name === 'source.json'
                ? fingerprint(validateProject(JSON.parse(data.toString()))) !== v.fingerprint
                : data.subarray(0, 5).toString() !== '%PDF-' ||
                  (v.pdfFingerprint && pdfFingerprint(data) !== v.pdfFingerprint)
            )
              throw new Error('A saved version is damaged. History could not be exported.');
            bytes += data.byteLength;
            if (bytes > 200 * 1024 * 1024)
              throw new Error('History is too large to bundle in this project (200 MB limit).');
            entries[`versions/${v.id}/${name}`] = data;
          }
        }
        return entries;
      },
      true,
    );
  }
  async exportTo(projectId: string, directory: string) {
    await atomicWrite(path.join(directory, 'resume.folio'), await this.archive(projectId));
  }
  async importFrom(projectId: string, directory: string, replaceLocal = false) {
    await this.flush();
    // Normal opens keep newer local recovery. Guided save recovery passes
    // replaceLocal only after preserving the existing conversation separately.
    try {
      if (!replaceLocal) {
        await fs.access(path.join(this.root(projectId), 'state.json'));
        return;
      }
    } catch {
      /* first open */
    }
    let archive: Buffer;
    try {
      const file = path.join(directory, 'resume.folio');
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 100 * 1024 * 1024)
        throw new Error('Invalid conversation archive.');
      archive = await fs.readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (replaceLocal)
          await atomicWrite(
            path.join(this.root(projectId), 'state.json'),
            JSON.stringify(emptyWorkspace(projectId)),
          );
        return;
      }
      throw error;
    }
    // Validate every header, actual expanded size and snapshot before writing.
    const { state, entries } = decodeWorkspaceArchive(archive, projectId);
    for (const v of state.versions)
      for (const name of ['source.json', 'resume.pdf'])
        await atomicWrite(
          path.join(this.root(projectId), 'versions', v.id, name),
          entries[`versions/${v.id}/${name}`],
        );
    await atomicWrite(path.join(this.root(projectId), 'state.json'), JSON.stringify(state));
  }
}
