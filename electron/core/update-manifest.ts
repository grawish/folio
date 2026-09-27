import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { gt, valid, prerelease, lt } from 'semver';
import type { UpdateChannel } from '../../src/shared/updates';

export const UPDATE_SIGNATURE_CONTEXT = 'Folio application update v1\n';
export const MAX_UPDATE_METADATA = 64 * 1024;
export const MAX_APP_UPDATE_BYTES = 2 * 1024 ** 3;
export type AppRelease = Readonly<{
  version: string;
  notes: string;
  minimumSystemVersion: string;
  rollout: number;
  dataEpoch: Readonly<{ minimum: number; maximum: number }>;
  zip: Readonly<{ url: string; sha512: string; bytes: number }>;
  releasePage: string;
}>;
export type UpdateFeed = Readonly<{
  channel: UpdateChannel;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  release: AppRelease | null;
  digest: string;
  keyId: string;
}>;
export type UpdateTrust = {
  keys: Readonly<Record<string, string>>;
  retiredKeys?: readonly string[];
  minimumSequence: Readonly<Record<UpdateChannel, number>>;
  feeds: Readonly<Record<UpdateChannel, string>>;
};
export type FeedCheckpoint = { sequence: number; digest: string };
const verified = new WeakSet<object>();

function object(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('The update information has an unsupported structure.');
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error('The update information contains an invalid number.');
  return value as number;
}
function text(value: unknown, maximum: number, multiline = false) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)
  )
    throw new Error('The update information contains invalid text.');
  return value;
}
function base64(value: unknown, maximum: number) {
  const encoded = text(value, Math.ceil(maximum / 3) * 4);
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== encoded)
    throw new Error('The update signature encoding is invalid.');
  return bytes;
}
function timestamp(value: unknown) {
  const result = text(value, 24);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result)
    throw new Error('The update dates are invalid.');
  return result;
}
export function updateVersion(value: unknown) {
  const version = text(value, 80);
  // No loose versions, build metadata, or URL-special characters. Each release
  // has one unambiguous immutable version and corresponding GitHub tag.
  if (valid(version) !== version || version.includes('+') || !/^[0-9A-Za-z.-]+$/.test(version))
    throw new Error('The app update version is invalid.');
  return version;
}
export function updateChannel(value: unknown): UpdateChannel {
  if (value !== 'stable' && value !== 'beta') throw new Error('Choose Stable or Beta updates.');
  return value;
}
function parseRelease(value: unknown, channel: UpdateChannel): AppRelease | null {
  if (value === null) return null;
  const record = object(value, [
    'version',
    'notes',
    'minimumSystemVersion',
    'rollout',
    'dataEpoch',
    'zip',
    'releasePage',
  ]);
  const version = updateVersion(record.version);
  const pre = prerelease(version);
  if (
    (channel === 'stable' && pre) ||
    (pre && (pre.length !== 2 || pre[0] !== 'beta' || typeof pre[1] !== 'number'))
  )
    throw new Error('This release does not belong in the selected update channel.');
  const system = text(record.minimumSystemVersion, 40);
  if (!/^\d+\.\d+\.\d+$/.test(system) || valid(system) !== system)
    throw new Error('The minimum Mac system version is invalid.');
  const epoch = object(record.dataEpoch, ['minimum', 'maximum']);
  const minimum = integer(epoch.minimum, 1, 10000),
    maximum = integer(epoch.maximum, minimum, 10000);
  const zip = object(record.zip, ['url', 'sha512', 'bytes']);
  const expectedBase = `https://github.com/grawish/folio/releases`;
  const expectedZip = `${expectedBase}/download/v${version}/Folio-${version}-mac-arm64.zip`;
  const releasePage = `${expectedBase}/tag/v${version}`;
  if (zip.url !== expectedZip || record.releasePage !== releasePage)
    throw new Error('The update must use this version’s official Folio release.');
  const hash = base64(zip.sha512, 64);
  if (hash.length !== 64) throw new Error('The update SHA-512 checksum is invalid.');
  return Object.freeze({
    version,
    notes: text(record.notes, 16000, true),
    minimumSystemVersion: system,
    rollout: integer(record.rollout, 0, 100),
    dataEpoch: Object.freeze({ minimum, maximum }),
    zip: Object.freeze({
      url: expectedZip,
      sha512: hash.toString('base64'),
      bytes: integer(zip.bytes, 1, MAX_APP_UPDATE_BYTES),
    }),
    releasePage,
  });
}

