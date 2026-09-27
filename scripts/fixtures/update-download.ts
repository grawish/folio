// Standalone Electron fixture. Nothing in this file is bundled into Folio.
import { app, autoUpdater as nativeUpdater } from 'electron';
import { promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper';
import { MacAppInstaller } from '../../electron/core/update-installer';
import { UpdateRestartRequired } from '../../electron/core/update-staging';
import {
  UpdateVerifier,
  UPDATE_SIGNATURE_CONTEXT,
  type UpdateFeed,
} from '../../electron/core/update-manifest';

const root = path.dirname(__filename);
app.setPath('userData', path.join(root, 'profile'));
const checks: string[] = [];
const requests: string[] = [];
const nativeFeeds: Parameters<typeof nativeUpdater.setFeedURL>[0][] = [];
let nativeInstallationAttempts = 0;
let guardedStagingChecks = 0;
const startedAt = Date.now();
let stage = 'launch';
function checkpoint(next: string) {
  stage = next;
  writeFileSync(
    path.join(root, 'progress.json'),
    JSON.stringify({ stage, checks, requests, elapsedMs: Date.now() - startedAt }, null, 2),
  );
}
// Electron otherwise opens a modal error dialog, which can keep CI alive even
// after SIGTERM. Unexpected asynchronous errors must fail, never be swallowed.
function fatal(error: unknown) {
  console.error(error);
  writeFileSync(
    path.join(root, 'failure.json'),
    JSON.stringify({ stage, checks, requests, error: String(error) }, null, 2),
  );
  app.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
let installer: MacAppInstaller;
// These two handles point to private, pinned-library fields for test isolation
// and cleanup only. Download, digest, provider, progress, cache and proxy methods
// remain the real implementations. No method is replaced with a success stub.
let updater: any;
const originalSetFeedURL = nativeUpdater.setFeedURL.bind(nativeUpdater);
nativeUpdater.setFeedURL = (options) => {
  nativeFeeds.push(options);
  originalSetFeedURL(options);
};
// A library regression must fail this inert-ZIP test before native installation.
const rejectNativeInstallation = () => {
  nativeInstallationAttempts++;
  throw new Error('This download fixture must never request native installation.');
};
nativeUpdater.checkForUpdates = rejectNativeInstallation;
nativeUpdater.quitAndInstall = rejectNativeInstallation;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const trust = {
  keys: { fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() },
  minimumSequence: { stable: 1, beta: 1 },
  feeds: {
    stable: 'https://github.com/grawish/folio/fixture',
    beta: 'https://github.com/grawish/folio/fixture',
  },
};
const verifier = new UpdateVerifier(trust);
// An inert ZIP containing text and random data, never a runnable application.
const zip = Buffer.from(
  zipSync(
    {
      'README.txt': Buffer.from('Folio updater test. Not an application.'),
      'fixture.bin': randomBytes(256 * 1024),
    },
    { level: 0 },
  ),
);
function feed(version: string, bytes = zip.length): UpdateFeed {
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      applicationId: 'app.folio.resume',
      platform: 'darwin-arm64',
      channel: 'stable',
      sequence: 1,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      release: {
        version,
        notes: 'Inert test download; no app installation.',
        minimumSystemVersion: '20.0.0',
        rollout: 100,
        dataEpoch: { minimum: 1, maximum: 1 },
        zip: {
          url: `https://github.com/grawish/folio/releases/download/v${version}/Folio-${version}-mac-arm64.zip`,
          sha512: createHash('sha512').update(zip).digest('base64'),
          bytes,
        },
        releasePage: `https://github.com/grawish/folio/releases/tag/v${version}`,
      },
    }),
  );
  return verifier.verify(
    Buffer.from(
      JSON.stringify({
        keyId: 'fixture',
        payload: payload.toString('base64'),
        signature: sign(
          null,
          Buffer.concat([Buffer.from(UPDATE_SIGNATURE_CONTEXT), payload]),
          privateKey,
        ).toString('base64'),
      }),
    ),
    'stable',
  );
}
type Mode = 'good' | 'good-redirect' | 'bad-hash' | 'redirect' | 'slow' | 'offline' | 'oversized';
let mode: Mode = 'good';
const delayedTimers = new Set<ReturnType<typeof setTimeout>>();
const sha512 = (bytes: Uint8Array) => createHash('sha512').update(bytes).digest('base64');

