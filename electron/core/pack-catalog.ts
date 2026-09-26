import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { validateRuntimePin, type RuntimePin } from '../../src/shared/runtime';
import { packFile, savePackFile } from './pack-io';
import { resourceName } from './pack-resource-name';

export const MAX_CATALOG_BYTES = 1024 * 1024;
export const MAX_PACK_BYTES = 128 * 1024 * 1024;
export const CATALOG_SIGNATURE_CONTEXT = 'Folio resource pack catalog v1\n';
export type PackArtifact = Readonly<{ url: string; sha256: string; bytes: number }>;
export type CatalogPack = Readonly<{
  id: string;
  title: string;
  description: string;
  base: Readonly<RuntimePin>;
  target: Readonly<RuntimePin>;
  packages: readonly string[];
  artifact: PackArtifact;
}>;
export type VerifiedCatalog = Readonly<{
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  digest: string;
  keyId: string;
  packs: readonly CatalogPack[];
}>;
const verifiedPacks = new WeakMap<object, number>();
const knownPacks = new WeakSet<object>();

export function requireKnownPack(pack: CatalogPack) {
  if (!pack || !knownPacks.has(pack))
    throw new Error('Choose a pack from an authenticated catalog before removing its download.');
}

export function requireVerifiedPack(pack: CatalogPack, now = Date.now()) {
  if (!pack || !verifiedPacks.has(pack))
    throw new Error('Choose a pack from a verified catalog before downloading.');
  if (verifiedPacks.get(pack)! <= now)
    throw new Error('This pack catalog has expired. Check for a newer catalog in Settings.');
}

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error('The pack catalog has an unsupported structure.');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error('The pack catalog contains invalid text.');
  return value;
}
function base64(value: unknown, maximum: number) {
  if (
    typeof value !== 'string' ||
    value.length > maximum * 2 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error('The pack signature encoding is invalid.');
  const result = Buffer.from(value, 'base64');
  if (!result.length || result.length > maximum || result.toString('base64') !== value)
    throw new Error('The pack signature encoding is invalid.');
  return result;
}
function timestamp(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('The catalog dates are invalid.');
  return value;
}
function completePin(value: unknown) {
  const pin = validateRuntimePin(value);
  if (!pin?.id || pin.platform !== 'darwin-arm64')
    throw new Error('This resource pack requires an exact Apple silicon compiler identity.');
  const keys = [
    'engine',
    'version',
    'bundle',
    'id',
    'platform',
    ...(pin.biberVersion ? ['biberVersion'] : []),
  ];
  object(value, keys);
  return Object.freeze(pin);
}
export function packUrl(value: unknown, hosts: ReadonlySet<string>) {
  const url = new URL(text(value, 2048));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !hosts.has(url.hostname)
  )
    throw new Error('Pack downloads require HTTPS on an approved host.');
  return url.href;
}

export class CatalogVerifier {
  private readonly keys = new Map<string, KeyObject>();
  private readonly retired: ReadonlySet<string>;
  private readonly hosts: ReadonlySet<string>;
  constructor(
    keys: Readonly<Record<string, string>>,
    hosts: readonly string[],
    private readonly minimumSequence = 1,
    retiredKeys: readonly string[] = [],
  ) {
    if (!Number.isSafeInteger(minimumSequence) || minimumSequence < 1)
      throw new Error('The bundled catalog version floor is invalid.');
    this.hosts = new Set(hosts);
    this.retired = new Set(retiredKeys);
    if (retiredKeys.some((id) => !Object.hasOwn(keys, id)))
      throw new Error('Retired catalog keys must retain their public verification key.');
    for (const [id, pem] of Object.entries(keys)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid catalog signing key ID.');
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('Catalog keys must use Ed25519.');
      this.keys.set(id, key);
    }
  }

