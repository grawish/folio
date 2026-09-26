import { createHash, sign, type KeyObject } from 'node:crypto';
import { zipSync } from 'fflate';
import {
  CatalogVerifier,
  MAX_PACK_BYTES,
  requireVerifiedPack,
  type CatalogPack,
} from './pack-catalog';
import { readSafeZip } from './safe-zip';
import { runtimeFile, runtimePin, verifyRuntime, type RuntimeManifest } from './runtime';
import { validateRuntimePin, type RuntimePin } from '../../src/shared/runtime';
import { packFile, savePackFile } from './pack-io';
import { packDirectory } from './pack-io';
import { promises as fs } from 'node:fs';
import { resourceName } from './pack-resource-name';

export const PACK_SIGNATURE_CONTEXT = 'Folio resource pack archive v1\n';
const RESOURCE_LIMIT = 20 * 1024 * 1024;
const NOTICE_LIMIT = 4 * 1024 * 1024;
const PROBE_LIMIT = 256 * 1024;
const MAX_RESOURCES = 512;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type InventoryEntry = Readonly<{ bytes: number; sha256: string }>;
export type PackDescription = Readonly<{
  id: string;
  title: string;
  description: string;
  base: Readonly<RuntimePin>;
  target: Readonly<RuntimePin>;
  packages: readonly string[];
}>;
export type ResourcePack = PackDescription &
  Readonly<{ keyId: string; archiveSha256: string; archiveBytes: number }>;
type PackContents = {
  archive: Buffer;
  resources: Map<string, Buffer>;
  notices: Buffer;
  probe: Buffer;
};
const contents = new WeakMap<ResourcePack, PackContents>();
export type PackAssembly = {
  manifest: RuntimeManifest;
  pin: RuntimePin;
  overrides: Map<string, Buffer>;
};

function record(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('The resource pack metadata has an unsupported structure.');
  return value as Record<string, unknown>;
}
function label(value: unknown, limit: number) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > limit ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error('The resource pack contains invalid text.');
  return value;
}
function pin(value: unknown) {
  const result = validateRuntimePin(value);
  if (!result?.id || result.platform !== 'darwin-arm64')
    throw new Error('Resource packs require an exact Apple silicon compiler.');
  record(value, [
    'engine',
    'version',
    'bundle',
    'id',
    'platform',
    ...(result.biberVersion ? ['biberVersion'] : []),
  ]);
  return Object.freeze(result);
}
function description(value: Record<string, unknown>): PackDescription {
  const id = label(value.id, 100),
    base = pin(value.base),
    target = pin(value.target);
  if (
    !/^[a-z0-9][a-z0-9.-]{0,99}$/.test(id) ||
    base.id === target.id ||
    base.version !== target.version ||
    base.biberVersion !== target.biberVersion
  )
    throw new Error('The resource pack must preserve its exact base engine version.');
  if (!Array.isArray(value.packages) || !value.packages.length || value.packages.length > 128)
    throw new Error('The resource pack needs a bounded list of supported packages.');
  const packages = value.packages.map(resourceName);
  if (new Set(packages.map((name) => name.toLowerCase())).size !== packages.length)
    throw new Error('The resource pack repeats a package name.');
  return Object.freeze({
    id,
    title: label(value.title, 100),
    description: label(value.description, 1000),
    base,
    target,
    packages: Object.freeze(packages),
  });
}
function checkedFile(value: unknown, bytes: Buffer, limit: number) {
  const item = record(value, ['bytes', 'sha256']);
  if (
    !Number.isSafeInteger(item.bytes) ||
    (item.bytes as number) < 1 ||
    (item.bytes as number) > limit ||
    typeof item.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.sha256) ||
    bytes.length !== item.bytes ||
    hash(bytes) !== item.sha256
  )
    throw new Error('A resource pack file failed its signed size or hash check.');
}
function required(files: Map<string, Buffer>, name: string) {
  const data = files.get(name);
  if (!data) throw new Error(`The resource pack is missing ${name}.`);
  return data;
}
function textFile(bytes: Buffer) {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!value.trim() || value.includes('\0'))
    throw new Error('Pack notices and checks must contain UTF-8 text.');
  return value;
}
const zip = (files: Map<string, Buffer>) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        [...files]
          .sort(([a], [b]) => compare(a, b))
          // ZIP encodes local calendar fields, not an instant. A local fixed
          // date yields identical bytes on publisher and client time zones.
          .map(([name, data]) => [name, [data, { mtime: new Date(2024, 0, 1) }]]),
      ),
      { level: 6 },
    ),
  );

