import { createHash } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
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

export async function runtimeFile(root: string, name: string, limit = 256 * 1024 * 1024) {
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

export async function verifyRuntime(root: string, expected?: RuntimePin) {
  const manifest = await readRuntimeManifest(root),
    pin = runtimePin(manifest);
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
  let bytes = 0,
    count = 0;
  const visit = async (relative = '') => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (++count > 25_000) throw new Error('Too many compiler resources.');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      runtimeName(name);
      if (entry.isDirectory()) {
        if (name.split('/').length > 20) throw new Error('Compiler folders are nested too deeply.');
        await visit(name);
      } else {
        if (!entry.isFile())
          throw new Error('Compiler resources must be regular files, without links.');
        if (
          !manifest.files[name] &&
          !['manifest.json', 'bundle.lock.json', 'THIRD_PARTY_NOTICES.md'].includes(name)
        )
          throw new Error(
            `Unexpected compiler resource: ${name}. Repair the compiler before building.`,
          );
      }
    }
  };
  await visit();
  for (const [name, expectedHash] of Object.entries(manifest.files)) {
    const data = await runtimeFile(root, name);
    bytes += data.length;
    if (bytes > 1024 * 1024 * 1024) throw new Error('The compiler resources exceed 1 GB.');
    if (createHash('sha256').update(data).digest('hex') !== expectedHash)
      throw new Error(`The bundled ${name} failed its integrity check.`);
  }
  return { manifest, pin };
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
    const { manifest, pin } = await verifyRuntime(root, expected);
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