export class UpdateVerifier {
  private readonly keys = new Map<string, KeyObject>();
  private readonly retired: Set<string>;
  constructor(private readonly trust: UpdateTrust) {
    this.retired = new Set(trust.retiredKeys ?? []);
    for (const channel of ['stable', 'beta'] as const)
      integer(trust.minimumSequence[channel], 1, Number.MAX_SAFE_INTEGER);
    for (const [id, pem] of Object.entries(trust.keys)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
        throw new Error('Invalid update publisher key ID.');
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('Update signing requires Ed25519.');
      this.keys.set(id, key);
    }
    if ([...this.retired].some((id) => !this.keys.has(id)))
      throw new Error('Retired update keys must retain their public verification key.');
  }
  verify(input: Uint8Array, channel: UpdateChannel, now = Date.now()): UpdateFeed {
    updateChannel(channel);
    if (!Number.isFinite(now) || input.length > MAX_UPDATE_METADATA * 2)
      throw new Error('The signed update information is too large or its time is invalid.');
    const envelope = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)), [
      'keyId',
      'payload',
      'signature',
    ]);
    const keyId = text(envelope.keyId, 64),
      key = this.keys.get(keyId);
    if (!key || this.retired.has(keyId))
      throw new Error('This update was not signed by a current, trusted Folio publisher.');
    const payload = base64(envelope.payload, MAX_UPDATE_METADATA),
      signature = base64(envelope.signature, 64);
    if (
      signature.length !== 64 ||
      !verify(null, Buffer.concat([Buffer.from(UPDATE_SIGNATURE_CONTEXT), payload]), key, signature)
    )
      throw new Error('The app update signature is invalid.');
    const data = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)), [
      'schemaVersion',
      'applicationId',
      'platform',
      'channel',
      'sequence',
      'issuedAt',
      'expiresAt',
      'release',
    ]);
    if (
      data.schemaVersion !== 1 ||
      data.applicationId !== 'app.folio.resume' ||
      data.platform !== 'darwin-arm64' ||
      data.channel !== channel
    )
      throw new Error('This update information is for a different app, platform, or channel.');
    const issuedAt = timestamp(data.issuedAt),
      expiresAt = timestamp(data.expiresAt);
    if (
      Date.parse(issuedAt) > now + 300_000 ||
      Date.parse(expiresAt) <= now ||
      Date.parse(expiresAt) <= Date.parse(issuedAt) ||
      Date.parse(expiresAt) - Date.parse(issuedAt) > 45 * 86400_000
    )
      throw new Error(
        'This update information is expired or has invalid dates. Check for updates again.',
      );
    const feed = Object.freeze({
      channel,
      sequence: integer(
        data.sequence,
        this.trust.minimumSequence[channel],
        Number.MAX_SAFE_INTEGER,
      ),
      issuedAt,
      expiresAt,
      release: parseRelease(data.release, channel),
      digest: createHash('sha256').update(payload).digest('hex'),
      keyId,
    });
    verified.add(feed);
    return feed;
  }
}

export function requireVerifiedUpdate(feed: UpdateFeed, now = Date.now()) {
  if (!verified.has(feed)) throw new Error('Authenticate the update information first.');
  if (
    !Number.isFinite(now) ||
    Date.parse(feed.expiresAt) <= now ||
    Date.parse(feed.issuedAt) > now + 300_000
  )
    throw new Error(
      'This update information is expired or has invalid dates. Check for updates again.',
    );
}
export function advanceUpdateCheckpoint(
  feed: UpdateFeed,
  previous?: FeedCheckpoint,
): FeedCheckpoint {
  // Freshness is checked by the caller at its injected clock. Branding prevents
  // unverified renderer input from establishing a new sequence floor.
  if (!verified.has(feed)) throw new Error('Authenticate the update information first.');
  if (
    previous &&
    (feed.sequence < previous.sequence ||
      (feed.sequence === previous.sequence && feed.digest !== previous.digest))
  )
    throw new Error('The update server returned older or conflicting release information.');
  return { sequence: feed.sequence, digest: feed.digest };
}
export function selectAppUpdate(
  feed: UpdateFeed,
  installed: { version: string; system: string; dataEpoch: number; cohort: string },
  now = Date.now(),
) {
  requireVerifiedUpdate(feed, now);
  const release = feed.release;
  if (!release || !gt(release.version, updateVersion(installed.version))) return 'current' as const;
  if (
    valid(installed.system) !== installed.system ||
    !Number.isSafeInteger(installed.dataEpoch) ||
    installed.dataEpoch < release.dataEpoch.minimum ||
    installed.dataEpoch > release.dataEpoch.maximum ||
    lt(installed.system, release.minimumSystemVersion)
  )
    return 'incompatible' as const;
  if (!/^[0-9a-f]{64}$/.test(installed.cohort))
    throw new Error('The local update rollout ID is invalid.');
  // A stable local cohort across versions lets each small rollout reach the same
  // initial users. This ID is never sent to the publisher or download server.
  const fraction = createHash('sha256').update(installed.cohort).digest().readUInt32BE(0) / 2 ** 32;
  return fraction < release.rollout / 100 ? ('available' as const) : ('waiting' as const);
}
