import { build } from 'esbuild';

export async function buildElectron({ packTestTrust, collectMetadata = false, write = true } = {}) {
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outdir: 'dist-electron',
    outExtension: { '.js': '.cjs' },
    external: ['electron'],
    sourcemap: true,
    metafile: collectMetadata,
    write,
    // Native workflow tests supply an ephemeral public key at build time. No
    // runtime environment variable or renderer request can change app trust.
    // Ordinary build/pack/dist always call this without a test override.
    plugins: packTestTrust
      ? [
          {
            name: 'native-pack-test-trust',
            setup(build) {
              build.onLoad({ filter: /[\\/]pack-trust\.ts$/ }, () => ({
                contents: `export const packTrust = ${JSON.stringify(packTestTrust)};`,
                loader: 'ts',
              }));
            },
          },
        ]
      : [],
  };
  const main = await build({
    ...common,
    entryPoints: ['electron/main.ts'],
    // Source ESM and packaged CommonJS resolve the same sibling worker. Keep
    // this Node-only banner out of the sandboxed preload entry.
    define: { 'import.meta.url': 'folioImportMetaUrl' },
    banner: {
      js: 'const folioImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
    },
  });
  const supporting = await build({
    ...common,
    entryPoints: {
      preload: 'electron/preload.ts',
      'history-zip-worker': 'electron/core/history-zip-worker.cjs',
    },
  });
  return [main, supporting];
}

if (process.argv[1]?.endsWith('build-electron.mjs')) await buildElectron();
