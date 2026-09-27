import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeManifest } from '../electron/core/runtime';
import provenance from '../resources/biber-build-provenance.lock.json';

const execute = promisify(execFile);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const external = new Map([
  [
    'biber-cache/inc/lib/auto/DBD/mysql/mysql.bundle',
    '/opt/local/lib/mysql57/mysql/libmysqlclient.20.dylib',
  ],
  ['biber-cache/inc/lib/auto/Tk/Tk.bundle', '/opt/local/lib/libX11.6.dylib'],
]);

/** Only runs inside an already verified, unpublished runtime copy. Keep the
 * source runtime unchanged so existing project pins and public packs stay valid. */
export async function prepareSignedBiber(
  root: string,
  manifest: RuntimeManifest,
  native: string[],
) {
  if (!manifest.biberVersion) return undefined;
  const perl = provenance.embeddedBinaries.find((item) => item.cachePath === 'libperl.dylib')!;
  if (
    manifest.biberVersion !== provenance.biberVersion ||
    manifest.files.biber !== provenance.arm64Binary.sha256 ||
    manifest.files['biber-cache/libperl.dylib'] !== perl.sha256 ||
    !manifest.files['biber-cache/inc/script/biber-darwin']
  )
    throw new Error(
      'The signed Biber launcher requires the reviewed Biber 2.17 / Perl 5.32.1 inputs.',
    );
  const source = fileURLToPath(new URL('./biber-launcher.c', import.meta.url));
  const sourceBytes = await fs.readFile(source);
  const compiler = await execute('/usr/bin/xcrun', ['clang', '--version'], { timeout: 30_000 });
  await execute(
    '/usr/bin/xcrun',
    [
      'clang',
      '-arch',
      'arm64',
      '-mmacosx-version-min=11.0',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      source,
      path.join(root, 'biber-cache/libperl.dylib'),
      '-o',
      path.join(root, 'biber'),
    ],
    { timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  if (!(await fs.readFile(source)).equals(sourceBytes))
    throw new Error('Biber launcher source changed during compilation.');
  const relocations: { path: string; from: string; to: string }[] = [];
  const unavailable: { path: string; dependency: string }[] = [];
  const natives = new Set(native);
  for (const name of native) {
    const file = path.join(root, name);
    const [loads, identifiers] = await Promise.all([
      execute('/usr/bin/otool', ['-L', file], { timeout: 30_000 }),
      execute('/usr/bin/otool', ['-D', file], { timeout: 30_000 }),
    ]);
    const ids = new Set(identifiers.stdout.split('\n').map((line) => line.trim()));
    const dependencies = new Set(
      loads.stdout
        .split('\n')
        .filter((line) => /^\s+\S.* \(compatibility version /.test(line))
        .map((line) => line.trim().split(' (compatibility version ')[0]),
    );
    for (const dependency of dependencies) {
      if (
        ids.has(dependency) ||
        dependency.startsWith('/usr/lib/') ||
        dependency.startsWith('/System/Library/')
      )
        continue;
      const target = `biber-cache/${path.basename(dependency)}`;
      if (!natives.has(target)) {
        if (external.get(name) !== dependency)
          throw new Error(`Unreviewed native dependency in ${name}: ${dependency}`);
        // These two optional upstream modules are not used by the bibliography
        // corpus. Preserve their original imports, and report the limitation.
        unavailable.push({ path: name, dependency });
        continue;
      }
      const to = '@loader_path/' + path.relative(path.dirname(file), path.join(root, target));
      if (dependency === to) continue;
      await execute('/usr/bin/install_name_tool', ['-change', dependency, to, file], {
        timeout: 30_000,
      });
      relocations.push({ path: name, from: dependency, to });
    }
  }
  return {
    launcherSourceSha256: hash(sourceBytes),
    compiler: compiler.stdout.trim(),
    perlVersion: provenance.perlVersion,
    originalPerlSha256: perl.sha256,
    relocations,
    unavailableOptionalImports: unavailable,
  };
}
