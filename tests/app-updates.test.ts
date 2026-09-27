import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UpdateVerifier,
  UPDATE_SIGNATURE_CONTEXT,
  advanceUpdateCheckpoint,
  selectAppUpdate,
  requireVerifiedUpdate,
  MAX_UPDATE_METADATA,
  type UpdateFeed,
  type UpdateTrust,
} from '../electron/core/update-manifest';
import { fetchUpdateFeed } from '../electron/core/update-feed';
import { AppUpdates, type AppUpdateInstaller } from '../electron/core/update-service';
import { UpdateRestartRequired } from '../electron/core/update-staging';
import { signedUpdateProvider } from '../electron/core/update-provider';
import { verifyUpdateArchive, discardUpdateArchive } from '../electron/core/update-archive';
import { downloadAppUpdate as transferAppUpdate } from '../electron/core/update-download';
import { CancellationToken } from 'builder-util-runtime';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { UpdateFetch } from '../electron/core/update-feed';

const keys = generateKeyPairSync('ed25519');
const now = Date.parse('2026-09-27T08:00:00.000Z');
const trust: UpdateTrust = {
  keys: { publisher: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString() },
  feeds: {
    stable: 'https://raw.githubusercontent.com/grawish/folio/main/resources/updates/stable.json',
    beta: 'https://raw.githubusercontent.com/grawish/folio/main/resources/updates/beta.json',
  },
  minimumSequence: { stable: 1, beta: 1 },
};
const release = (version = '0.2.0') => ({
  version,
  notes: 'New resume tools.\nYour projects are kept.',
  rollout: 100,
  minimumSystemVersion: '24.0.0',
  dataEpoch: { minimum: 1, maximum: 1 },
  zip: {
    url: `https://github.com/grawish/folio/releases/download/v${version}/Folio-${version}-mac-arm64.zip`,
    sha512: createHash('sha512').update('zip fixture').digest('base64'),
    bytes: 11,
  },
  releasePage: `https://github.com/grawish/folio/releases/tag/v${version}`,
});
const payload = () => ({
  schemaVersion: 1,
  applicationId: 'app.folio.resume',
  platform: 'darwin-arm64',
  channel: 'stable',
  sequence: 5,
  issuedAt: new Date(now - 60_000).toISOString(),
  expiresAt: new Date(now + 86400_000).toISOString(),
  release: release() as ReturnType<typeof release> | null,
});
function envelope(value: unknown = payload(), context = UPDATE_SIGNATURE_CONTEXT) {
  const bytes = Buffer.from(JSON.stringify(value));
  return Buffer.from(
    JSON.stringify({
      keyId: 'publisher',
      payload: bytes.toString('base64'),
      signature: sign(null, Buffer.concat([Buffer.from(context), bytes]), keys.privateKey).toString(
        'base64',
      ),
    }),
  );
}
const verifier = new UpdateVerifier(trust);
const installed = {
  version: '0.1.0-preview.4',
  system: '24.6.0',
  dataEpoch: 1,
  cohort: 'a'.repeat(64),
};
async function temporary(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-updates-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const installer = () => {
  const calls: string[] = [];
  const api: AppUpdateInstaller = {
    async download(_feed, signal, progress) {
      signal.throwIfAborted();
      calls.push('download');
      progress(11, 11);
    },
    async verify() {
      calls.push('verify');
    },
    async install() {
      calls.push('install');
    },
  };
  return { calls, api };
};

test('app update signatures bind every field, key, context, app, platform and channel', () => {
  const good = envelope();
  const feed = verifier.verify(good, 'stable', now);
  assert.equal(feed.release?.version, '0.2.0');
  assert.equal(selectAppUpdate(feed, installed, now), 'available');
  assert.throws(() => requireVerifiedUpdate({ ...feed }, now), /Authenticate/);
  assert.throws(() => verifier.verify(good, 'beta', now), /different/);
  for (const change of [
    { applicationId: 'another.app' },
    { platform: 'darwin-x64' },
    { schemaVersion: 2 },
    { extra: true },
    { sequence: 0 },
    { sequence: 1.2 },
    { issuedAt: new Date(now + 600_000).toISOString() },
    { expiresAt: new Date(now).toISOString() },
    { expiresAt: new Date(now + 46 * 86400_000).toISOString() },
  ])
    assert.throws(() => verifier.verify(envelope({ ...payload(), ...change }), 'stable', now));
  const altered = JSON.parse(good.toString());
  altered.payload = Buffer.from(JSON.stringify({ ...payload(), sequence: 6 })).toString('base64');
  assert.throws(
    () => verifier.verify(Buffer.from(JSON.stringify(altered)), 'stable', now),
    /signature/,
  );
  assert.throws(
    () => verifier.verify(envelope(payload(), 'Folio resource pack catalog v1\n'), 'stable', now),
    /signature/,
  );
  assert.throws(
    () => new UpdateVerifier({ ...trust, keys: {} }).verify(good, 'stable', now),
    /trusted/,
  );
  assert.throws(
    () => new UpdateVerifier({ ...trust, retiredKeys: ['publisher'] }).verify(good, 'stable', now),
    /trusted/,
  );
  assert.throws(() =>
    new UpdateVerifier({ ...trust, minimumSequence: { stable: 6, beta: 1 } }).verify(
      good,
      'stable',
      now,
    ),
  );
  assert.throws(
    () => verifier.verify(Buffer.alloc(MAX_UPDATE_METADATA * 2 + 1), 'stable', now),
    /too large/,
  );
  assert.throws(() => requireVerifiedUpdate(feed, now + 86400_000), /expired/);
  assert.throws(() => requireVerifiedUpdate(feed, now - 86400_000), /invalid dates/);
});

test('release payload restricts exact archive, version, checksum, schema and notes', () => {
  for (const version of ['v0.2.0', '0.2.0+meta', '0.2.0-rc.1', '0.2.0-beta.1'])
    assert.throws(() =>
      verifier.verify(envelope({ ...payload(), release: release(version) }), 'stable', now),
    );
  for (const change of [
    { zip: { ...release().zip, url: 'https://evil.invalid/Folio.zip' } },
    { zip: { ...release().zip, url: release().zip.url.replace('arm64', 'x64') } },
    { zip: { ...release().zip, bytes: 2 * 1024 ** 3 + 1 } },
    { zip: { ...release().zip, sha512: 'abc' } },
    { releasePage: 'https://github.com/another/project' },
    { dataEpoch: { minimum: 3, maximum: 2 } },
    { minimumSystemVersion: '>=24' },
    { rollout: 100.1 },
    { notes: 'bad\u0000notes' },
  ])
    assert.throws(() =>
      verifier.verify(
        envelope({ ...payload(), release: { ...release(), ...change } }),
        'stable',
        now,
      ),
    );
  const beta = verifier.verify(
    envelope({ ...payload(), channel: 'beta', release: release('0.2.0-beta.1') }),
    'beta',
    now,
  );
  assert.equal(selectAppUpdate(beta, installed, now), 'available');
  assert.ok(Object.isFrozen(beta.release!.zip));
});

test('sequence checkpoint rejects rollback and equivocation, including signed withdrawals', () => {
  const feed = verifier.verify(envelope(), 'stable', now),
    checkpoint = advanceUpdateCheckpoint(feed);
  assert.deepEqual(advanceUpdateCheckpoint(feed, checkpoint), checkpoint);
  assert.throws(
    () =>
      advanceUpdateCheckpoint(
        verifier.verify(envelope({ ...payload(), sequence: 4 }), 'stable', now),
        checkpoint,
      ),
    /older/,
  );
  assert.throws(
    () =>
      advanceUpdateCheckpoint(
        verifier.verify(envelope({ ...payload(), release: null }), 'stable', now),
        checkpoint,
      ),
    /conflicting/,
  );
  const withdrawn = verifier.verify(
    envelope({ ...payload(), sequence: 6, release: null }),
    'stable',
    now,
  );
  assert.equal(advanceUpdateCheckpoint(withdrawn, checkpoint).sequence, 6);
  assert.equal(selectAppUpdate(withdrawn, installed, now), 'current');
});

test('rollouts are local and stable, and never offer downgrades or unreadable local data', () => {
  const feed = verifier.verify(envelope(), 'stable', now);
  assert.equal(selectAppUpdate(feed, { ...installed, version: '0.2.0' }, now), 'current');
  assert.equal(selectAppUpdate(feed, { ...installed, version: '0.3.0-beta.1' }, now), 'current');
  assert.equal(selectAppUpdate(feed, { ...installed, system: '23.9.0' }, now), 'incompatible');
  assert.equal(selectAppUpdate(feed, { ...installed, dataEpoch: 2 }, now), 'incompatible');
  const zero = verifier.verify(
    envelope({ ...payload(), release: { ...release(), rollout: 0 } }),
    'stable',
    now,
  );
  assert.equal(selectAppUpdate(zero, installed, now), 'waiting');
  const small = verifier.verify(
    envelope({ ...payload(), release: { ...release(), rollout: 10 } }),
    'stable',
    now,
  );
  const cohort = Array.from({ length: 1000 }, (_, index) =>
    createHash('sha256').update(String(index)).digest('hex'),
  );
  const chosen = cohort.map((id) => selectAppUpdate(small, { ...installed, cohort: id }, now));
  const renewed = verifier.verify(
    envelope({ ...payload(), sequence: 6, release: { ...release('0.3.0'), rollout: 10 } }),
    'stable',
    now,
  );
  assert.deepEqual(
    cohort.map((id) => selectAppUpdate(renewed, { ...installed, cohort: id }, now)),
    chosen,
  );
  assert.ok(chosen.filter((value) => value === 'available').length > 70);
  assert.ok(chosen.filter((value) => value === 'available').length < 130);
});

test('matching electron-updater provider receives only the authenticated snapshot', async () => {
  let clock = now;
  const feed = verifier.verify(envelope(), 'stable', now);
  const Provider = signedUpdateProvider(feed, () => clock);
  const provider = new Provider(
    {},
    {},
    { platform: 'darwin', isUseMultipleRangeRequest: false, executor: null as never },
  );
  const info = await provider.getLatestVersion();
  assert.equal(info.files[0].sha512, feed.release!.zip.sha512);
  assert.equal(provider.resolveFiles(info)[0].url.href, feed.release!.zip.url);
  assert.throws(() => provider.resolveFiles({ ...info }), /changed/);
  clock += 86400_000;
  assert.throws(() => provider.resolveFiles(info), /expired/);
  await assert.rejects(provider.getLatestVersion(), /expired/);
});

test('metadata fetch bounds actual bytes and rejects unsafe redirects without leaking a cohort', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const bytes = await fetchUpdateFeed(
    trust.feeds.stable,
    new AbortController().signal,
    async (url, init) => {
      requests.push({ url, init });
      return new Response(envelope());
    },
  );
  assert.equal(verifier.verify(bytes, 'stable', now).sequence, 5);
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.redirect, 'manual');
  assert.ok(!JSON.stringify(requests).includes(installed.cohort));
  for (const location of [
    'http://github.com/file',
    'https://evil.invalid/file',
    'https://secret@github.com/file',
    'https://github.com:444/file',
  ]) {
    let count = 0;
    await assert.rejects(
      fetchUpdateFeed(trust.feeds.stable, new AbortController().signal, async () => {
        count++;
        return new Response(null, { status: 302, headers: { location } });
      }),
      /approved/,
    );
    assert.equal(count, 1);
  }
  await assert.rejects(
    fetchUpdateFeed(
      trust.feeds.stable,
      new AbortController().signal,
      async () => new Response(Buffer.alloc(MAX_UPDATE_METADATA * 2 + 1)),
    ),
    /too large/,
  );
  await assert.rejects(
    fetchUpdateFeed(
      trust.feeds.stable,
      new AbortController().signal,
      async () => new Response('missing', { status: 404 }),
    ),
    /404/,
  );
  await assert.rejects(
    fetchUpdateFeed(trust.feeds.stable, AbortSignal.abort(), async () => new Response(envelope())),
  );
});

