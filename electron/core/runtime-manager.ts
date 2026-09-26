import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { adoptRuntime, validateRuntimePin, type RuntimePin } from '../../src/shared/runtime';
import type { RuntimeStatus } from '../../src/shared/types';
import {
  inspectRuntime,
  readRuntimeManifest,
  runtimeFile,
  runtimePin,
  verifyRuntime,
  type RuntimeManifest,
} from './runtime';
import { Compiler } from './compiler';
import { packDirectory } from './pack-io';
import {
  assembleResourcePack,
  requireResourcePack,
  type ResourcePack,
  type ResourcePackStore,
} from './resource-pack';

export type RuntimeLease = { root: string; status: RuntimeStatus; release(): Promise<void> };
export type RuntimeSource = { acquire(pin?: RuntimePin): Promise<RuntimeLease> };
type Pointer = { generation: string; previous?: string };
export type PackInstallProgress = (
  phase: 'assemble' | 'copy' | 'check' | 'publish',
  completed?: number,
  total?: number,
) => void;
const generationName = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function directory(name: string) {
  await packDirectory(name);
}

async function durableWrite(name: string, data: Uint8Array | string, mode = 0o600) {
  const temporary = `${name}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, name);
    const parent = await fs.open(path.dirname(name), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export class RuntimeManager implements RuntimeSource {
  defaultPin?: RuntimePin;
  private initialized?: Promise<void>;
  private initializationError = '';
  private queue: Promise<unknown> = Promise.resolve();
  private leases = new Map<string, number>();

  constructor(
    readonly bundledRoot: string,
    readonly root: string,
    private options: {
      probe?(root: string, pin: RuntimePin): Promise<void>;
      checkpoint?(phase: 'staged' | 'tested' | 'published'): Promise<void>;
      packs?: ResourcePackStore;
    } = {},
  ) {}

  private serial<T>(action: () => Promise<T>) {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {});
    return operation;
  }

  initialize() {
    this.initialized ??= this.serial(async () => {
      try {
        await directory(this.root);
        this.defaultPin = runtimePin(await readRuntimeManifest(this.bundledRoot));
        const base = await this.base(this.defaultPin);
        try {
          await fs.lstat(path.join(base, 'active.json'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await this.install(this.defaultPin);
        }
      } catch (error) {
        this.initializationError = (error as Error).message;
      }
    });
    return this.initialized;
  }

  private selection(value?: RuntimePin) {
    const selected = adoptRuntime(validateRuntimePin(value), this.defaultPin);
    if (!selected?.id)
      throw new Error(
        selected
          ? `This project requires Tectonic ${selected.version} with ${selected.bundle}. A matching compiler is not included. Its recorded choice has been kept.`
          : `The included compiler could not be prepared. Reinstall Folio from a trusted installer. ${this.initializationError}`,
      );
    return selected;
  }

  private async base(pin: RuntimePin) {
    if (!pin.id || !/^[a-f0-9]{64}$/.test(pin.id))
      throw new Error('A complete compiler pin is required.');
    await directory(this.root);
    const base = path.join(this.root, pin.id);
    await directory(base);
    await directory(path.join(base, 'copies'));
    return base;
  }

  private async pointer(pin: RuntimePin): Promise<Pointer> {
    const base = await this.base(pin);
    const pointer = JSON.parse((await runtimeFile(base, 'active.json', 1024)).toString());
    if (
      !pointer ||
      !generationName.test(pointer.generation) ||
      (pointer.previous !== undefined && !generationName.test(pointer.previous))
    )
      throw new Error('The saved compiler selection is damaged. Repair this compiler in Settings.');
    return pointer;
  }

  private async copyPath(pin: RuntimePin, generation: string) {
    if (!generationName.test(generation)) throw new Error('Invalid compiler copy.');
    const base = await this.base(pin),
      copy = path.join(base, 'copies', generation);
    if (!(await fs.lstat(copy)).isDirectory())
      throw new Error('The saved compiler copy is not a regular folder.');
    const ready = JSON.parse((await runtimeFile(copy, 'ready.json', 2048)).toString());
    if (JSON.stringify(validateRuntimePin(ready.pin)) !== JSON.stringify(pin))
      throw new Error('The saved compiler copy does not match this project.');
    return path.join(copy, 'runtime');
  }

  private async activePath(pin: RuntimePin) {
    return this.copyPath(pin, (await this.pointer(pin)).generation);
  }

  private async probe(root: string, pin: RuntimePin, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.options.probe) return this.options.probe(root, pin);
    // Exercise the bundled bibliography helper too. A newly copied Biber has
    // first-execution preparation costs that should belong to installation,
    // not consume a user's first document's 30-second compilation budget.
    // This longer, bounded check compiles only this app-owned tiny fixture.
    const compiler = new Compiler(root, path.join(this.root, 'self-test'), 60_000);
    const cancel = () => {
      void compiler.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      const result = await compiler.compile({
        id: 'runtime-self-test',
        name: 'Compiler self-test',
        mainFile: 'main.tex',
        revision: 0,
        runtime: pin,
        files: [
          {
            path: 'main.tex',
            content: pin.biberVersion
              ? '\\documentclass{article}\\usepackage[style=verbose,backend=biber]{biblatex}\\addbibresource{check.bib}\\begin{document}Folio offline compiler check.\\cite{check}\\printbibliography\\end{document}'
              : '\\documentclass{article}\\begin{document}Folio offline compiler check.\\end{document}',
          },
          ...(pin.biberVersion
            ? [
                {
                  path: 'check.bib',
                  content:
                    '@book{check,author={Example, Alex},title={Folio Offline Check},year={2026}}',
                },
              ]
            : []),
        ],
      });
      if (
        result.status !== 'success' ||
        !result.pdf ||
        (pin.biberVersion && !result.log.includes('Running external tool biber'))
      )
        throw new Error(`The offline compiler check failed. ${result.log.slice(-1000)}`);
      signal?.throwIfAborted();
      const manifest = await readRuntimeManifest(root);
      if (manifest.files['pack-check.tex']) {
        const content = (await runtimeFile(root, 'pack-check.tex', 256 * 1024)).toString('utf8');
        signal?.throwIfAborted();
        const check = await compiler.compile({
          id: 'pack-self-test',
          name: 'Resource pack check',
          mainFile: 'main.tex',
          revision: 0,
          runtime: pin,
          files: [{ path: 'main.tex', content }],
        });
        signal?.throwIfAborted();
        if (check.status !== 'success' || !check.pdf)
          throw new Error(`The resource pack check failed. ${check.log.slice(-1000)}`);
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      await compiler.cancel();
    }
  }

  private async publish(pin: RuntimePin, generation: string) {
    const base = await this.base(pin);
    const previous = await this.pointer(pin)
      .then((value) => value.generation)
      .catch(() => undefined);
    await durableWrite(
      path.join(base, 'active.json'),
      JSON.stringify({ generation, ...(previous && previous !== generation ? { previous } : {}) }),
    );
  }

  private async install(pin: RuntimePin) {
    if (pin.platform !== `${process.platform}-${process.arch}`)
      throw new Error(
        'This compiler was built for a different platform. Its recorded choice has been kept.',
      );
    if (pin.id !== this.defaultPin?.id)
      throw new Error(
        'This installer does not include the recorded compiler. Keep its selection and reinstall a matching Folio version.',
      );
    // Verify the trusted installer copy before copying or changing any pointer.
    const { manifest } = await verifyRuntime(this.bundledRoot, pin);
    await this.stage(pin, this.bundledRoot, manifest);
  }

  private async stage(
    pin: RuntimePin,
    source: string,
    manifest: RuntimeManifest,
    overrides = new Map<string, Buffer>(),
    signal?: AbortSignal,
    progress?: PackInstallProgress,
  ) {
    signal?.throwIfAborted();
    if (pin.platform !== `${process.platform}-${process.arch}`)
      throw new Error('This compiler was built for a different platform.');
    const base = await this.base(pin),
      generation = randomUUID();
    const copy = path.join(base, 'copies', generation),
      runtime = path.join(copy, 'runtime');
    await directory(copy);
    await directory(runtime);
    try {
      const names = new Set([...Object.keys(manifest.files), 'manifest.json']);
      for (const optional of ['bundle.lock.json', 'THIRD_PARTY_NOTICES.md']) {
        try {
          await fs.lstat(path.join(source, optional));
          names.add(optional);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      // Bound concurrent reads/writes; engine files can be much larger than a font.
      let next = 0;
      const files = [...names];
      let count = 0;
      progress?.('copy', 0, files.length);
      const copied = await Promise.allSettled(
        Array.from({ length: 4 }, async () => {
          while (next < files.length) {
            signal?.throwIfAborted();
            const name = files[next++],
              destination = path.join(runtime, name);
            const data = overrides.get(name) ?? (await runtimeFile(source, name));
            const mode = overrides.has(name)
              ? 0o600
              : (await fs.lstat(path.join(source, name))).mode & 0o111
                ? 0o700
                : 0o600;
            await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            await durableWrite(destination, data, mode);
            if (++count % 32 === 0 || count === files.length)
              progress?.('copy', count, files.length);
          }
        }),
      );
      const failed = copied.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      await this.options.checkpoint?.('staged');
      signal?.throwIfAborted();
      await verifyRuntime(runtime, pin);
      progress?.('check');
      await this.probe(runtime, pin, signal);
      signal?.throwIfAborted();
      await durableWrite(path.join(copy, 'ready.json'), JSON.stringify({ pin }));
      await this.options.checkpoint?.('tested');
      signal?.throwIfAborted();
      progress?.('publish');
      await this.publish(pin, generation);
      await this.options.checkpoint?.('published');
    } catch (error) {
      // A post-rename sync error may still have committed the pointer. Never
      // remove a copy which the active pointer now names.
      const active = await this.pointer(pin).catch(() => undefined);
      if (active?.generation !== generation) await fs.rm(copy, { recursive: true, force: true });
      throw error;
    }
    await this.cleanup(pin);
  }

  private async packBase(pack: ResourcePack) {
    requireResourcePack(pack);
    try {
      const root = await this.activePath(pack.base);
      await verifyRuntime(root, pack.base);
      return root;
    } catch {
      const backup = await this.backup(pack.base);
      if (backup) return backup.root;
      if (pack.base.id === this.defaultPin?.id) {
        await verifyRuntime(this.bundledRoot, pack.base);
        return this.bundledRoot;
      }
      throw new Error(
        'Install or repair this pack’s exact base compiler first. The project selection has been kept.',
      );
    }
  }

  private async installResourcePack(
    pack: ResourcePack,
    signal?: AbortSignal,
    progress?: PackInstallProgress,
  ) {
    signal?.throwIfAborted();
    const root = await this.packBase(pack);
    signal?.throwIfAborted();
    progress?.('assemble');
    const { manifest, pin, overrides } = await assembleResourcePack(pack, root);
    signal?.throwIfAborted();
    await this.stage(pin, root, manifest, overrides, signal, progress);
  }

  async installPack(pack: ResourcePack, signal?: AbortSignal, progress?: PackInstallProgress) {
    requireResourcePack(pack);
    signal?.throwIfAborted();
    await this.initialize();
    await this.serial(() => this.installResourcePack(pack, signal, progress));
    return this.status(pack.target);
  }

  private async retainedPack(pin: RuntimePin) {
    const pack = await this.options.packs?.get(pin);
    if (!pack) return undefined;
    await this.packBase(pack);
    return pack;
  }

  private async canRepair(pin: RuntimePin) {
    return (
      pin.platform === `${process.platform}-${process.arch}` &&
      (pin.id === this.defaultPin?.id ||
        !!(await this.backup(pin).catch(() => undefined)) ||
        !!(await this.retainedPack(pin).catch(() => undefined)))
    );
  }

  private async cleanup(pin: RuntimePin) {
    const base = await this.base(pin),
      selected = await this.pointer(pin);
    // Keep one rollback copy and every copy currently leased by a compiler.
    for (const entry of await fs.readdir(path.join(base, 'copies'), { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !generationName.test(entry.name) ||
        entry.name === selected.generation ||
        entry.name === selected.previous
      )
        continue;
      const copy = path.join(base, 'copies', entry.name);
      if (this.leases.has(path.join(copy, 'runtime'))) continue;
      await fs.rm(copy, { recursive: true, force: true });
    }
  }

  private async backup(pin: RuntimePin) {
    const base = await this.base(pin);
    const active = await this.pointer(pin).catch(() => undefined);
    for (const entry of await fs.readdir(path.join(base, 'copies'), { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !generationName.test(entry.name) ||
        entry.name === active?.generation
      )
        continue;
      try {
        const root = await this.copyPath(pin, entry.name);
        await verifyRuntime(root, pin);
        return { root, generation: entry.name };
      } catch {
        /* An unfinished or damaged copy is not a repair source. */
      }
    }
    return undefined;
  }

  async status(value?: RuntimePin): Promise<RuntimeStatus> {
    await this.initialize();
    return this.serial(async () => {
      let pin: RuntimePin | undefined;
      try {
        pin = this.selection(value);
        const result = await inspectRuntime(await this.activePath(pin), pin);
        return {
          ...result,
          pin,
          engine: `Tectonic ${pin.version}${pin.biberVersion ? ` · Biber ${pin.biberVersion}` : ''}`,
          bundle: pin.bundle,
          defaultPin: this.defaultPin,
          canRepair: await this.canRepair(pin),
          message: result.ready
            ? 'This project uses its recorded compiler. Ready to build offline.'
            : `${result.message} Use Repair compiler in Settings when available.`,
        };
      } catch (error) {
        const canRepair = !!pin && (await this.canRepair(pin));
        return {
          ready: false,
          engine: `Tectonic ${pin?.version ?? value?.version ?? 'unavailable'}`,
          bundle: pin?.bundle ?? value?.bundle ?? 'Unavailable',
          platform: `${process.platform}-${process.arch}`,
          isolation: process.platform === 'darwin' ? 'macos-seatbelt' : 'unavailable',
          pin: pin ?? value,
          defaultPin: this.defaultPin,
          canRepair,
          message:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? pin?.id === this.defaultPin?.id && this.initializationError
                ? `The included compiler could not be prepared. ${this.initializationError}`
                : canRepair
                  ? 'The recorded compiler is missing. Repair it below using matching local files.'
                  : 'The recorded compiler is missing. Reinstall the matching Folio version to restore it. You can still edit and save this project.'
              : (error as Error).message,
        };
      }
    });
  }

  async repair(value?: RuntimePin) {
    await this.initialize();
    const pin = this.selection(value);
    if (pin.platform !== `${process.platform}-${process.arch}`)
      throw new Error(
        'This compiler was built for a different platform. Its recorded choice has been kept.',
      );
    await this.serial(async () => {
      if (pin.id === this.defaultPin?.id) await this.install(pin);
      else {
        const backup = await this.backup(pin);
        if (!backup) {
          const pack = await this.retainedPack(pin);
          if (pack) return this.installResourcePack(pack);
          throw new Error(
            'No verified copy of this recorded compiler is available. Install the matching Folio version; the project has not been changed.',
          );
        }
        await this.probe(backup.root, pin);
        await this.publish(pin, backup.generation);
        await this.cleanup(pin);
      }
    });
    return this.status(pin);
  }

  async acquire(value?: RuntimePin): Promise<RuntimeLease> {
    await this.initialize();
    return this.serial(async () => {
      const pin = this.selection(value),
        root = await this.activePath(pin);
      const status = await inspectRuntime(root, pin);
      if (!status.ready) throw new Error(status.message);
      this.leases.set(root, (this.leases.get(root) ?? 0) + 1);
      let released = false;
      return {
        root,
        status,
        release: async () => {
          if (released) return;
          released = true;
          await this.serial(async () => {
            const count = (this.leases.get(root) ?? 1) - 1;
            if (count) this.leases.set(root, count);
            else this.leases.delete(root);
            await this.cleanup(pin).catch(() => {});
          });
        },
      };
    });
  }
}