  authenticate(input: Uint8Array, context: string, historical = false) {
    if (input.length > MAX_CATALOG_BYTES * 2) throw new Error('The signed catalog is too large.');
    const envelope = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)), [
      'keyId',
      'payload',
      'signature',
    ]);
    const keyId = text(envelope.keyId, 64),
      key = this.keys.get(keyId);
    if (!key) throw new Error('This catalog was not signed by a trusted Folio publisher.');
    if (!historical && this.retired.has(keyId))
      throw new Error('This publisher key has been retired. Get a current signed pack or catalog.');
    const payload = base64(envelope.payload, MAX_CATALOG_BYTES),
      signature = base64(envelope.signature, 64);
    if (
      signature.length !== 64 ||
      !verify(null, Buffer.concat([Buffer.from(context), payload]), key, signature)
    )
      throw new Error('The pack catalog signature is invalid.');
    return { keyId, payload };
  }

  verify(input: Uint8Array, now = Date.now(), historical = false): VerifiedCatalog {
    if (!Number.isFinite(now)) throw new Error('The catalog verification time is invalid.');
    const { keyId, payload } = this.authenticate(input, CATALOG_SIGNATURE_CONTEXT, historical);
    const catalog = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)), [
      'schemaVersion',
      'sequence',
      'issuedAt',
      'expiresAt',
      'packs',
    ]);
    if (
      catalog.schemaVersion !== 1 ||
      !Number.isSafeInteger(catalog.sequence) ||
      (catalog.sequence as number) < (historical ? 1 : this.minimumSequence)
    )
      throw new Error('The pack catalog version is unsupported.');
    const issuedAt = timestamp(catalog.issuedAt),
      expiresAt = timestamp(catalog.expiresAt);
    if (
      Date.parse(expiresAt) <= Date.parse(issuedAt) ||
      Date.parse(expiresAt) - Date.parse(issuedAt) > 90 * 86400_000 ||
      Date.parse(issuedAt) > now + 300_000
    )
      throw new Error('The catalog validity period is invalid.');
    if (!historical && Date.parse(expiresAt) <= now)
      throw new Error('This pack catalog has expired. Check for a newer catalog in Settings.');
    if (!Array.isArray(catalog.packs) || catalog.packs.length > 128)
      throw new Error('The pack catalog contains too many entries.');
    const ids = new Set<string>(),
      targets = new Set<string>();
    const packs = catalog.packs.map((value): CatalogPack => {
      const record = object(value, [
        'id',
        'title',
        'description',
        'base',
        'target',
        'packages',
        'artifact',
      ]);
      const id = text(record.id, 100);
      if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(id) || ids.has(id))
        throw new Error('Invalid or repeated pack ID.');
      ids.add(id);
      const base = completePin(record.base),
        target = completePin(record.target);
      if (
        base.id === target.id ||
        base.version !== target.version ||
        base.biberVersion !== target.biberVersion ||
        targets.has(target.id!)
      )
        throw new Error(
          'Resource packs must keep their base engine and have a unique target identity.',
        );
      targets.add(target.id!);
      if (
        !Array.isArray(record.packages) ||
        !record.packages.length ||
        record.packages.length > 128 ||
        new Set(record.packages.map((name) => resourceName(name).toLowerCase())).size !==
          record.packages.length
      )
        throw new Error('The pack resource names are invalid or repeated.');
      const artifact = object(record.artifact, ['url', 'sha256', 'bytes']);
      if (
        typeof artifact.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.bytes) ||
        (artifact.bytes as number) < 1 ||
        (artifact.bytes as number) > MAX_PACK_BYTES
      )
        throw new Error('The pack download hash or size is invalid.');
      const pack = Object.freeze({
        id,
        title: text(record.title, 100),
        description: text(record.description, 1000),
        base,
        target,
        packages: Object.freeze([...record.packages] as string[]),
        artifact: Object.freeze({
          url: packUrl(artifact.url, this.hosts),
          sha256: artifact.sha256,
          bytes: artifact.bytes as number,
        }),
      });
      // Expired cached metadata may establish a rollback floor, never a new
      // download capability. Only the fresh verification path brands entries.
      knownPacks.add(pack);
      if (!historical) verifiedPacks.set(pack, Date.parse(expiresAt));
      return pack;
    });
    return Object.freeze({
      sequence: catalog.sequence as number,
      issuedAt,
      expiresAt,
      keyId,
      digest: createHash('sha256').update(payload).digest('hex'),
      packs: Object.freeze(packs),
    });
  }
}

export class PackCatalogStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    private verifier: CatalogVerifier,
    private now = () => Date.now(),
  ) {}
  private serial<T>(action: () => Promise<T>) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  load(historical = false) {
    return this.serial(async () => {
      const bytes = await packFile(this.root, 'catalog.json', MAX_CATALOG_BYTES * 2);
      return bytes ? this.verifier.verify(bytes, this.now(), historical) : null;
    });
  }
  accept(input: Uint8Array) {
    // Copy at the call boundary: callers cannot mutate queued bytes after review.
    const bytes = Buffer.from(input);
    return this.serial(async () => {
      const catalog = this.verifier.verify(bytes, this.now());
      const previous = await packFile(this.root, 'catalog.json', MAX_CATALOG_BYTES * 2);
      if (previous) {
        const floor = this.verifier.verify(previous, this.now(), true);
        if (
          catalog.sequence < floor.sequence ||
          (catalog.sequence === floor.sequence && catalog.digest !== floor.digest)
        )
          throw new Error(
            'The catalog is older than the saved version or reuses its version with different contents.',
          );
      }
      await savePackFile(this.root, 'catalog.json', bytes);
      return catalog;
    });
  }
}