test('update service persists channel and anti-rollback floor across launches', async (t) => {
  const root = await temporary(t),
    native = installer();
  let data = payload();
  const options = {
    version: installed.version,
    system: installed.system,
    now: () => now,
    installer: native.api,
    request: async () => new Response(envelope(data)),
  };
  const first = new AppUpdates(root, trust, options);
  assert.equal((await first.check()).phase, 'available');
  const second = new AppUpdates(root, trust, options);
  data = { ...data, sequence: 4 };
  await assert.rejects(second.check(), /older/);
  data = { ...data, sequence: 6, channel: 'beta', release: release('0.3.0-beta.1') };
  await second.configure({ channel: 'beta', automatic: true });
  assert.equal((await second.check()).phase, 'available');
  const third = new AppUpdates(root, trust, options);
  assert.equal((await third.status()).channel, 'beta');
  assert.equal((await third.status()).automatic, true);
  assert.equal(native.calls.length, 0);
  const state = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
  assert.equal(state.checkpoints.stable.sequence, 5);
  assert.equal(state.checkpoints.beta.sequence, 6);
});

test('download, save recovery, journal and install occur only after explicit user actions', async (t) => {
  const root = await temporary(t),
    native = installer();
  const updates = new AppUpdates(root, trust, {
    version: installed.version,
    system: installed.system,
    now: () => now,
    installer: native.api,
    request: async () => new Response(envelope()),
  });
  await updates.check();
  assert.deepEqual(native.calls, []);
  await updates.download();
  assert.equal((await updates.status()).phase, 'downloaded');
  assert.deepEqual(native.calls, ['download', 'verify']);
  await updates.restart(async () => {
    native.calls.push('recovery');
  });
  assert.deepEqual(native.calls, ['download', 'verify', 'verify', 'recovery', 'install']);
  const state = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
  assert.equal(state.attempt.version, '0.2.0');
  const reopened = new AppUpdates(root, trust, { version: '0.2.0', system: installed.system });
  assert.match((await reopened.status()).previousAttempt!, /updated to 0.2.0/);
  const failed = new AppUpdates(root, trust, {
    version: installed.version,
    system: installed.system,
  });
  assert.match((await failed.status()).previousAttempt!, /did not finish/);
});

