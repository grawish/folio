import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeFile, verifyRuntime } from '../electron/core/runtime';
import type { signMacRuntime } from './sign-mac-runtime';

const execute = promisify(execFile);
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const magic = new Set([
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
]);
type Record = Awaited<ReturnType<typeof signMacRuntime>> & {
  passed: boolean;
  appSignatureVerified: boolean;
};

/** Independently inspect the artifact and Apple signatures; a sidecar report
 * is an input to validate, never a substitute for checking actual code. */
export async function verifySignedRuntime(
  app: string,
  prepared: string,
  value: unknown,
  options: { allowAdHocTest?: boolean; expectedTeamId?: string } = {},
) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Signature verification requires an Apple silicon Mac.');
  const record = value as Record;
  assert.ok(
    record &&
      record.schemaVersion === 1 &&
      record.passed === true &&
      record.appSignatureVerified === true,
    'The signing record is incomplete.',
  );
  assert.ok(
    record.mode === 'distribution' || record.mode === 'ad-hoc-test',
    'Unknown signing mode.',
  );
  const adHoc = record.mode === 'ad-hoc-test';
  if (adHoc && !options.allowAdHocTest)
    throw new Error('Ad-hoc artifacts require explicit test verification.');
  if (!adHoc && !/^[A-Z0-9]{10}$/.test(options.expectedTeamId ?? ''))
    throw new Error('Distribution verification requires the owner-selected Apple Team ID.');
  const runtime = path.join(app, 'Contents/Resources/runtime');
  const before = await verifyRuntime(prepared);
  const after = await verifyRuntime(runtime);
  assert.deepEqual(record.before, before.pin, 'Signing input does not match the prepared runtime.');
  assert.deepEqual(record.after, after.pin, 'Signing output does not match the packaged runtime.');
  assert.equal(record.manifestSha256, hash(await runtimeFile(runtime, 'manifest.json')));
  assert.deepEqual(
    { ...before.manifest, files: undefined },
    { ...after.manifest, files: undefined },
    'Signing changed runtime metadata.',
  );
  const names = Object.keys(before.manifest.files).sort();
  assert.deepEqual(
    Object.keys(after.manifest.files).sort(),
    names,
    'Signing changed the runtime inventory.',
  );
  assert.equal(record.fileCount, names.length);
  assert.ok(Array.isArray(record.code), 'Missing signed-code inventory.');
  const native: string[] = [];
  for (const name of names) {
    if (magic.has((await runtimeFile(prepared, name)).subarray(0, 4).toString('hex')))
      native.push(name);
    else
      assert.equal(
        after.manifest.files[name],
        before.manifest.files[name],
        `Signing changed a resource: ${name}`,
      );
  }
  assert.deepEqual(
    record.code.map((item) => item.path).sort(),
    native,
    'Signed-code inventory is incomplete or duplicated.',
  );
  for (const item of record.code) {
    assert.equal(item.before, before.manifest.files[item.path]);
    assert.equal(item.after, after.manifest.files[item.path]);
  }
  if (before.manifest.biberVersion) {
    const source = await fs.readFile(fileURLToPath(new URL('./biber-launcher.c', import.meta.url)));
    assert.equal(
      record.preparation?.launcherSourceSha256,
      hash(source),
      'The launcher source differs from its signing record.',
    );
  }
  const inspect = async (file: string, identifier: string, outer = false) => {
    const requirement =
      `=identifier "${identifier}"` +
      (adHoc
        ? ''
        : ` and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${options.expectedTeamId}"`);
    await execute(
      '/usr/bin/codesign',
      [
        '--verify',
        '--strict',
        '--all-architectures',
        ...(outer ? ['--deep'] : []),
        '-R',
        requirement,
        file,
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    const details = await execute('/usr/bin/codesign', ['--display', '--verbose=4', file], {
      timeout: 30_000,
    });
    const actualAdHoc = /^Signature=adhoc$/m.test(details.stderr);
    assert.equal(
      actualAdHoc,
      adHoc,
      'The actual signature does not match the reported signing mode.',
    );
    if (!adHoc) {
      assert.ok(
        /^CodeDirectory .*flags=.*\bruntime\b/m.test(details.stderr),
        'Missing hardened runtime signature.',
      );
      assert.ok(/^Timestamp=.+/m.test(details.stderr), 'Missing secure signing timestamp.');
    }
  };
  await inspect(app, 'app.folio.resume', true);
  for (const name of native)
    await inspect(path.join(runtime, name), `app.folio.runtime.${hash(name).slice(0, 32)}`);
  await verifyRuntime(runtime, after.pin);
  await inspect(app, 'app.folio.resume', true);
  return {
    mode: record.mode,
    nativeSignaturesVerified: native.length,
    runtimeManifestVerified: true,
    appSignatureVerified: true,
    developerIdVerified: !adHoc,
    ...(adHoc ? {} : { teamId: options.expectedTeamId }),
    notarizationVerified: false,
    scope:
      'Actual code signatures, exact transformed inventory and unchanged resources. Notarization and native workflow acceptance are separate gates.',
  };
}
