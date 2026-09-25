import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Compiler } from '../electron/core/compiler';
import { paperSizes, templateCatalog, templateSource } from '../src/shared/template-catalog';

if (process.platform !== 'darwin')
  throw new Error('Native compiler isolation is currently verified only on macOS.');
const output = path.resolve('output/pdf/templates');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-templates-')));
const runtime = path.resolve(`resources/runtime/mac-${process.arch}`);
const records = [];
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
await fs.mkdir(output, { recursive: true });
try {
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
      if (result.status !== 'success' || !result.pdf) throw new Error(`${name}: ${result.log}`);
      if (/Overfull|Missing character|Font shape .*undefined|substituted/i.test(result.log))
        throw new Error(`${name}: layout or font warning\n${result.log}`);
      await fs.writeFile(path.join(output, `${name}.pdf`), result.pdf);
      await fs.writeFile(path.join(output, `${name}.tex`), content);
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
  await fs.writeFile(path.join(output, 'corpus.json'), JSON.stringify({ records }, null, 2) + '\n');
  execFileSync(
    process.env.FOLIO_PYTHON ?? 'python3',
    ['scripts/check-template-pdfs.py', output, '--previews', 'public/templates'],
    { stdio: 'inherit' },
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
