import { createHash } from 'node:crypto';
import { promises as fs, constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { RuntimeStatus } from '../../src/shared/types';
import { validateRuntimePin, type RuntimePin } from '../../src/shared/runtime';

export type RuntimeManifest = {
  schemaVersion: 1;
  version: string;
  bundle: string;
  platform: string;
  biberVersion?: string;
  files: Record<string, string>;
};

export async function readRuntimeManifest(root: string): Promise<RuntimeManifest> {
  if (!(await fs.lstat(root)).isDirectory())
    throw new Error('The compiler folder is not a regular directory.');
  const data = await runtimeFile(root, 'manifest.json', 2 * 1024 * 1024);
  const value = JSON.parse(data.toString());
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !value.files ||
    typeof value.files !== 'object' ||
    Array.isArray(value.files)
  )
    throw new Error('The compiler manifest is invalid.');
  validateRuntimePin({
    engine: 'tectonic',
    id: '0'.repeat(64),
    version: value.version,
    bundle: value.bundle,
    platform: value.platform,
    biberVersion: value.biberVersion,
  });
  const entries = Object.entries(value.files);
  if (!entries.length || entries.length > 20_000)
    throw new Error('The compiler file inventory is invalid.');
  const seen = new Set<string>();
  for (const [name, digest] of entries) {
    runtimeName(name);
    if (
      seen.has(name.toLowerCase()) ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new Error('The compiler file inventory is invalid.');
    seen.add(name.toLowerCase());
  }
  const executable = value.platform.startsWith('win32-') ? 'tectonic.exe' : 'tectonic';
  for (const name of [
    executable,
    'bundle.zip',
    ...(value.biberVersion ? ['biber', 'biber-cache/biber'] : []),
  ])
    if (!value.files[name]) throw new Error(`Runtime manifest is missing ${name}.`);
  return value;
}

function runtimeName(name: string) {
  if (
    !name ||
    name.length > 500 ||
    name.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\\:\x00-\x1f]/.test(name)
  )
    throw new Error('Invalid runtime manifest path.');
}

