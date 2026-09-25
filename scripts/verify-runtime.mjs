import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { releases } from './runtime-config.mjs';
import { templateInputs } from './template-inputs.mjs';

const spec = releases[`${process.platform}-${process.arch}`];
if (!spec) throw new Error('Unsupported runtime target.');
const root = path.resolve('resources/runtime', `${spec.os}-${process.arch}`);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
for (const [name, expected] of Object.entries(manifest.files)) {
  const actual = createHash('sha256')
    .update(await fs.readFile(path.join(root, name)))
    .digest('hex');
  if (actual !== expected) throw new Error(`Runtime integrity check failed: ${name}`);
}
await fs.mkdir('.cache', { recursive: true });
const temporary = await fs.mkdtemp(path.resolve('.cache/offline-check-'));
try {
  const sources = await templateInputs(path.join(temporary, 'templates'));
  for (const directory of [...(manifest.biberVersion ? ['resources/runtime-checks'] : [])]) {
    for (const name of (await fs.readdir(directory)).filter((n) => n.endsWith('.tex')).sort())
      sources.push(path.resolve(directory, name));
  }
  for (const source of sources) {
    const result = spawnSync(
      path.join(root, process.platform === 'win32' ? 'tectonic.exe' : 'tectonic'),
      [
        '-X',
        'compile',
        source,
        '--bundle',
        path.join(root, 'bundle.zip'),
        '--only-cached',
        '--untrusted',
        '--outdir',
        temporary,
      ],
      {
        timeout: 60_000,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          PAR_GLOBAL_TEMP: path.join(root, 'biber-cache'),
          TECTONIC_CACHE_DIR: path.join(temporary, path.basename(source, '.tex') + '-cache'),
          XDG_CONFIG_HOME: path.join(temporary, 'config'),
        },
      },
    );
    if (result.status !== 0)
      throw new Error(
        `Offline verification failed for ${path.basename(source)}: ${result.stderr}\n${result.stdout}`,
      );
    console.log(`Verified offline: ${path.basename(source)}`);
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
