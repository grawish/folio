import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'folio-biber-runtime-'));
const biber = path.resolve('resources/runtime/mac-arm64/biber');
const source = path.resolve(
  'artifacts/license-materials/compiler-sources/biber/biber-3091bee31a9706e3aa5e4afef81062856e14735a.tar.gz',
);
const digest = (data) => createHash('sha256').update(data).digest('hex');
try {
  await mkdir(path.join(root, 'out'));
  await mkdir(path.join(root, 'home'));
  await mkdir(path.join(root, 'config'));
  await run(
    'tar',
    [
      '-xzf',
      source,
      '--strip-components=3',
      'biber-3091bee31a9706e3aa5e4afef81062856e14735a/t/tdata/basic-misc.bcf',
      'biber-3091bee31a9706e3aa5e4afef81062856e14735a/t/tdata/examples.bib',
    ],
    { cwd: root },
  );
  await run('mv', ['basic-misc.bcf', 'normal.bcf'], { cwd: root });
  const env = {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    PATH: '/usr/bin:/bin',
  };
  const normal = await run(biber, ['--output-directory', path.join(root, 'out'), 'normal'], {
    cwd: root,
    env,
    timeout: 60_000,
  });
  const bbl = await readFile(path.join(root, 'out', 'normal.bbl'));
  if (!bbl.length || normal.stderr.includes('ERROR -'))
    throw new Error(`Normal Biber fixture failed: ${normal.stderr}`);
  await writeFile(
    path.join(root, 'tool.bib'),
    '@book{test,author={Example, Alice},title={Test},year={2024}}\n',
  );
  const tool = await run(
    biber,
    ['--tool', '--output-directory', path.join(root, 'out'), 'tool.bib'],
    { cwd: root, env, timeout: 60_000 },
  );
  const output = await readFile(path.join(root, 'out', 'tool_bibertool.bib'));
  if (!output.length || tool.stderr.includes('ERROR -'))
    throw new Error(`Tool Biber fixture failed: ${tool.stderr}`);
  console.log(
    JSON.stringify(
      {
        passed: true,
        biber: (await run(biber, ['--version'], { env })).stdout.trim(),
        normalBbl: { bytes: bbl.length, sha256: digest(bbl) },
        toolBib: { bytes: output.length, sha256: digest(output) },
        sourceFixture: 'biber 2.17 t/tdata/basic-misc.bcf + examples.bib',
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