export async function openRuntimeFile(root: string, name: string, limit = 256 * 1024 * 1024) {
  runtimeName(name);
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++)
    if (!(await fs.lstat(path.join(root, ...parts.slice(0, i)))).isDirectory())
      throw new Error('Compiler files must not pass through linked folders.');
  const handle = await fs.open(
    path.join(root, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error('A compiler resource is not a regular file or exceeds its size limit.');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function runtimeFile(root: string, name: string, limit = 256 * 1024 * 1024) {
  const handle = await openRuntimeFile(root, name, limit);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function runtimePin(manifest: RuntimeManifest): RuntimePin {
  const identity = {
    version: manifest.version,
    bundle: manifest.bundle,
    platform: manifest.platform,
    biberVersion: manifest.biberVersion ?? null,
    files: Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
  return validateRuntimePin({
    engine: 'tectonic',
    ...identity,
    id: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    biberVersion: manifest.biberVersion,
  })!;
}

function requireSelection(pin: RuntimePin, expected?: RuntimePin) {
  const selection = validateRuntimePin(expected);
  if (
    selection &&
    (selection.id
      ? JSON.stringify(selection) !== JSON.stringify(pin)
      : selection.version !== pin.version ||
        selection.bundle !== pin.bundle ||
        (selection.biberVersion && selection.biberVersion !== pin.biberVersion))
  )
    throw new Error('This compiler does not match the version recorded in the project.');
}

// Walks the complete folder, rejecting links, special files and resources the
// manifest does not name. With `identities`, it also returns a digest of each
// file's filesystem identity (device, inode, size, mode, link count and
// nanosecond modification/change times). Any write, replacement, rename or
// permission change alters the change time, which ordinary programs cannot set.
async function walkRuntime(root: string, manifest: RuntimeManifest, identities = false) {
  const digest = identities ? createHash('sha256') : undefined;
  const describe = (name: string, stat: BigIntStats) =>
    `${name}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.nlink}:${stat.mtimeNs}:${stat.ctimeNs}\n`;
  if (digest) digest.update(describe('', await fs.lstat(root, { bigint: true })));
  let count = 0;
  const visit = async (relative = '') => {
    const files: string[] = [],
      folders: string[] = [];
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (++count > 25_000) throw new Error('Too many compiler resources.');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      runtimeName(name);
      if (entry.isDirectory()) {
        if (name.split('/').length > 20) throw new Error('Compiler folders are nested too deeply.');
        folders.push(name);
      } else {
        if (!entry.isFile())
          throw new Error('Compiler resources must be regular files, without links.');
        if (
          !Object.hasOwn(manifest.files, name) &&
          !['manifest.json', 'bundle.lock.json', 'THIRD_PARTY_NOTICES.md'].includes(name)
        )
          throw new Error(
            `Unexpected compiler resource: ${name}. Repair the compiler before building.`,
          );
        files.push(name);
      }
    }
    if (digest) {
      const entries = [...folders, ...files];
      const stats = await Promise.all(
        entries.map((name) => fs.lstat(path.join(root, name), { bigint: true })),
      );
      for (const [index, stat] of stats.entries()) {
        if (index < folders.length ? !stat.isDirectory() : !stat.isFile())
          throw new Error('Compiler resources must be regular files, without links.');
        digest.update(describe(entries[index], stat));
      }
    }
    for (const name of folders) await visit(name);
  };
  await visit();
  return digest?.digest('hex');
}

/**
 * Checks the manifest, exact identity and folder layout without reading file
 * contents. Callers must hash every resource themselves before trusting it.
 */
export async function checkRuntimeLayout(root: string, expected?: RuntimePin) {
  const manifest = await readRuntimeManifest(root),
    pin = runtimePin(manifest);
  requireSelection(pin, expected);
  await walkRuntime(root, manifest);
  return { manifest, pin };
}

export async function verifyRuntime(root: string, expected?: RuntimePin) {
  const result = await checkRuntimeLayout(root, expected);
  await hashRuntime(root, result.manifest);
  return result;
}

async function hashRuntime(root: string, manifest: RuntimeManifest) {
  let bytes = 0;
  // Hash every byte. Four readers overlap filesystem waits without retaining
  // complete resources; only verifyRuntimeReusing may reuse a prior success.
  const entries = Object.entries(manifest.files);
  let next = 0,
    failed = false,
    failure: unknown;
  const readAndHash = async () => {
    const buffer = Buffer.allocUnsafe(128 * 1024);
    while (!failed && next < entries.length) {
      const [name, expectedHash] = entries[next++];
      try {
        const limit = 256 * 1024 * 1024;
        const handle = await openRuntimeFile(root, name, limit);
        try {
          const digest = createHash('sha256');
          let fileBytes = 0;
          while (!failed) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            fileBytes += bytesRead;
            bytes += bytesRead;
            if (fileBytes > limit) throw new Error('A compiler resource exceeds its size limit.');
            if (bytes > 1024 * 1024 * 1024) throw new Error('The compiler resources exceed 1 GB.');
            digest.update(buffer.subarray(0, bytesRead));
          }
          if (!failed && digest.digest('hex') !== expectedHash)
            throw new Error(`The bundled ${name} failed its integrity check.`);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  // Settle every reader before returning an error, so a rejected verification
  // leaves no file handles or background reads behind.
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, readAndHash));
  if (failed) throw failure;
}

export const runtimeReusePolicy = Object.freeze({ maxAgeMs: 10 * 60_000, entries: 8 });
const verifiedRuntimes = new Map<string, { id: string; identity: string; verifiedAt: number }>();

/** Forget every reusable verification, so the next check rehashes every byte. */
export function forgetRuntimeVerifications() {
  verifiedRuntimes.clear();
}

// Builds call this before every compilation. A complete byte-for-byte
// verification is reused only while the manifest identity and every file's
// filesystem identity are unchanged, and for at most `maxAgeMs`; every new
// process, changed/replaced/added/removed file or expired result rehashes
// all bytes. The full rehash otherwise dominated warm builds (about 0.7 s of
// 0.85 s) and was the largest main-process CPU consumer in long sessions.
export async function verifyRuntimeReusing(root: string, expected?: RuntimePin) {
  const key = path.resolve(root),
    manifest = await readRuntimeManifest(root),
    pin = runtimePin(manifest);
  requireSelection(pin, expected);
  const previous = verifiedRuntimes.get(key);
  verifiedRuntimes.delete(key);
  try {
    const before = await walkRuntime(root, manifest, true);
    if (
      previous &&
      previous.id === pin.id &&
      previous.identity === before &&
      performance.now() - previous.verifiedAt < runtimeReusePolicy.maxAgeMs
    ) {
      verifiedRuntimes.set(key, previous);
      return { manifest, pin };
    }
    // A monotonic clock: setting the system clock back cannot extend reuse.
    const verifiedAt = performance.now();
    await hashRuntime(root, manifest);
    // Remember the result only if nothing changed while the bytes were read.
    // The manifest is part of the walk, so its identity is covered too.
    if ((await walkRuntime(root, manifest, true)) === before) {
      verifiedRuntimes.set(key, { id: pin.id!, identity: before!, verifiedAt });
      while (verifiedRuntimes.size > runtimeReusePolicy.entries)
        verifiedRuntimes.delete(verifiedRuntimes.keys().next().value!);
    }
    return { manifest, pin };
  } catch (error) {
    verifiedRuntimes.delete(key);
    throw error;
  }
}

export async function inspectRuntime(root: string, expected?: RuntimePin): Promise<RuntimeStatus> {
  const status: RuntimeStatus = {
    ready: false,
    engine: 'Tectonic 0.17.0',
    bundle: 'folio-core-v1',
    platform: `${process.platform}-${process.arch}`,
    isolation: process.platform === 'darwin' ? 'macos-seatbelt' : 'unavailable',
    message: '',
  };
  try {
    const { manifest, pin } = await verifyRuntimeReusing(root, expected);
    status.pin = pin;
    if (manifest.platform !== status.platform)
      throw new Error('This compiler was built for a different platform.');
    if (process.platform !== 'darwin')
      throw new Error(
        'Compiler isolation for Windows and Linux is still in development. Editing and saving are available in this preview.',
      );
    await fs.access('/usr/bin/sandbox-exec');
    status.ready = true;
    status.engine = `Tectonic ${manifest.version}${manifest.biberVersion ? ` · Biber ${manifest.biberVersion}` : ''}`;
    status.bundle = manifest.bundle;
    status.message = 'Your compiler and template resources are bundled. Ready to work offline.';
  } catch (error) {
    status.message =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'The LaTeX runtime is not prepared. In a source checkout, run npm run runtime:prepare, then restart Folio.'
        : (error as Error).message;
  }
  return status;
}

function literal(value: string) {
  return JSON.stringify(value);
}

export function macSandboxProfile(binary: string, runtime: string, job: string, cache: string) {
  return `(version 1)
(deny default)
(allow process-fork)
(allow process-exec (literal ${literal(binary)})
  (literal ${literal(path.join(runtime, 'biber'))})
  (literal ${literal(path.join(runtime, 'biber-cache', 'biber'))}))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read* (literal "/") (literal ${literal(binary)}) (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share")
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
  (subpath ${literal(runtime)}) (subpath ${literal(job)}) (subpath ${literal(cache)}))
(allow file-write* (literal "/dev/null") (subpath ${literal(job)}) (subpath ${literal(cache)}))`;
}
