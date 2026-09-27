import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeFile, runtimePin, verifyRuntime } from '../electron/core/runtime';
import { prepareSignedBiber } from './prepare-signed-biber';

const execute = promisify(execFile);
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
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
type Run = (command: string, args: string[]) => Promise<void>;
export const signingCommand: Run = async (command, args) => {
  await execute(command, args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
};

/** Mutates a private packaging copy only. A failure invalidates that copy;
 * never repair its manifest or publish it after a failed signing operation. */
export async function signMacRuntime(
  directory: string,
  options: { identity: string; keychain?: string; adHocTest?: boolean; run?: Run },
) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Runtime signing requires an Apple silicon Mac.');
  if (!options.identity?.trim() || (options.identity === '-' && !options.adHocTest))
    throw new Error('Select a signing identity; ad-hoc signing requires explicit test mode.');
  if (options.adHocTest && options.identity !== '-')
    throw new Error('Ad-hoc test mode must use the ad-hoc identity.');
  const root = path.resolve(directory);
  const run = options.run ?? signingCommand;
  const originalBytes = await runtimeFile(root, 'manifest.json');
  const { manifest, pin: before } = await verifyRuntime(root);
  if (manifest.platform !== 'darwin-arm64') throw new Error('Expected an Apple silicon runtime.');
  const native: string[] = [];
  // Inspect every inventoried file, including Perl XS modules with .bundle names.
  // Do not rely on executable permission bits or a list of filename extensions.
  for (const name of Object.keys(manifest.files).sort()) {
    const data = await runtimeFile(root, name);
    if (magic.has(data.subarray(0, 4).toString('hex'))) {
      // Older Apple lipo treats every argument after -verify_arch as an
      // architecture. Put the input first, before that variadic option.
      await run('/usr/bin/lipo', [path.join(root, name), '-verify_arch', 'arm64']);
      native.push(name);
    }
  }
  if (!native.includes('tectonic'))
    throw new Error('The runtime has no native Tectonic executable.');
  const preparation = await prepareSignedBiber(root, manifest, native);
  // Libraries/modules first, then helper executables. No --deep signing:
  // each code object has its own identifier and no unrelated app entitlements.
  native.sort((a, b) => {
    const rank = (name: string) =>
      ['tectonic', 'biber', 'biber-cache/biber'].includes(name) ? 1 : 0;
    return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  });
  for (const name of native) {
    await run('/usr/bin/codesign', [
      '--force',
      '--sign',
      options.identity,
      '--identifier',
      `app.folio.runtime.${digest(name).slice(0, 32)}`,
      ...(options.keychain ? ['--keychain', options.keychain] : []),
      ...(options.adHocTest ? ['--timestamp=none'] : ['--options', 'runtime', '--timestamp']),
      path.join(root, name),
    ]);
  }
  const nativeNames = new Set(native);
  const next = { ...manifest, files: { ...manifest.files } };
  for (const name of Object.keys(next.files)) {
    const hash = digest(await runtimeFile(root, name));
    if (nativeNames.has(name)) {
      await run('/usr/bin/codesign', [
        '--verify',
        '--strict',
        '--all-architectures',
        path.join(root, name),
      ]);
      if (digest(await runtimeFile(root, name)) !== hash)
        throw new Error(`A code file changed during signature verification: ${name}`);
    } else if (hash !== manifest.files[name])
      throw new Error(`A non-code runtime resource changed during signing: ${name}`);
    next.files[name] = hash;
  }
  if (!(await runtimeFile(root, 'manifest.json')).equals(originalBytes))
    throw new Error('The runtime manifest changed during signing.');
  const after = runtimePin(next);
  const updated = Buffer.from(JSON.stringify(next, null, 2) + '\n');
  // This is an unpublished packaging copy, not a live runtime transaction.
  // Write the inventory only after every code signature and resource check pass.
  await fs.writeFile(path.join(root, 'manifest.json'), updated);
  await verifyRuntime(root, after);
  return {
    schemaVersion: 1,
    mode: options.adHocTest ? 'ad-hoc-test' : 'distribution',
    before,
    after,
    manifestSha256: digest(updated),
    code: native.map((name) => ({
      path: name,
      before: manifest.files[name],
      after: next.files[name],
    })),
    fileCount: Object.keys(next.files).length,
    preparation,
  };
}
