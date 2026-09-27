import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { build } from 'esbuild';

await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/update-download-'));
const bundle = path.join(root, 'fixture.cjs');
await fs.writeFile(
  path.join(root, 'package.json'),
  JSON.stringify({ name: 'folio-update-fixture', version: '0.1.0', main: 'fixture.cjs' }),
);
await build({
  entryPoints: ['scripts/fixtures/update-download.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  outfile: bundle,
});
const inputs = {};
for (const file of [
  'scripts/fixtures/update-download.ts',
  'electron/core/update-installer.ts',
  'electron/core/update-manifest.ts',
  'electron/core/update-provider.ts',
  'electron/core/update-archive.ts',
  'electron/core/update-feed.ts',
  'electron/core/update-download.ts',
  'electron/core/update-request.ts',
  'package-lock.json',
])
  inputs[file] = createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
await fs.writeFile(
  path.join(root, 'inputs.json'),
  JSON.stringify(
    {
      inputs,
      bundleSha256: createHash('sha256')
        .update(await fs.readFile(bundle))
        .digest('hex'),
    },
    null,
    2,
  ),
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [root], {
    env,
    timeout: 90_000,
    killSignal: 'SIGKILL',
    maxBuffer: 2 * 1024 ** 2,
  });
  await fs.writeFile(path.join(root, 'native-output.log'), result.stdout + result.stderr);
  process.stdout.write(result.stdout);
  const report = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
  if (!report.passed || report.nativeInstallationAttempted)
    throw new Error('The updater fixture did not finish safely.');
} catch (error) {
  await fs.writeFile(
    path.join(root, 'native-output.log'),
    (error.stdout ?? '') + (error.stderr ?? ''),
  );
  await fs.writeFile(
    path.join(root, 'process-failure.json'),
    JSON.stringify(
      { error: String(error), killed: error.killed, signal: error.signal, code: error.code },
      null,
      2,
    ),
  );
  console.error(`Updater fixture failed. Evidence: ${root}`);
  throw error;
}
