import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Compiler } from '../electron/core/compiler';
import { paperSizes, templateCatalog, templateSource } from '../src/shared/template-catalog';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Run template qualification on an Apple silicon Mac.');
if (process.argv.slice(2).some((arg) => arg !== '--check'))
  throw new Error('Usage: build-template-corpus.ts [--check]');
const check = process.argv.includes('--check');
await fs.mkdir('test-results', { recursive: true });
const output = check
  ? await fs.mkdtemp(path.resolve('test-results/template-regression-'))
  : path.resolve('output/pdf/templates');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-templates-')));
const runtime = path.resolve(`resources/runtime/mac-${process.arch}`);
const records = [];
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const manifestBytes = await fs.readFile(path.join(runtime, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const provenance = {
  platform: `${process.platform}-${process.arch}`,
  kernel: os.release(),
  node: process.version,
  runtime: {
    version: manifest.version,
    bundle: manifest.bundle,
    biberVersion: manifest.biberVersion,
    resourceCount: manifest.resourceCount,
    manifestSha256: hash(manifestBytes),
  },
  files: Object.fromEntries(
    await Promise.all(
      [
        'electron/core/compiler.ts',
        'electron/core/runtime.ts',
        'scripts/build-template-corpus.ts',
        'scripts/check-template-pdfs.py',
        'scripts/template_image_diff.py',
        'tests/template-image-diff.py',
      ].map(async (file) => [file, hash(await fs.readFile(file))]),
    ),
  ),
};
await fs.mkdir(output, { recursive: true });
try {
  if (check)
    execFileSync(process.env.FOLIO_PYTHON ?? 'python3', ['tests/template-image-diff.py'], {
      stdio: 'inherit',
    });
  for (const template of templateCatalog) {
    const source = await fs.readFile(`resources/templates/${template.id}.tex`, 'utf8');
    for (const paper of paperSizes) {
      const name = `${template.id}-${paper.id}`;
      const content = templateSource(source, paper.id);
      // Each variant gets its own empty cache; the production compiler denies
      // networking and only allows resources from its packaged runtime.
      const compiler = new Compiler(runtime, path.join(temporary, name));
      const result = await compiler.compile({
        id: name,
        name,
        mainFile: 'main.tex',
        revision: 0,
        templateId: template.id,
        templateVersion: template.version,
        files: [{ path: 'main.tex', content }],
      });
      await fs.writeFile(path.join(output, `${name}.log`), result.log);
      await fs.writeFile(path.join(output, `${name}.tex`), content);
      if (result.status !== 'success' || !result.pdf) throw new Error(`${name}: ${result.log}`);
      if (/Overfull|Missing character|Font shape .*undefined|substituted/i.test(result.log))
        throw new Error(`${name}: layout or font warning\n${result.log}`);
      await fs.writeFile(path.join(output, `${name}.pdf`), result.pdf);
      records.push({
        name,
        template,
        paper,
        sourceHash: hash(content),
        pdfHash: hash(result.pdf),
        durationMs: result.durationMs,
      });
      console.log(`Compiled offline with a fresh cache: ${name}`);
    }
  }
  await fs.writeFile(
    path.join(output, 'corpus.json'),
    JSON.stringify({ provenance, records }, null, 2) + '\n',
  );
  execFileSync(
    process.env.FOLIO_PYTHON ?? 'python3',
    [
      'scripts/check-template-pdfs.py',
      output,
      check ? '--compare' : '--previews',
      'public/templates',
    ],
    { stdio: 'inherit' },
  );
  for (const [file, expected] of Object.entries(provenance.files))
    if (hash(await fs.readFile(file)) !== expected)
      throw new Error(`The qualification input changed while running: ${file}`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
  if (check) console.log(`Evidence: ${output}`);
}