export class ResourcePackVerifier {
  private trust: CatalogVerifier;
  constructor(keys: Readonly<Record<string, string>>) {
    this.trust = new CatalogVerifier(keys, []);
  }
  read(input: Uint8Array, expected?: CatalogPack): ResourcePack {
    if (input.length > MAX_PACK_BYTES) throw new Error('The resource pack exceeds 128 MiB.');
    const archive = Buffer.from(input);
    if (expected) {
      requireVerifiedPack(expected);
      if (archive.length !== expected.artifact.bytes || hash(archive) !== expected.artifact.sha256)
        throw new Error('The resource pack does not match the signed catalog download.');
    }
    const files = readSafeZip(archive, {
      compressed: MAX_PACK_BYTES,
      expanded: MAX_PACK_BYTES,
      entries: MAX_RESOURCES + 3,
      entryBytes: (name) =>
        name === 'metadata.json'
          ? 2 * 1024 * 1024
          : name === 'NOTICES.txt'
            ? NOTICE_LIMIT
            : name === 'probe.tex'
              ? PROBE_LIMIT
              : RESOURCE_LIMIT,
    });
    const { keyId, payload } = this.trust.authenticate(
      required(files, 'metadata.json'),
      PACK_SIGNATURE_CONTEXT,
    );
    const value = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)), [
      'schemaVersion',
      'id',
      'title',
      'description',
      'base',
      'target',
      'packages',
      'files',
      'notices',
      'probe',
    ]);
    if (value.schemaVersion !== 1) throw new Error('The resource pack version is unsupported.');
    const info = description(value);
    if (
      expected &&
      (info.id !== expected.id ||
        JSON.stringify(info.base) !== JSON.stringify(expected.base) ||
        JSON.stringify(info.target) !== JSON.stringify(expected.target) ||
        JSON.stringify(info.packages) !== JSON.stringify(expected.packages) ||
        info.title !== expected.title ||
        info.description !== expected.description)
    )
      throw new Error('The archive metadata does not match the catalog entry.');
    if (!value.files || typeof value.files !== 'object' || Array.isArray(value.files))
      throw new Error('The resource inventory is invalid.');
    const entries = Object.entries(value.files);
    if (!entries.length || entries.length > MAX_RESOURCES || files.size !== entries.length + 3)
      throw new Error('The resource pack contains missing or unexpected files.');
    const resources = new Map<string, Buffer>(),
      seen = new Set<string>();
    for (const [name, item] of entries) {
      resourceName(name);
      if (seen.has(name.toLowerCase())) throw new Error('Resource names collide.');
      seen.add(name.toLowerCase());
      const data = required(files, `resources/${name}`);
      checkedFile(item, data, RESOURCE_LIMIT);
      resources.set(name, Buffer.from(data));
    }
    for (const name of info.packages)
      if (!resources.has(name))
        throw new Error('A named package is missing from the resource inventory.');
    const notices = required(files, 'NOTICES.txt'),
      probe = required(files, 'probe.tex');
    checkedFile(value.notices, notices, NOTICE_LIMIT);
    checkedFile(value.probe, probe, PROBE_LIMIT);
    textFile(notices);
    textFile(probe);
    const pack = Object.freeze({
      ...info,
      keyId,
      archiveSha256: hash(archive),
      archiveBytes: archive.length,
    });
    contents.set(pack, {
      archive,
      resources,
      notices: Buffer.from(notices),
      probe: Buffer.from(probe),
    });
    return pack;
  }
}

export function resourcePackBytes(pack: ResourcePack) {
  const data = contents.get(pack);
  if (!data) throw new Error('Choose an authenticated resource pack.');
  return Buffer.from(data.archive);
}

export function requireResourcePack(pack: ResourcePack) {
  if (!contents.has(pack)) throw new Error('Choose an authenticated resource pack.');
}

export function resourcePackNotices(pack: ResourcePack) {
  requireResourcePack(pack);
  return contents.get(pack)!.notices.toString('utf8');
}

