import { promises as fs, constants, watch, type FSWatcher, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeRelative } from './file-io';
import type { ProjectDiskChanges, ProjectFile } from '../../src/shared/types';

export const diskKind = (name: string): 'source' | 'asset' | 'project' | null => {
  if (['resume.project.json', 'resume.folio', 'resume.trash'].includes(name)) return 'project';
  if (/\.(tex|sty|cls|bib|txt)$/i.test(name)) return 'source';
  if (/\.(png|jpe?g|pdf|otf|ttf|eps)$/i.test(name)) return 'asset';
  return null;
};
const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const signature = (s: BigIntStats) => `${s.dev}/${s.ino}/${s.size}/${s.mtimeNs}/${s.ctimeNs}`;
type CachedFile = { signature: string; hash: string; content?: string };
export type DiskSnapshot = { hashes: Map<string, string>; sources: ProjectFile[] };

// Event notifications are hints. Each reconciliation traverses the authorized
// tree, and hashes only changed files. Explicit review uses a fresh full hash.
export class ProjectScanner {
  private root = '';
  private cache = new Map<string, CachedFile>();
  async scan(root: string, force = false): Promise<DiskSnapshot> {
    if (root !== this.root) {
      this.root = root;
      this.cache.clear();
    }
    const hashes = new Map<string, string>(),
      sources: ProjectFile[] = [];
    const nextCache = new Map<string, CachedFile>();
    let entries = 0,
      bytes = 0,
      sourceBytes = 0,
      projectFiles = 0;
    const visit = async (relative = '') => {
      const full = path.join(root, relative);
      const directory = await fs.lstat(full);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error('The project folder is missing or contains a symbolic link.');
      const dir = await fs.opendir(full);
      for await (const entry of dir) {
        if (++entries > 5000) throw new Error('This project has too many folder entries to watch.');
        if (entry.name.startsWith('.') || ['node_modules', 'build', 'dist'].includes(entry.name))
          continue;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        safeRelative(name);
        if (entry.isSymbolicLink())
          throw new Error(`Remove the symbolic link ${name} before continuing.`);
        if (entry.isDirectory()) {
          if (name.split('/').length > 8) throw new Error('Project folders are nested too deeply.');
          await visit(name);
          continue;
        }
        const kind = diskKind(name);
        if (!kind) continue;
        const filename = path.join(root, name);
        const stat = await fs.lstat(filename, { bigint: true });
        const limit =
          name === 'resume.folio'
            ? 100 * 1024 * 1024
            : name === 'resume.trash'
              ? 10 * 1024 * 1024 + 128
              : name === 'resume.project.json'
                ? 64 * 1024
                : kind === 'source'
                  ? 2 * 1024 * 1024
                  : 25 * 1024 * 1024;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(limit))
          throw new Error(
            `Cannot read ${name}: expected a regular file within the project size limit.`,
          );
        if (kind !== 'project') {
          bytes += Number(stat.size);
          if (++projectFiles > 200 || bytes > 25 * 1024 * 1024)
            throw new Error('Project files exceed 200 files or 25 MB.');
        }
        if (kind === 'source') {
          sourceBytes += Number(stat.size);
          if (sources.length >= 100 || sourceBytes > 5 * 1024 * 1024)
            throw new Error('Project source exceeds 100 files or 5 MB.');
        }
        let cached = this.cache.get(name);
        if (force || !cached || cached.signature !== signature(stat)) {
          const handle = await fs.open(
            filename,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
          );
          try {
            const before = await handle.stat({ bigint: true });
            if (!before.isFile() || signature(before) !== signature(stat))
              throw new Error('Files are still changing. Check again in a moment.');
            const buffer = Buffer.alloc(Number(stat.size) + 1);
            let size = 0;
            while (size < buffer.length) {
              const read = await handle.read(buffer, size, buffer.length - size, size);
              if (!read.bytesRead) break;
              size += read.bytesRead;
            }
            const after = await handle.stat({ bigint: true });
            if (size !== Number(stat.size) || signature(before) !== signature(after))
              throw new Error('Files are still changing. Check again in a moment.');
            const data = buffer.subarray(0, size);
            cached = { signature: signature(stat), hash: digest(data) };
            if (kind === 'source') {
              try {
                cached.content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                  data,
                );
              } catch {
                throw new Error(`${name} is not valid UTF-8 source text.`);
              }
            }
          } finally {
            await handle.close();
          }
        }
        nextCache.set(name, cached);
        hashes.set(name, cached.hash);
        if (kind === 'source') sources.push({ path: name, content: cached.content! });
      }
    };
    await visit();
    this.cache = nextCache;
    return { hashes, sources };
  }
}

export function compareDisk(
  projectId: string,
  baseline: Map<string, string>,
  snapshot: DiskSnapshot,
): ProjectDiskChanges {
  const changes: ProjectDiskChanges['changes'] = [];
  for (const name of [...new Set([...baseline.keys(), ...snapshot.hashes.keys()])].sort()) {
    const before = baseline.get(name),
      after = snapshot.hashes.get(name);
    if (before === after) continue;
    changes.push({
      path: name,
      kind: diskKind(name) ?? 'project',
      change: !after ? 'removed' : !before ? 'added' : 'modified',
    });
  }
  return {
    projectId,
    token: digest(JSON.stringify([...snapshot.hashes].sort(([a], [b]) => a.localeCompare(b)))),
    changes,
    mainFiles: snapshot.sources
      .filter((f) => f.path.endsWith('.tex'))
      .map((f) => f.path)
      .sort(),
  };
}

export class ProjectWatcher {
  private id: string | null = null;
  private generation = 0;
  private watcher?: FSWatcher;
  private interval?: ReturnType<typeof setInterval>;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<ProjectDiskChanges | null>;
  private last = '';
  constructor(
    private inspect: (id: string) => Promise<ProjectDiskChanges | null>,
    private publish: (report: ProjectDiskChanges) => void,
    private period = 4000,
  ) {}
  stop() {
    this.generation++;
    this.id = null;
    this.last = '';
    this.running = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    clearInterval(this.interval);
    clearTimeout(this.timer);
  }
  async start(id: string | null, directory?: string) {
    this.stop();
    this.id = id;
    if (!id || !directory) return null;
    const generation = this.generation;
    try {
      this.watcher = watch(directory, { recursive: true, persistent: false }, () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          void this.check();
        }, 250);
      });
      const activeWatcher = this.watcher;
      this.watcher.on('error', () => {
        activeWatcher.close();
        if (this.watcher === activeWatcher) this.watcher = undefined;
      });
    } catch {
      /* Periodic reconciliation remains available on unsupported filesystems. */
    }
    this.interval = setInterval(() => {
      if (generation === this.generation) void this.check();
    }, this.period);
    this.interval.unref();
    return this.check();
  }
  check(): Promise<ProjectDiskChanges | null> {
    if (this.running) return this.running;
    const id = this.id,
      generation = this.generation;
    if (!id) return Promise.resolve(null);
    const run = this.inspect(id)
      .catch(
        (error) =>
          ({
            projectId: id,
            token: digest(String(error.message)),
            changes: [],
            mainFiles: [],
            error: String(error.message).slice(0, 1000),
          }) satisfies ProjectDiskChanges,
      )
      .then((report) => {
        if (generation !== this.generation) return null;
        const key = JSON.stringify(report);
        if (report && key !== this.last) {
          this.last = key;
          this.publish(report);
        }
        return report;
      })
      .finally(() => {
        if (this.running === run) this.running = undefined;
      });
    this.running = run;
    return run;
  }
}
