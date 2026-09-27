import { test, before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { signMacRuntime, signingCommand } from '../scripts/sign-mac-runtime';
import { verifyRuntime } from '../electron/core/runtime';
import { verifySignedRuntime } from '../scripts/verify-signed-runtime';

const supported = process.platform === 'darwin' && process.arch === 'arm64';
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
let executable: Buffer, buildRoot: string;
before(async () => {
  if (!supported) return;
  buildRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-signing-code-'));
  const file = path.join(buildRoot, 'fixture.c');
  await fs.writeFile(file, 'int main(void) { return 0; }\n');
  execFileSync(
    '/usr/bin/xcrun',
    ['clang', '-arch', 'arm64', file, '-o', path.join(buildRoot, 'tool')],
    { timeout: 30_000 },
  );
  executable = await fs.readFile(path.join(buildRoot, 'tool'));
});
after(async () => {
  if (buildRoot) await fs.rm(buildRoot, { recursive: true, force: true });
});
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-signing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'tectonic'), executable, { mode: 0o755 });
  await fs.writeFile(path.join(root, 'bundle.zip'), 'Synthetic resource bytes');
  const manifest = {
    schemaVersion: 1,
    version: '0.17.0',
    bundle: 'signing-fixture',
    platform: 'darwin-arm64',
    files: {
      tectonic: hash(executable),
      'bundle.zip': hash(Buffer.from('Synthetic resource bytes')),
    },
  };
  const original = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(root, 'manifest.json'), original);
  return { root, manifest, original };
}

async function appFixture(t: TestContext) {
  const prepared = (await fixture(t)).root;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-signing-app-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const app = path.join(folder, 'Folio.app');
  const runtime = path.join(app, 'Contents/Resources/runtime');
  await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
  await fs.cp(prepared, runtime, { recursive: true });
  await fs.writeFile(path.join(app, 'Contents/MacOS/Folio'), executable, { mode: 0o755 });
  await fs.writeFile(
    path.join(app, 'Contents/Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.folio.resume</string><key>CFBundleExecutable</key><string>Folio</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
  );
  const record = {
    ...(await signMacRuntime(runtime, { identity: '-', adHocTest: true })),
    passed: true,
    appSignatureVerified: true,
  };
  const seal = () =>
    signingCommand('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
  await seal();
  return { app, prepared, runtime, record, seal };
}

test(
  'an unreviewed Biber or Perl ABI is rejected before its files are transformed',
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, 'biber-cache'));
    await fs.writeFile(path.join(f.root, 'biber'), executable, { mode: 0o755 });
    await fs.writeFile(path.join(f.root, 'biber-cache/biber'), executable, { mode: 0o755 });
    await fs.writeFile(
      path.join(f.root, 'manifest.json'),
      JSON.stringify({
        ...f.manifest,
        biberVersion: '2.17',
        files: {
          ...f.manifest.files,
          biber: hash(executable),
          'biber-cache/biber': hash(executable),
        },
      }),
    );
    const before = await verifyRuntime(f.root);
    await assert.rejects(
      signMacRuntime(f.root, { identity: '-', adHocTest: true }),
      /requires the reviewed Biber/,
    );
    assert.deepEqual(await verifyRuntime(f.root), before);
  },
);

test(
  'real ad-hoc signing records exact final code bytes and a different compiler identity',
  { skip: !supported },
  async (t) => {
    const { root, original } = await fixture(t);
    const result = await signMacRuntime(root, { identity: '-', adHocTest: true });
    assert.equal(result.mode, 'ad-hoc-test');
    assert.equal(result.code.length, 1);
    assert.notEqual(result.after.id, result.before.id);
    const actual = await fs.readFile(path.join(root, 'tectonic'));
    assert.notEqual(hash(actual), hash(executable));
    assert.equal(result.code[0].after, hash(actual));
    assert.equal(result.manifestSha256, hash(await fs.readFile(path.join(root, 'manifest.json'))));
    assert.deepEqual((await verifyRuntime(root, result.after)).pin, result.after);
    await assert.rejects(verifyRuntime(root, result.before), /does not match/);
    await signingCommand('/usr/bin/codesign', [
      '--verify',
      '--strict',
      path.join(root, 'tectonic'),
    ]);
    assert.equal(execFileSync(path.join(root, 'tectonic')).length, 0);
    assert.notDeepEqual(await fs.readFile(path.join(root, 'manifest.json')), original);
  },
);

