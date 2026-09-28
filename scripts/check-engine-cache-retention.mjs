import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Developer diagnostic: the real Compiler lifecycle with a synthetic native
// sink. No TeX process, real project or user profile is opened.
const compilerFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('../electron/core/compiler.ts', import.meta.url));
const { Compiler } = await tsImport(pathToFileURL(compilerFile).href, import.meta.url);
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const root = await fs.mkdtemp(path.resolve('test-results/engine-cache-retention-'));
const runtime = path.join(root, 'runtime'),
  work = path.join(root, 'work');
await fs.mkdir(runtime);
let runtimeId;
const compiler = new Compiler(
  {
    acquire: async () => ({
      root: runtime,
      status: {
        ready: true,
        engine: 'synthetic',
        bundle: 'synthetic',
        platform: 'darwin-arm64',
        isolation: 'macos-sandbox',
        message: 'Synthetic cache diagnostic',
        pin: {
          engine: 'tectonic',
          version: '0.0.0',
          bundle: 'synthetic',
          platform: 'darwin-arm64',
          id: runtimeId,
        },
      },
      release: async () => {},
    }),
  },
  work,
);
compiler.run = async (_command, _args, _cwd, _home, cache) => {
  await fs.writeFile(path.join(cache, 'format.fmt'), Buffer.alloc(256));
  return { code: 1, log: 'Synthetic native sink; no TeX was executed.' };
};
const observations = [];
for (let i = 1; i <= 5; i++) {
  runtimeId = i.toString(16).padStart(64, '0');
  const result = await compiler.compile({
    id: 'cache-diagnostic',
    name: 'Cache diagnostic',
    mainFile: 'main.tex',
    revision: i,
    files: [{ path: 'main.tex', content: 'Synthetic source' }],
  });
  if (result.status !== 'error' || !result.log.includes('Synthetic native sink'))
    throw new Error(`Unexpected compiler result: ${result.log}`);
  const cache = path.join(work, 'engine-cache');
  const retained = (await fs.readdir(cache)).filter((n) => /^[a-f0-9]{64}$/.test(n)).sort();
  observations.push({
    runtime: i,
    retained,
    files: retained.length,
    bytes: (
      await Promise.all(retained.map((n) => fs.stat(path.join(cache, n, 'format.fmt'))))
    ).reduce((sum, stat) => sum + stat.size, 0),
  });
}
await compiler.cancel();
const report = {
  compilerSha256: await hash(compilerFile),
  scriptSha256: await hash(fileURLToPath(import.meta.url)),
  scope:
    'Production Compiler lifecycle with five synthetic runtime identities and a substituted 256-byte native cache writer. Counts verify retention, not actual format size, memory use or speed.',
  observations,
};
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ evidence: root, ...report }, null, 2));