test('failed native staging retains recovery and disables installation until a new process', async (t) => {
  const root = await temporary(t),
    native = installer();
  const recovery = path.join(root, 'saved-recovery.txt');
  native.api.install = async () => {
    assert.equal(await fs.readFile(recovery, 'utf8'), 'source, chat and notes');
    const state = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
    assert.equal(state.attempt.version, '0.2.0');
    throw new UpdateRestartRequired('App update preparation took longer than two minutes.');
  };
  const options = {
    version: installed.version,
    system: installed.system,
    now: () => now,
    request: async () => new Response(envelope()),
  };
  const updates = new AppUpdates(root, trust, { ...options, installer: native.api });
  await updates.check();
  await updates.download();
  await assert.rejects(
    updates.restart(() => fs.writeFile(recovery, 'source, chat and notes')),
    /two minutes/,
  );
  const failed = await updates.status();
  assert.equal(failed.phase, 'error');
  assert.equal(failed.canInstall, false);
  assert.match(failed.installReason!, /Quit and reopen/);
  assert.equal(await fs.readFile(recovery, 'utf8'), 'source, chat and notes');
  await updates.configure({ channel: 'beta', automatic: false });
  await updates.configure({ channel: 'stable', automatic: false });
  await updates.check();
  const before = [...native.calls];
  await assert.rejects(updates.download(), /Quit and reopen/);
  assert.deepEqual(native.calls, before);
  const reopened = new AppUpdates(root, trust, { ...options, installer: installer().api });
  assert.match((await reopened.status()).previousAttempt!, /did not finish/);
  assert.equal((await reopened.status()).canInstall, true);
  await reopened.check();
  await reopened.download();
  assert.equal((await reopened.status()).phase, 'downloaded');
});