test(
  'a mismatched source inventory is rejected before any signing command',
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    await fs.appendFile(path.join(f.root, 'bundle.zip'), 'Unexpected edit');
    let calls = 0;
    await assert.rejects(
      signMacRuntime(f.root, {
        identity: '-',
        adHocTest: true,
        run: async () => {
          calls++;
        },
      }),
      /integrity check/,
    );
    assert.equal(calls, 0);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'manifest.json')), f.original);
  },
);

test(
  'unknown code and linked runtime files cannot be blessed by signing',
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, 'extra'), executable);
    await assert.rejects(
      signMacRuntime(f.root, { identity: '-', adHocTest: true }),
      /Unexpected compiler resource/,
    );
    await fs.unlink(path.join(f.root, 'extra'));
    await fs.unlink(path.join(f.root, 'tectonic'));
    await fs.symlink(path.join(buildRoot, 'tool'), path.join(f.root, 'tectonic'));
    await assert.rejects(
      signMacRuntime(f.root, { identity: '-', adHocTest: true }),
      /without links/,
    );
    assert.deepEqual(await fs.readFile(path.join(f.root, 'manifest.json')), f.original);
    assert.deepEqual(await fs.readFile(path.join(buildRoot, 'tool')), executable);
  },
);

test(
  'failed code signing leaves the old manifest and an unusable private staging copy',
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      signMacRuntime(f.root, {
        identity: '-',
        adHocTest: true,
        run: async (command, args) => {
          await signingCommand(command, args);
          if (args.includes('--sign')) throw new Error('Interrupted after actual native signing');
        },
      }),
      /Interrupted/,
    );
    assert.deepEqual(await fs.readFile(path.join(f.root, 'manifest.json')), f.original);
    await assert.rejects(verifyRuntime(f.root), /integrity check/);
    await assert.rejects(
      signMacRuntime(f.root, { identity: '-', adHocTest: true }),
      /integrity check/,
    );
  },
);

test(
  'changing a resource during signing aborts before publishing a new manifest',
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      signMacRuntime(f.root, {
        identity: '-',
        adHocTest: true,
        run: async (command, args) => {
          await signingCommand(command, args);
          if (args.includes('--sign'))
            await fs.appendFile(path.join(f.root, 'bundle.zip'), 'Changed');
        },
      }),
      /non-code runtime resource changed/,
    );
    assert.deepEqual(await fs.readFile(path.join(f.root, 'manifest.json')), f.original);
  },
);

test(
  'changing code during signature verification aborts before manifest publication',
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      signMacRuntime(f.root, {
        identity: '-',
        adHocTest: true,
        run: async (command, args) => {
          await signingCommand(command, args);
          if (command.endsWith('codesign') && args.includes('--verify'))
            await fs.appendFile(path.join(f.root, 'tectonic'), 'Changed');
        },
      }),
      /changed during signature verification/,
    );
    assert.deepEqual(await fs.readFile(path.join(f.root, 'manifest.json')), f.original);
  },
);

test(
  'ad-hoc signing cannot be selected accidentally as production signing',
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(signMacRuntime(f.root, { identity: '-' }), /explicit test mode/);
    await assert.rejects(signMacRuntime(f.root, { identity: '' }), /Select a signing identity/);
    await assert.rejects(
      signMacRuntime(f.root, { identity: 'not-a-real-identity', adHocTest: true }),
      /must use the ad-hoc identity/,
    );
    assert.deepEqual(await fs.readFile(path.join(f.root, 'manifest.json')), f.original);
  },
);

