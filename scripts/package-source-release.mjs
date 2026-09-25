import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const tag = process.argv[2];
if (!/^source-v\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(tag ?? ''))
  throw new Error('Expected a source-vX.Y.Z[-suffix] tag.');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--untracked-files=no'))
  throw new Error('Release requires a clean tracked tree.');
const commit = git('rev-parse', 'HEAD');
if (git('rev-parse', `${tag}^{commit}`) !== commit)
  throw new Error('Tag does not identify this checkout.');
await fs.mkdir('artifacts', { recursive: true });
const specs = [
  [`Folio-${tag}-source.zip`, []],
  [
    `Folio-${tag}-docs.zip`,
    [
      'docs',
      'README.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_NOTICES.md',
      'public/licenses',
    ],
  ],
  [`Folio-${tag}-skill.zip`, ['skills/folio-resume', 'LICENSE', 'NOTICE']],
];
for (const [name, paths] of specs)
  execFileSync('git', [
    'archive',
    '--format=zip',
    `--prefix=Folio-${tag}/`,
    '-o',
    `artifacts/${name}`,
    tag,
    ...paths,
  ]);
const provenance = {
  tag,
  commit,
  repository: 'https://github.com/grawish/folio',
  kind: 'source-preview',
  createdAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
};
await fs.writeFile('artifacts/provenance.json', JSON.stringify(provenance, null, 2) + '\n');
const names = [...specs.map(([name]) => name), 'provenance.json'];
const lines = [];
for (const name of names)
  lines.push(
    `${createHash('sha256')
      .update(await fs.readFile(`artifacts/${name}`))
      .digest('hex')}  ${name}`,
  );
await fs.writeFile('artifacts/SHA256SUMS', lines.join('\n') + '\n');
console.log(`Packaged ${tag} from ${commit}`);