test('failed recovery, expired metadata, invalid downloads and unavailable signing prevent installation', async (t) => {
  for (const failure of ['recovery', 'expiry', 'checksum', 'journal']) {
    const root = path.join(await temporary(t), failure),
      native = installer();
    let clock = now;
    const updates = new AppUpdates(root, trust, {
      version: installed.version,
      system: installed.system,
      now: () => clock,
      installer: native.api,
      request: async () => new Response(envelope()),
    });
    await updates.check();
    await updates.download();
    if (failure === 'expiry') clock += 86400_000;
    if (failure === 'checksum')
      native.api.verify = async () => {
        throw new Error('checksum changed');
      };
    if (failure === 'journal') {
      await fs.unlink(path.join(root, 'state.json'));
      await fs.mkdir(path.join(root, 'state.json'));
    }
    await assert.rejects(
      updates.restart(async () => {
        if (failure === 'recovery') throw new Error('disk full');
      }),
    );
    assert.ok(!native.calls.includes('install'), failure);
    assert.equal((await updates.status()).phase, 'error');
  }
  const preview = new AppUpdates(await temporary(t), trust, {
    version: installed.version,
    system: installed.system,
    now: () => now,
    installReason: 'Unsigned preview',
    request: async () => new Response(envelope()),
  });
  await preview.check();
  await assert.rejects(preview.download(), /Unsigned preview/);
});

