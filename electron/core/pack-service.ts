import { promises as fs, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RuntimePin } from '../../src/shared/runtime';
import type {
  PackActivity,
  PackChoice,
  PackImportPreview,
  PackLibrary,
} from '../../src/shared/packs';
import {
  CatalogVerifier,
  MAX_CATALOG_BYTES,
  MAX_PACK_BYTES,
  PackCatalogStore,
  packUrl,
  type CatalogPack,
  type VerifiedCatalog,
} from './pack-catalog';
import { PackDownloads } from './pack-download';
import { packFile } from './pack-io';
import {
  ResourcePackStore,
  ResourcePackVerifier,
  resourcePackBytes,
  resourcePackNotices,
  type ResourcePack,
} from './resource-pack';
import type { RuntimeManager } from './runtime-manager';

export type PackTrust = {
  keys: Record<string, string>;
  hosts: string[];
  catalogUrl?: string;
  minimumSequence: number;
};
type Dependencies = {
  runtime: Pick<RuntimeManager, 'status' | 'installPack'>;
  choose(): Promise<string | undefined>;
  start(): Promise<void>;
  progress(value: PackActivity): void;
  fetch?: typeof fetch;
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const keyPattern = /^[a-f0-9]{64}$/;

export class PackService {
  readonly archives: ResourcePackStore;
  private readonly verifier: ResourcePackVerifier;
  private readonly catalogStore: PackCatalogStore;
  private readonly downloads: PackDownloads;
  private catalog?: VerifiedCatalog | null;
  private fresh = false;
  private catalogError = '';
  private choices = new Map<string, PackChoice>();
  private pending?: { token: string; pack: ResourcePack };
  private operation?: { id: string; abort: AbortController; done: Promise<unknown> };

  constructor(
    readonly root: string,
    private trust: PackTrust,
    private deps: Dependencies,
  ) {
    this.verifier = new ResourcePackVerifier(trust.keys);
    this.archives = new ResourcePackStore(path.join(root, 'archives'), this.verifier);
    this.catalogStore = new PackCatalogStore(
      path.join(root, 'catalog'),
      new CatalogVerifier(trust.keys, trust.hosts, trust.minimumSequence),
    );
    this.downloads = new PackDownloads(path.join(root, 'downloads'), trust.hosts, {
      fetch: deps.fetch,
    });
  }
  get active() {
    return !!this.operation;
  }
  requireIdle() {
    if (this.operation) throw new Error('Finish or cancel the resource pack operation first.');
  }
  private run<T>(
    id: string,
    action: (signal: AbortSignal) => Promise<T>,
    start = false,
  ): Promise<T> {
    this.requireIdle();
    if (!uuid.test(id)) throw new Error('Invalid pack operation.');
    const operation = {
      id,
      abort: new AbortController(),
      done: Promise.resolve() as Promise<unknown>,
    };
    this.operation = operation;
    const work = Promise.resolve()
      .then(async () => {
        if (start) await this.deps.start();
        operation.abort.signal.throwIfAborted();
        return action(operation.abort.signal);
      })
      .finally(() => {
        if (this.operation === operation) this.operation = undefined;
      });
    operation.done = work;
    return work;
  }
  async cancel(id?: string) {
    if (id !== undefined && !uuid.test(id)) throw new Error('Invalid pack operation.');
    const operation = this.operation;
    if (!id || operation?.id === id) {
      operation?.abort.abort(new Error('Resource pack operation cancelled.'));
      await operation?.done.catch(() => {});
      this.pending = undefined;
    }
  }
  private async loadCatalog() {
    this.fresh = false;
    this.catalogError = '';
    try {
      this.catalog = await this.catalogStore.load();
      this.fresh = !!this.catalog;
    } catch (error) {
      this.catalogError = (error as Error).message;
      this.catalog = await this.catalogStore.load(true).catch(() => null);
    }
  }
  private catalogPack(key: string) {
    if (!keyPattern.test(key)) throw new Error('Invalid resource pack identity.');
    const pack = this.catalog?.packs.find((pack) => pack.target.id === key);
    if (!pack) throw new Error('Refresh the catalog and choose a listed pack.');
    return pack;
  }
  private async choice(pack: ResourcePack | CatalogPack, retained: boolean): Promise<PackChoice> {
    const status = await this.deps.runtime.status(pack.target);
    return {
      key: pack.target.id!,
      title: pack.title,
      description: pack.description,
      packages: [...pack.packages],
      base: { ...pack.base },
      target: { ...pack.target },
      bytes: 'artifact' in pack ? pack.artifact.bytes : pack.archiveBytes,
      retained,
      installed: status.ready,
      canDownload: false,
      catalog: false,
      cachedBytes: 0,
      message: status.message,
    };
  }
  private async snapshot(): Promise<PackLibrary> {
    await this.loadCatalog();
    const { packs, warnings } = await this.archives.list();
    const choices = new Map<string, PackChoice>();
    for (const pack of packs) choices.set(pack.target.id!, await this.choice(pack, true));
    for (const pack of this.catalog?.packs ?? []) {
      const row = choices.get(pack.target.id!) ?? (await this.choice(pack, false));
      row.canDownload = this.fresh;
      row.catalog = true;
      try {
        row.cachedBytes = await this.downloads.cachedBytes(pack);
      } catch (error) {
        warnings.push((error as Error).message);
      }
      choices.set(row.key, row);
    }
    this.choices = choices;
    return {
      configured: !!Object.keys(this.trust.keys).length,
      catalogAvailable: !!this.trust.catalogUrl && !!Object.keys(this.trust.keys).length,
      catalogDate: this.catalog?.issuedAt,
      catalogError: this.catalogError || undefined,
      choices: [...choices.values()],
      warnings,
    };
  }
  list() {
    return this.run(randomUUID(), () => this.snapshot());
  }

  refresh(id: string) {
    return this.run(id, async (signal) => {
      if (!this.trust.catalogUrl || !Object.keys(this.trust.keys).length)
        throw new Error('The pack publisher has not configured a catalog for this build yet.');
      this.deps.progress({ id, phase: 'catalog' });
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let url = packUrl(this.trust.catalogUrl, new Set(this.trust.hosts));
      for (let attempt = 0; attempt <= 5; attempt++) {
        const response = await (this.deps.fetch ?? fetch)(url, {
          signal: requestSignal,
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || attempt === 5) throw new Error('The catalog redirected too many times.');
          url = packUrl(new URL(location, url).href, new Set(this.trust.hosts));
          continue;
        }
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          throw new Error(`The catalog server returned HTTP ${response.status}.`);
        }
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            requestSignal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > MAX_CATALOG_BYTES * 2)
              throw new Error('The catalog exceeds its size limit.');
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        requestSignal.throwIfAborted();
        await this.catalogStore.accept(Buffer.concat(chunks));
        return this.snapshot();
      }
      throw new Error('The catalog could not be reached.');
    });
  }
  prepareImport(id: string): Promise<PackImportPreview | null> {
    return this.run(id, async (signal) => {
      this.pending = undefined;
      const filename = await this.deps.choose();
      signal.throwIfAborted();
      if (!filename) return null;
      this.deps.progress({ id, phase: 'import' });
      const handle = await fs.open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let data: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_PACK_BYTES)
          throw new Error('Choose a regular signed pack file no larger than 128 MiB.');
        const output = Buffer.alloc(stat.size + 1);
        let size = 0;
        while (size < output.length) {
          signal.throwIfAborted();
          const read = await handle.read(
            output,
            size,
            Math.min(1024 * 1024, output.length - size),
            size,
          );
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (size !== stat.size)
          throw new Error('The selected pack changed while being read. Choose it again.');
        data = output.subarray(0, size);
      } finally {
        await handle.close();
      }
      signal.throwIfAborted();
      const pack = this.verifier.read(data),
        token = randomUUID();
      const choice = await this.choice(pack, false);
      signal.throwIfAborted();
      this.pending = { token, pack };
      return { token, choice, notices: resourcePackNotices(pack) };
    });
  }
  install(id: string, key: string, source: 'catalog' | 'retained' | 'import') {
    return this.run(
      id,
      async (signal) => {
        let pack: ResourcePack;
        if (source === 'import') {
          if (!this.pending || this.pending.token !== key)
            throw new Error('Choose and review the signed pack again.');
          pack = this.pending.pack;
        } else if (source === 'retained') {
          const choice = this.choices.get(key);
          if (!choice?.retained) throw new Error('Choose a retained signed pack.');
          const saved = await this.archives.get(choice.target);
          if (!saved)
            throw new Error('The retained archive is missing. Import it or download it again.');
          pack = saved;
        } else if (source === 'catalog') {
          await this.loadCatalog();
          const selected = this.catalogPack(key);
          const downloaded = await this.downloads.download(selected, {
            signal,
            progress: (value) =>
              this.deps.progress({
                id,
                phase: 'download',
                completed: value.received,
                total: value.total,
                resumed: value.resumed,
              }),
          });
          const bytes = await packFile(
            path.dirname(downloaded.path),
            path.basename(downloaded.path),
            MAX_PACK_BYTES,
          );
          if (!bytes) throw new Error('The downloaded file is missing. Download it again.');
          pack = this.verifier.read(bytes, selected);
        } else throw new Error('Invalid pack source.');
        signal.throwIfAborted();
        // Keep the signed artifact before staging so interruption still permits
        // exact local repair. Retaining it never changes the active compiler.
        await this.archives.retain(resourcePackBytes(pack));
        signal.throwIfAborted();
        const result = await this.deps.runtime.installPack(
          pack,
          signal,
          (phase, completed, total) => this.deps.progress({ id, phase, completed, total }),
        );
        if (!result.ready) throw new Error(result.message);
        this.pending = undefined;
        // Do not reinterpret late cancellation as a rollback of publication.
        return this.snapshot();
      },
      true,
    );
  }
  removeDownload(id: string, key: string) {
    return this.run(id, async () => {
      await this.loadCatalog();
      await this.downloads.remove(this.catalogPack(key));
      return this.snapshot();
    });
  }
  async target(key: string): Promise<RuntimePin> {
    this.requireIdle();
    if (!keyPattern.test(key)) throw new Error('Invalid pack target.');
    // Rebuild the trusted index on each comparison; renderer metadata grants no authority.
    await this.list();
    const choice = this.choices.get(key);
    if (!choice?.installed) throw new Error('Install and verify this pack before comparing it.');
    return { ...choice.target };
  }
}
