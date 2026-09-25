import { build } from 'esbuild';

export async function buildElectron() {
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
  });
}

if (process.argv[1]?.endsWith('build-electron.mjs')) await buildElectron();
