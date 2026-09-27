import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { signAsync } from '@electron/osx-sign';
import { tsImport } from 'tsx/esm/api';

// electron-builder 26 CustomMacSign hook. Its native identity/keychain lookup
// still runs first; notarization still runs after this complete signing phase.
export default async function signMacApp(options, packager) {
  if (options.platform !== 'darwin') throw new Error('Folio signing targets macOS outside MAS.');
  const app = path.resolve(options.app);
  const runtime = path.join(app, 'Contents/Resources/runtime');
  const reportFile = path.join(path.dirname(app), 'runtime-signing.json');
  await fs.writeFile(reportFile, JSON.stringify({ passed: false, phase: 'starting' }) + '\n');
  const expected = await fs.readFile(
    path.join(packager.projectDir, 'resources/runtime/mac-arm64/manifest.json'),
  );
  assert.deepEqual(
    await fs.readFile(path.join(runtime, 'manifest.json')),
    expected,
    'The staged runtime must start from the exact prepared inventory.',
  );
  const { signMacRuntime, signingCommand } = await tsImport(
    './sign-mac-runtime.ts',
    import.meta.url,
  );
  const { verifyRuntime } = await tsImport('../electron/core/runtime.ts', import.meta.url);
  const result = await signMacRuntime(runtime, {
    identity: options.identity,
    keychain: options.keychain,
    adHocTest: options.identity === '-' && process.env.FOLIO_ADHOC_SIGNING_TEST === '1',
  });
  const { checkSignedRuntime } = await tsImport('./check-signed-runtime.ts', import.meta.url);
  const offlineCheck = await checkSignedRuntime(runtime);
  // These files are already individually signed. Re-signing them here would
  // invalidate the freshly measured manifest before the app's outer seal.
  const withinRuntime = (file) => {
    const resolved = path.resolve(file);
    return resolved === runtime || resolved.startsWith(runtime + path.sep);
  };
  await signAsync({
    ...options,
    strictVerify: true,
    binaries: options.binaries?.filter((file) => !withinRuntime(file)),
    ignore: (file) => withinRuntime(file) || options.ignore?.(file) === true,
  });
  await signingCommand('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--all-architectures',
    app,
  ]);
  await verifyRuntime(runtime, result.after);
  const sealedManifest = await fs.readFile(path.join(runtime, 'manifest.json'));
  assert.equal(createHash('sha256').update(sealedManifest).digest('hex'), result.manifestSha256);
  await fs.writeFile(
    reportFile,
    JSON.stringify(
      {
        ...result,
        offlineCheck,
        passed: true,
        appSignatureVerified: true,
        notarizationVerified: false,
        scope:
          'Individual native signatures, final runtime inventory and outer app signature. Developer ID/notarization and public-pack acceptance require their separate release gates.',
      },
      null,
      2,
    ) + '\n',
  );
}
