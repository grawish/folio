import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import {
  UpdateVerifier,
  UPDATE_SIGNATURE_CONTEXT,
  updateChannel,
  updateVersion,
  type UpdateTrust,
} from '../electron/core/update-manifest';
import { archiveDigest } from './verify-mac-archives';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [releaseArg, planArg, keyArg, outputArg] = process.argv.slice(2);
if (!releaseArg || !planArg || !keyArg || !outputArg || process.argv.length !== 6)
  throw new Error(
    'Usage: node --import tsx scripts/sign-app-update.ts RELEASE_DIR PLAN_JSON PRIVATE_KEY_PEM NEW_OUTPUT_JSON',
  );
const releaseDirectory = path.resolve(releaseArg),
  output = path.resolve(outputArg);
const trust: UpdateTrust & { expectedTeamId: string | null } = JSON.parse(
  await fs.readFile(path.join(root, 'resources/app-update-publisher.json'), 'utf8'),
);
if (
  !trust.expectedTeamId ||
  !/^[A-Z0-9]{10}$/.test(trust.expectedTeamId) ||
  !Object.keys(trust.keys).length
)
  throw new Error(
    'Enroll the app-update public key and expected Apple Team ID before publishing an update.',
  );
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Sign app releases on an Apple silicon Mac.');
const plan = JSON.parse(await fs.readFile(planArg, 'utf8'));
const channel = updateChannel(plan.channel);
const now = Date.now();
const keyFile = await fs.open(
  keyArg,
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
);
let privateKey;
try {
  const stat = await keyFile.stat();
  if (!stat.isFile() || stat.size > 16384 || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
    throw new Error('Use a private, regular app-update signing key file with permissions 0600.');
  privateKey = createPrivateKey(await keyFile.readFile());
} finally {
  await keyFile.close();
}
if (privateKey.asymmetricKeyType !== 'ed25519')
  throw new Error('Use a separate Ed25519 app-update key.');
const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
const keyId = Object.entries(trust.keys).find(
  ([id, pem]) =>
    !trust.retiredKeys?.includes(id) &&
    createPublicKey(pem).export({ format: 'der', type: 'spki' }).equals(publicDer),
)?.[0];
if (!keyId)
  throw new Error('The signing key does not match an active bundled app-update public key.');
const verifier = new UpdateVerifier(trust);
let previousSequence = trust.minimumSequence[channel] - 1;
try {
  const previousBytes = await fs.readFile(path.join(root, `resources/updates/${channel}.json`));
  // Authenticate the old publication at its issue time only to establish the
  // publisher sequence floor. Clients always require present-day freshness.
  const oldPayload = JSON.parse(
    Buffer.from(JSON.parse(previousBytes.toString()).payload, 'base64').toString(),
  );
  previousSequence = verifier.verify(
    previousBytes,
    channel,
    Date.parse(oldPayload.issuedAt),
  ).sequence;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (!Number.isSafeInteger(plan.sequence) || plan.sequence <= previousSequence)
  throw new Error('Use a sequence higher than the currently published channel.');
let release = null;
if (plan.version !== null) {
  const version = updateVersion(plan.version);
  // Re-run real production gates now. Never sign from a caller-supplied boolean
  // or a report left by a previous artifact. This includes both final archives,
  // native qualification, Developer ID, notarization and Apple policy checks.
  await execute(
    process.execPath,
    [path.join(root, 'scripts/verify-mac-package.mjs'), releaseDirectory, '--distribution'],
    {
      cwd: root,
      timeout: 15 * 60_000,
      maxBuffer: 8 * 1024 ** 2,
      env: { ...process.env, FOLIO_APPLE_TEAM_ID: trust.expectedTeamId },
    },
  );
  const report = JSON.parse(
    await fs.readFile(path.join(releaseDirectory, 'verification.json'), 'utf8'),
  );
  if (
    report.passed !== true ||
    report.distributionVerified !== true ||
    report.nativeTestsPassed !== true
  )
    throw new Error('The final release did not pass production verification.');
  const appPackage = JSON.parse(
    extractFile(
      path.join(releaseDirectory, 'mac-arm64/Folio.app/Contents/Resources/app.asar'),
      'package.json',
    ).toString(),
  );
  if (appPackage.version !== version)
    throw new Error('The update version differs from the actual packaged app.');
  const name = `Folio-${version}-mac-arm64.zip`,
    zip = path.join(releaseDirectory, name);
  const before = await archiveDigest(zip);
  if (before.sha256 !== report.archives.zip.sha256 || before.bytes !== report.archives.zip.bytes)
    throw new Error('The final ZIP changed after production verification.');
  const handle = await fs.open(
    zip,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const hash = createHash('sha512');
  try {
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
  } finally {
    await handle.close();
  }
  const after = await archiveDigest(zip);
  if (before.sha256 !== after.sha256 || before.bytes !== after.bytes)
    throw new Error('The final ZIP changed while creating update metadata.');
  release = {
    version,
    notes: plan.notes,
    minimumSystemVersion: plan.minimumSystemVersion,
    // Taken from the freshly verified physical app, never from the release plan.
    unpackedBytes: report.appBytes,
    rollout: plan.rollout,
    dataEpoch: plan.dataEpoch,
    zip: {
      url: `https://github.com/grawish/folio/releases/download/v${version}/${name}`,
      bytes: before.bytes,
      sha512: hash.digest('base64'),
    },
    releasePage: `https://github.com/grawish/folio/releases/tag/v${version}`,
  };
}
const payload = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    applicationId: 'app.folio.resume',
    platform: 'darwin-arm64',
    channel,
    sequence: plan.sequence,
    issuedAt: new Date(now).toISOString(),
    expiresAt: plan.expiresAt,
    release,
  }),
);
const envelope = Buffer.from(
  JSON.stringify(
    {
      keyId,
      payload: payload.toString('base64'),
      signature: sign(
        null,
        Buffer.concat([Buffer.from(UPDATE_SIGNATURE_CONTEXT), payload]),
        privateKey,
      ).toString('base64'),
    },
    null,
    2,
  ) + '\n',
);
const authenticated = verifier.verify(envelope, channel);
await fs.writeFile(output, envelope, { flag: 'wx', mode: 0o644 });
console.log(
  JSON.stringify({
    output,
    channel,
    sequence: authenticated.sequence,
    version: release?.version ?? null,
    digest: authenticated.digest,
    keyId,
  }),
);