test(
  'artifact verification checks real signatures and accepts ad-hoc only by explicit opt-in',
  { skip: !supported },
  async (t) => {
    const f = await appFixture(t);
    await assert.rejects(
      verifySignedRuntime(f.app, f.prepared, f.record),
      /explicit test verification/,
    );
    const checked = await verifySignedRuntime(f.app, f.prepared, f.record, {
      allowAdHocTest: true,
    });
    assert.equal(checked.nativeSignaturesVerified, 1);
    assert.equal(checked.developerIdVerified, false);
    assert.equal(checked.notarizationVerified, false);
  },
);

test(
  'a forged signing report cannot change provenance, omit code, or call ad-hoc a distribution signature',
  { skip: !supported },
  async (t) => {
    const f = await appFixture(t);
    const options = { allowAdHocTest: true };
    await assert.rejects(
      verifySignedRuntime(
        f.app,
        f.prepared,
        { ...f.record, before: { ...f.record.before, id: '0'.repeat(64) } },
        options,
      ),
      /Signing input/,
    );
    await assert.rejects(
      verifySignedRuntime(f.app, f.prepared, { ...f.record, code: [] }, options),
      /Signed-code inventory/,
    );
    await assert.rejects(
      verifySignedRuntime(
        f.app,
        f.prepared,
        { ...f.record, code: [...f.record.code, ...f.record.code] },
        options,
      ),
      /Signed-code inventory/,
    );
    await assert.rejects(
      verifySignedRuntime(f.app, f.prepared, { ...f.record, mode: 'distribution' }, options),
      /owner-selected Apple Team ID/,
    );
    await assert.rejects(
      verifySignedRuntime(
        f.app,
        f.prepared,
        { ...f.record, mode: 'distribution' },
        { ...options, expectedTeamId: 'ABCDEFGHIJ' },
      ),
    );
  },
);

test(
  'editing a sealed app is rejected even when its compiler signing report still says passed',
  { skip: !supported },
  async (t) => {
    const f = await appFixture(t);
    await fs.appendFile(path.join(f.app, 'Contents/Info.plist'), '\n<!-- changed -->');
    await assert.rejects(
      verifySignedRuntime(f.app, f.prepared, f.record, { allowAdHocTest: true }),
    );
  },
);

test(
  're-signing a substituted native helper with a different identity is rejected',
  { skip: !supported },
  async (t) => {
    const f = await appFixture(t);
    await signingCommand('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      '--identifier',
      'unexpected.helper',
      '--timestamp=none',
      path.join(f.runtime, 'tectonic'),
    ]);
    const file = path.join(f.runtime, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    manifest.files.tectonic = hash(await fs.readFile(path.join(f.runtime, 'tectonic')));
    await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
    const record = {
      ...f.record,
      after: (await verifyRuntime(f.runtime)).pin,
      manifestSha256: hash(await fs.readFile(file)),
      code: [{ ...f.record.code[0], after: manifest.files.tectonic }],
    };
    await f.seal();
    await assert.rejects(verifySignedRuntime(f.app, f.prepared, record, { allowAdHocTest: true }));
  },
);

test(
  'a new outer seal and rewritten hashes cannot bless a changed non-code resource',
  { skip: !supported },
  async (t) => {
    const f = await appFixture(t);
    await fs.appendFile(path.join(f.runtime, 'bundle.zip'), 'Changed');
    const file = path.join(f.runtime, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    manifest.files['bundle.zip'] = hash(await fs.readFile(path.join(f.runtime, 'bundle.zip')));
    await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
    const record = {
      ...f.record,
      after: (await verifyRuntime(f.runtime)).pin,
      manifestSha256: hash(await fs.readFile(file)),
    };
    await f.seal();
    await assert.rejects(
      verifySignedRuntime(f.app, f.prepared, record, { allowAdHocTest: true }),
      /Signing changed a resource/,
    );
  },
);
