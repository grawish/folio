import { build } from 'esbuild';

export async function buildElectron({ packTestTrust } = {}) {
  await build({
    entryPoints: ['electron/main.ts', 'electron/preload.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outdir: 'dist-electron',
    outExtension: { '.js': '.cjs' },
    external: ['electron'],
    sourcemap: true,
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
  });
}

if (process.argv[1]?.endsWith('build-electron.mjs')) await buildElectron();