async function assemble(
  baseRoot: string,
  info: PackDescription,
  resources: Map<string, Buffer>,
  notices: Buffer,
  probe: Buffer,
): Promise<PackAssembly> {
  const { manifest: baseManifest, pin: basePin } = await verifyRuntime(baseRoot, info.base);
  const original = await runtimeFile(baseRoot, 'bundle.zip', MAX_PACK_BYTES);
  if (hash(original) !== baseManifest.files['bundle.zip'])
    throw new Error('The base bundle changed while preparing the pack.');
  const bundle = readSafeZip(original, {
    compressed: MAX_PACK_BYTES,
    expanded: 256 * 1024 * 1024,
    entries: 20_000,
    entryBytes: () => RESOURCE_LIMIT,
  });
  if (!bundle.has('SHA256SUM') || [...bundle.keys()].some((name) => name.includes('/')))
    throw new Error('The base compiler does not use the supported flat resource bundle.');
  bundle.delete('SHA256SUM');
  const spellings = new Map([...bundle.keys()].map((name) => [name.toLowerCase(), name]));
  for (const [name, data] of resources) {
    const previous = spellings.get(name.toLowerCase());
    if (previous && previous !== name)
      throw new Error('A pack resource changes the case of an existing filename.');
    spellings.set(name.toLowerCase(), name);
    bundle.set(name, data);
  }
  if (
    bundle.size > 19_999 ||
    [...bundle.values()].reduce((sum, data) => sum + data.length, 0) > 256 * 1024 * 1024
  )
    throw new Error('The assembled resource bundle exceeds its bounds.');
  const inventory = Object.fromEntries(
    [...bundle].sort(([a], [b]) => compare(a, b)).map(([name, data]) => [name, hash(data)]),
  );
  bundle.set('SHA256SUM', Buffer.from(hash(JSON.stringify(inventory))));
  const bundled = zip(bundle);
  if (bundled.length > MAX_PACK_BYTES)
    throw new Error('The assembled resource bundle exceeds 128 MiB.');
  let baseNotices = Buffer.alloc(0);
  try {
    baseNotices = await runtimeFile(baseRoot, 'THIRD_PARTY_NOTICES.md', NOTICE_LIMIT);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const combined = Buffer.concat([
    baseNotices,
    Buffer.from(`\n\n## Resource pack: ${info.id}\n\n`),
    notices,
  ]);
  if (combined.length > NOTICE_LIMIT) throw new Error('The combined notices exceed 4 MiB.');
  const lock = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        compilerVersion: basePin.version,
        baseRuntime: basePin.id,
        pack: info.id,
        files: inventory,
      },
      null,
      2,
    ) + '\n',
  );
  const overrides = new Map<string, Buffer>([
    ['bundle.zip', bundled],
    ['bundle.lock.json', lock],
    ['THIRD_PARTY_NOTICES.md', combined],
    ['pack-check.tex', probe],
  ]);
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    version: baseManifest.version,
    bundle: info.target.bundle,
    platform: baseManifest.platform,
    ...(baseManifest.biberVersion ? { biberVersion: baseManifest.biberVersion } : {}),
    files: {
      ...baseManifest.files,
      ...Object.fromEntries([...overrides].map(([name, data]) => [name, hash(data)])),
    },
  };
  const target = runtimePin(manifest);
  overrides.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  return { manifest, pin: target, overrides };
}

export async function assembleResourcePack(pack: ResourcePack, baseRoot: string) {
  const data = contents.get(pack);
  if (!data) throw new Error('Choose an authenticated resource pack.');
  const result = await assemble(baseRoot, pack, data.resources, data.notices, data.probe);
  if (JSON.stringify(result.pin) !== JSON.stringify(pack.target))
    throw new Error('The assembled compiler does not match the signed resource-pack identity.');
  // Return independent buffers so callers cannot mutate the authenticated input.
  result.overrides = new Map(
    [...result.overrides].map(([name, bytes]) => [name, Buffer.from(bytes)]),
  );
  return result;
}