test('changing channels invalidates downloads; concurrent operations cannot cross channels', async (t) => {
  const root = await temporary(t),
    native = installer();
  let started!: () => void, finish!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  native.api.download = async (_feed: UpdateFeed, signal) => {
    started();
    await pending;
    signal.throwIfAborted();
  };
  const updates = new AppUpdates(root, trust, {
    version: installed.version,
    system: installed.system,
    now: () => now,
    installer: native.api,
    request: async () => new Response(envelope()),
  });
  await updates.check();
  const downloading = updates.download();
  await active;
  await assert.rejects(updates.configure({ channel: 'beta', automatic: false }), /Wait/);
  const cancelled = updates.cancel();
  finish();
  await assert.rejects(downloading);
  await cancelled;
  await updates.configure({ channel: 'beta', automatic: false });
  assert.equal((await updates.status()).phase, 'idle');
  await assert.rejects(
    updates.restart(async () => {}),
    /Download/,
  );
  assert.ok(!native.calls.includes('install'));
});

test('corrupt persisted trust checkpoints are not silently reset', async (t) => {
  const root = await temporary(t);
  await fs.writeFile(path.join(root, 'state.json'), '{"schemaVersion":1,"cohort":"bad"}');
  const updates = new AppUpdates(root, trust, {
    version: installed.version,
    system: installed.system,
  });
  await assert.rejects(updates.status(), /damaged/);
  assert.equal(
    await fs.readFile(path.join(root, 'state.json'), 'utf8'),
    '{"schemaVersion":1,"cohort":"bad"}',
  );
});

test('a withdrawn offer is rechecked before any ZIP download', async (t) => {
  const native = installer();
  let current = payload();
  const updates = new AppUpdates(await temporary(t), trust, {
    version: installed.version,
    system: installed.system,
    now: () => now,
    installer: native.api,
    request: async () => new Response(envelope(current)),
  });
  await updates.check();
  current = { ...current, sequence: current.sequence + 1, release: null };
  await assert.rejects(updates.download(), /withdrawn/);
  assert.deepEqual(native.calls, []);
  current = payload();
  await assert.rejects(updates.check(), /older/);
});

test('cached ZIPs are fully rehashed, and damaged cache cleanup permits retry without following links', async (t) => {
  const root = await temporary(t),
    file = path.join(root, 'Folio-0.2.0-mac-arm64.zip');
  const feed = verifier.verify(envelope(), 'stable', now);
  await fs.writeFile(file, 'zip fixture');
  await verifyUpdateArchive(file, root, feed, now);
  await fs.writeFile(file, 'ZIP fixture');
  await assert.rejects(verifyUpdateArchive(file, root, feed, now), /checksum/);
  await discardUpdateArchive(file, root);
  await fs.writeFile(file, 'zip fixture');
  await verifyUpdateArchive(file, root, feed, now);
  const outside = await temporary(t),
    outsideFile = path.join(outside, path.basename(file));
  await fs.writeFile(outsideFile, 'private bytes');
  await fs.unlink(file);
  await fs.symlink(outsideFile, file);
  await assert.rejects(verifyUpdateArchive(file, root, feed, now), /path/);
  await discardUpdateArchive(file, root);
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'private bytes');
  const linked = path.join(root, 'linked-parent');
  await fs.symlink(outside, linked);
  await assert.rejects(
    discardUpdateArchive(path.join(linked, path.basename(file)), linked),
    /linked/,
  );
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'private bytes');
});