void app.whenReady().then(async () => {
  try {
    assert.equal(process.platform, 'darwin');
    assert.equal(process.arch, 'arm64');
    installer = new MacAppInstaller();
    updater = (installer as any).updater;
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.allowDowngrade, false);
    // Force only this unpackaged test process to check; use an owned cache, not
    // the user's real Library/Caches directory. Production has no such override.
    const cache = path.join(root, 'cache');
    updater.forceDevUpdateConfig = true;
    updater.downloadedUpdateHelper = new DownloadedUpdateHelper(cache);
    (installer as any).cacheRoot = path.join(cache, 'pending');
    const partition = updater.netSession;
    await partition.cookies.set({
      url: 'https://github.com',
      name: 'folio-fixture-cookie',
      value: 'must-not-be-sent',
      secure: true,
    });
    await partition.protocol.handle('https', async (request: Request) => {
      requests.push(request.url);
      const host = new URL(request.url).hostname;
      const accepted = ['github.com', 'release-assets.githubusercontent.com'].includes(host);
      assert.ok(accepted, 'Unapproved redirect must be blocked before the protocol handler.');
      assert.equal(request.headers.get('cookie'), null);
      assert.equal(request.headers.get('authorization'), null);
      if (mode === 'redirect')
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://unapproved.invalid/fixture.zip' },
        });
      if (mode === 'good-redirect' && host === 'github.com')
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://release-assets.githubusercontent.com/fixture.zip' },
        });
      if (mode === 'offline') return Response.error();
      const body = mode === 'bad-hash' ? Buffer.from(zip).fill(1, 50, 90) : zip;
      if (mode !== 'slow' && mode !== 'oversized')
        return new Response(body, {
          headers: { 'Content-Length': String(body.length), 'Content-Type': 'application/zip' },
        });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.subarray(0, 16384));
          const timer = setTimeout(
            () => {
              delayedTimers.delete(timer);
              try {
                controller.enqueue(
                  mode === 'oversized' ? Buffer.alloc(zip.length * 3) : body.subarray(16384),
                );
                controller.close();
              } catch {}
            },
            mode === 'slow' ? 10000 : 1,
          );
          delayedTimers.add(timer);
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/zip' } });
    });
    const first = feed('0.2.0');
    const progress: number[] = [];
    checkpoint('download and loopback proxy');
    await installer.download(first, new AbortController().signal, (received) =>
      progress.push(received),
    );
    await installer.verify(first);
    assert.equal(progress.at(-1), zip.length);
    assert.equal(nativeFeeds.length, 1);
    const nativeFeed = nativeFeeds[0];
    assert.match(nativeFeed.url, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
    assert.equal((await fetch(nativeFeed.url)).status, 401);
    const response = await fetch(nativeFeed.url, {
      headers: nativeFeed.headers as Record<string, string>,
    });
    assert.equal(response.status, 200);
    const location = (await response.json()).url;
    assert.equal(
      sha512(new Uint8Array(await (await fetch(location)).arrayBuffer())),
      first.release!.zip.sha512,
    );
    checks.push(
      'Real MacUpdater bounded HTTPS-protocol transfer, SHA-512, exact cache bytes and authenticated loopback ZIP proxy pass.',
    );

    const count = requests.length;
    checkpoint('offline reuse and damaged cache retry');
    mode = 'offline';
    await installer.download(first, new AbortController().signal, () => {});
    assert.equal(requests.length, count, 'Exact valid cache avoids another network download.');
    const cached = path.join(cache, 'pending', 'Folio-0.2.0-mac-arm64.zip');
    const changed = Buffer.from(zip);
    changed[60] ^= 1;
    await fs.writeFile(cached, changed);
    await assert.rejects(installer.verify(first), /checksum/);
    await assert.rejects(fs.stat(cached), { code: 'ENOENT' });
    mode = 'good';
    await installer.download(first, new AbortController().signal, () => {});
    assert.equal(sha512(await fs.readFile(cached)), first.release!.zip.sha512);
    checks.push(
      'Valid cached download is reusable offline; same-size cache tampering is rejected and a fresh retry succeeds.',
    );

    mode = 'bad-hash';
    checkpoint('wrong checksum');
    // Different test versions intentionally reuse one inert ZIP. Remove the
    // previous fixture cache so these cases exercise a new network transfer.
    await updater.downloadedUpdateHelper.clear();
    const beforeBad = nativeFeeds.length;
    await assert.rejects(
      installer.download(feed('0.3.0'), new AbortController().signal, () => {}),
      /checksum|sha512|mismatch/i,
    );
    assert.equal(nativeFeeds.length, beforeBad, 'Failed checksum must not set a native feed.');
    checks.push('Actual downloaded checksum mismatch is rejected before native staging.');

    mode = 'redirect';
    checkpoint('unapproved redirect');
    await updater.downloadedUpdateHelper.clear();
    await assert.rejects(installer.download(feed('0.4.0'), new AbortController().signal, () => {}));
    assert.ok(requests.every((url) => new URL(url).hostname === 'github.com'));
    checks.push('Actual Electron request policy blocks an unapproved HTTPS redirect.');

    mode = 'good-redirect';
    checkpoint('approved redirect without credentials');
    await updater.downloadedUpdateHelper.clear();
    await installer.download(feed('0.4.1'), new AbortController().signal, () => {});
    assert.ok(requests.includes('https://release-assets.githubusercontent.com/fixture.zip'));
    checks.push(
      'Approved GitHub asset redirect succeeds without session cookies or authorization.',
    );

    mode = 'offline';
    checkpoint('network failure');
    await updater.downloadedUpdateHelper.clear();
    await assert.rejects(installer.download(feed('0.4.2'), new AbortController().signal, () => {}));
    checks.push('An actual Electron request failure rejects without staging an update.');

    mode = 'slow';
    checkpoint('cancel and retry');
    await updater.downloadedUpdateHelper.clear();
    const controller = new AbortController();
    let receivedBytes!: () => void;
    const firstBytes = new Promise<void>((resolve) => {
      receivedBytes = resolve;
    });
    const cancelled = installer.download(feed('0.5.0'), controller.signal, receivedBytes);
    await firstBytes;
    controller.abort();
    await assert.rejects(cancelled);
    mode = 'good';
    await installer.download(feed('0.5.0'), new AbortController().signal, () => {});
    checks.push(
      'Actual transfer cancellation settles, keeps the app running, and permits a verified retry.',
    );

    mode = 'oversized';
    checkpoint('oversized stream');
    await updater.downloadedUpdateHelper.clear();
    const beforeOversized = nativeFeeds.length;
    await assert.rejects(
      installer.download(feed('0.6.0', 20000), new AbortController().signal, () => {}),
    );
    assert.equal(nativeFeeds.length, beforeOversized);
    checks.push('An oversized chunked response cannot become a verified native update.');

    assert.equal(nativeInstallationAttempts, 0);
    checkpoint('guarded native staging failure and late event');
    mode = 'good';
    const staged = feed('0.7.0');
    await installer.download(staged, new AbortController().signal, () => {});
    // Intercept only this fixture's native entry point. Never send the inert
    // ZIP to Squirrel. The actual adapter, staging state and event emitter run.
    nativeUpdater.checkForUpdates = () => {
      guardedStagingChecks++;
      throw new Error('Controlled native staging rejection');
    };
    await assert.rejects(installer.install(), UpdateRestartRequired);
    nativeUpdater.emit('update-downloaded');
    nativeUpdater.emit('error', new Error('Controlled late native error'));
    const beforeRetry = { requests: requests.length, feeds: nativeFeeds.length };
    await assert.rejects(installer.install(), UpdateRestartRequired);
    await assert.rejects(
      installer.download(feed('0.8.0'), new AbortController().signal, () => {}),
      UpdateRestartRequired,
    );
    assert.deepEqual({ requests: requests.length, feeds: nativeFeeds.length }, beforeRetry);
    assert.equal(guardedStagingChecks, 1);
    checks.push(
      'Guarded native failure releases the adapter, ignores late events and blocks a second download or restart in this process.',
    );

    checkpoint('complete');
    assert.equal(nativeInstallationAttempts, 0);
    await fs.writeFile(
      path.join(root, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          checks,
          requests,
          elapsedMs: Date.now() - startedAt,
          electron: process.versions.electron,
          updater: '6.8.10',
          sha512: first.release!.zip.sha512,
          zipBytes: zip.length,
          transport:
            'Electron HTTPS protocol handler supplies deterministic responses; real MacUpdater, bounded net.request transfer, cache and proxy code.',
          syntheticTrust: true,
          isolatedCache: true,
          nativeInstallationAttempted: nativeInstallationAttempts > 0,
          guardedStagingChecks,
          nativeStagingSimulated: true,
          scope:
            'No runnable app ZIP, Developer ID, notarization, public network, or native replacement is claimed.',
        },
        null,
        2,
      ),
    );
    console.log(`PASS: actual Mac updater download/cache/proxy controls. Evidence: ${root}`);
  } catch (error) {
    console.error(error);
    await fs
      .writeFile(
        path.join(root, 'failure.json'),
        JSON.stringify({ stage, checks, requests, error: String(error) }, null, 2),
      )
      .catch(() => {});
    process.exitCode = 1;
  } finally {
    for (const timer of delayedTimers) clearTimeout(timer);
    updater?.closeServerIfExists();
    app.exit(process.exitCode ? 1 : 0);
  }
});