export async function buildResourcePack(options: {
  baseRoot: string;
  id: string;
  title: string;
  description: string;
  bundle: string;
  resources: ReadonlyMap<string, Uint8Array>;
  packages: string[];
  notices: string;
  probe: string;
  keyId: string;
  privateKey: KeyObject;
}) {
  if (
    options.privateKey.type !== 'private' ||
    options.privateKey.asymmetricKeyType !== 'ed25519' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.keyId)
  )
    throw new Error('The publisher requires an Ed25519 private key and valid key ID.');
  const { pin: base } = await verifyRuntime(options.baseRoot);
  const info = description({
    ...options,
    base,
    target: { ...base, bundle: options.bundle, id: '0'.repeat(64) },
  });
  const resources = new Map(
    [...options.resources].map(([name, data]) => [resourceName(name), Buffer.from(data)]),
  );
  const notices = Buffer.from(options.notices),
    probe = Buffer.from(options.probe);
  if (
    !resources.size ||
    resources.size > MAX_RESOURCES ||
    new Set([...resources.keys()].map((name) => name.toLowerCase())).size !== resources.size ||
    [...resources.values()].some((data) => !data.length || data.length > RESOURCE_LIMIT) ||
    notices.length > NOTICE_LIMIT ||
    probe.length > PROBE_LIMIT ||
    [...resources.values()].reduce(
      (sum, data) => sum + data.length,
      notices.length + probe.length,
    ) >
      MAX_PACK_BYTES - 2 * 1024 * 1024
  )
    throw new Error('The publisher resource files exceed the pack bounds.');
  for (const name of info.packages)
    if (!resources.has(name)) throw new Error('A named package is missing.');
  textFile(notices);
  textFile(probe);
  const assembly = await assemble(options.baseRoot, info, resources, notices, probe);
  const entry = (bytes: Buffer): InventoryEntry => ({ bytes: bytes.length, sha256: hash(bytes) });
  const metadata = {
    schemaVersion: 1,
    ...info,
    target: assembly.pin,
    files: Object.fromEntries(
      [...resources].sort(([a], [b]) => compare(a, b)).map(([name, data]) => [name, entry(data)]),
    ),
    notices: entry(notices),
    probe: entry(probe),
  };
  const payload = Buffer.from(JSON.stringify(metadata));
  const envelope = Buffer.from(
    JSON.stringify({
      keyId: options.keyId,
      payload: payload.toString('base64'),
      signature: sign(
        null,
        Buffer.concat([Buffer.from(PACK_SIGNATURE_CONTEXT), payload]),
        options.privateKey,
      ).toString('base64'),
    }),
  );
  const files = new Map([
    ['metadata.json', envelope],
    ['NOTICES.txt', notices],
    ['probe.tex', probe],
    ...[...resources].map(([name, data]) => [`resources/${name}`, data] as const),
  ]);
  const archive = zip(files);
  if (archive.length > MAX_PACK_BYTES) throw new Error('The resource pack exceeds 128 MiB.');
  return { archive, description: metadata, target: assembly.pin };
}

export class ResourcePackStore {
  constructor(
    readonly root: string,
    private verifier: ResourcePackVerifier,
  ) {}
  async retain(input: Uint8Array, expected?: CatalogPack) {
    const pack = this.verifier.read(input, expected);
    await savePackFile(this.root, `${pack.target.id}.foliopack`, resourcePackBytes(pack));
    return pack;
  }
  async get(value: RuntimePin) {
    const selected = pin(value),
      data = await packFile(this.root, `${selected.id}.foliopack`, MAX_PACK_BYTES);
    if (!data) return null;
    const pack = this.verifier.read(data);
    if (JSON.stringify(pack.target) !== JSON.stringify(selected))
      throw new Error('The retained resource pack has a different compiler identity.');
    return pack;
  }

  async list() {
    await packDirectory(this.root);
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    if (entries.length > 128)
      throw new Error('Too many retained pack files. Review the pack storage folder.');
    const packs: Omit<ResourcePack, never>[] = [];
    const warnings: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.foliopack$/.test(entry.name)) {
        warnings.push('An unexpected retained pack file was ignored.');
        continue;
      }
      try {
        const data = await packFile(this.root, entry.name, MAX_PACK_BYTES);
        if (!data) continue;
        const pack = this.verifier.read(data);
        if (`${pack.target.id}.foliopack` !== entry.name) throw new Error('Identity mismatch.');
        // Metadata only; do not hold every archive/resource buffer in memory.
        packs.push({ ...pack });
      } catch {
        warnings.push(
          `A retained pack (${entry.name.slice(0, 12)}) could not be verified. Reimport its signed file or download it again.`,
        );
      }
    }
    return { packs, warnings };
  }
}