function freshFeed() {
  return verifier.verify(
    envelope({
      ...payload(),
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
    'stable',
  );
}

// Adapt compact unit response fixtures to the same Node stream consumed by
// production. The separate Electron fixture exercises the real request adapter.
function downloadAppUpdate(
  feed: Parameters<typeof transferAppUpdate>[0],
  url: URL,
  file: string,
  root: string,
  options: Parameters<typeof transferAppUpdate>[4],
  request: UpdateFetch,
) {
  return transferAppUpdate(feed, url, file, root, options, async (address, signal) => {
    const response = await request(address, { signal });
    const body = response.body
      ? Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>)
      : Readable.from([]);
    body.on('error', () => {});
    const abort = () => body.destroy(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    body.once('close', () => signal.removeEventListener('abort', abort));
    return { status: response.status, headers: response.headers, body };
  });
}

test('signed transfer bounds each chunk before disk writes, including missing and false lengths', async (t) => {
  const root = await temporary(t),
    file = path.join(root, 'download.part'),
    feed = freshFeed();
  const token = new CancellationToken();
  const options = { cancellationToken: token, sha512: feed.release!.zip.sha512 };
  await downloadAppUpdate(
    feed,
    new URL(feed.release!.zip.url),
    file,
    root,
    options,
    async () => new Response('zip fixture'),
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'zip fixture');
  const badStream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('zip f'));
        controller.enqueue(Buffer.alloc(10000));
        controller.close();
      },
    });
  for (const headers of [new Headers(), new Headers({ 'Content-Length': '11' })]) {
    await assert.rejects(
      downloadAppUpdate(
        feed,
        new URL(feed.release!.zip.url),
        file,
        root,
        options,
        async () => new Response(badStream(), { headers }),
      ),
      /exceeds its signed size/,
    );
    assert.ok((await fs.stat(file)).size <= 5, 'Excess chunk must never reach the file.');
  }
  const previousSize = (await fs.stat(file)).size;
  await assert.rejects(
    downloadAppUpdate(
      feed,
      new URL(feed.release!.zip.url),
      file,
      root,
      options,
      async () => new Response('zip fixture', { headers: { 'Content-Length': '10000' } }),
    ),
    /different size/,
  );
  assert.equal(
    (await fs.stat(file)).size,
    previousSize,
    'Invalid headers must not truncate the previous file.',
  );
  await assert.rejects(
    downloadAppUpdate(
      feed,
      new URL(feed.release!.zip.url),
      file,
      root,
      options,
      async () => new Response('wrong hash!'),
    ),
    /checksum/,
  );
  assert.equal(token.listenerCount('cancel'), 0);
});

test('cancelled transfers abort the request, close the file and have no later writes', async (t) => {
  const root = await temporary(t),
    file = path.join(root, 'download.part'),
    feed = freshFeed(),
    token = new CancellationToken();
  let signal: AbortSignal | null | undefined,
    cancelled = false;
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const operation = downloadAppUpdate(
    feed,
    new URL(feed.release!.zip.url),
    file,
    root,
    {
      cancellationToken: token,
      sha512: feed.release!.zip.sha512,
      onProgress: () => token.cancel(),
    },
    async (_url, init) => {
      signal = init.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(Buffer.from('zip f'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  );
  await assert.rejects(operation, /cancelled/);
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, true);
  assert.equal((await fs.stat(file)).size, 5);
  assert.throws(() => streamController.enqueue(Buffer.from('more')));
  await fs.rename(file, file + '.closed');
  assert.equal(token.listenerCount('cancel'), 0);
});

test('transfer refuses linked output without changing its target and rejects redirects before requesting them', async (t) => {
  const root = await temporary(t),
    outside = path.join(root, 'private.txt'),
    file = path.join(root, 'download.part'),
    feed = freshFeed();
  const options = { cancellationToken: new CancellationToken(), sha512: feed.release!.zip.sha512 };
  await fs.writeFile(outside, 'keep me');
  await fs.symlink(outside, file);
  await assert.rejects(
    downloadAppUpdate(
      feed,
      new URL(feed.release!.zip.url),
      file,
      root,
      options,
      async () => new Response('zip fixture'),
    ),
  );
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep me');
  await fs.unlink(file);
  await fs.link(outside, file);
  await assert.rejects(
    downloadAppUpdate(
      feed,
      new URL(feed.release!.zip.url),
      file,
      root,
      options,
      async () => new Response('zip fixture'),
    ),
    /without links/,
  );
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep me');
  let count = 0;
  await assert.rejects(
    downloadAppUpdate(feed, new URL(feed.release!.zip.url), file, root, options, async () => {
      count++;
      return new Response(null, { status: 302, headers: { Location: 'http://localhost/private' } });
    }),
    /approved/,
  );
  assert.equal(count, 1);
});
