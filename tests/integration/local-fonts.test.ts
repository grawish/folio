import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { Compiler } from '../../electron/core/compiler';
import {
  checkFont,
  fontProject,
  readLocalFont,
  type LocalFont,
} from '../../electron/core/local-fonts';
import { templateCatalog, paperSizes, templateSource } from '../../src/shared/template-catalog';
import type { FontStyle } from '../../src/shared/fonts';

test(
  'local font files build all twelve template variants offline with regular, bold and italic styles',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-font-corpus-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const runtime = path.resolve(`resources/runtime/mac-${process.arch}`);
    const bundle = unzipSync(await fs.readFile(path.join(runtime, 'bundle.zip')));
    const fonts = new Map<FontStyle, LocalFont>();
    for (const [style, name] of [
      ['regular', 'Roboto-Regular.otf'],
      ['bold', 'Roboto-Bold.otf'],
      ['italic', 'Roboto-Italic.otf'],
      ['boldItalic', 'Roboto-BoldItalic.otf'],
    ] as const) {
      const bytes = Buffer.from(bundle[name]);
      checkFont(bytes);
      fonts.set(style, { name, extension: 'otf', data: bytes });
    }
    for (const template of templateCatalog) {
      const source = await fs.readFile(`resources/templates/${template.id}.tex`, 'utf8');
      for (const paper of paperSizes) {
        const next = fontProject(
          {
            id: 'local-fonts',
            name: 'Font sample',
            revision: 0,
            mainFile: 'main.tex',
            files: [{ path: 'main.tex', content: templateSource(source, paper.id) }],
          },
          randomUUID(),
          fonts,
          'body',
        );
        const compiler = new Compiler(runtime, path.join(root, `${template.id}-${paper.id}`));
        const result = await compiler.compile(next.project, next.assets);
        assert.equal(result.status, 'success', `${template.id}/${paper.id}\n${result.log}`);
        assert.ok(result.pdf && result.pdf.length > 5000);
        assert.doesNotMatch(
          result.log,
          /cannot be found|not loadable|Missing character|Font shape .*undefined/,
        );
      }
    }
  },
);

test(
  'a real locally selected TrueType file compiles without a system-font lookup',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ttf-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    // Read only for this macOS test; this OS font is never added to source or releases.
    const font = await readLocalFont('/System/Library/Fonts/Supplemental/Arial.ttf');
    const next = fontProject(
      {
        id: 'ttf-test',
        name: 'TTF sample',
        revision: 0,
        mainFile: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content:
              '\\documentclass{article}\n\\begin{document}Local font \\textbf{bold} \\textit{italic}\\end{document}',
          },
        ],
      },
      randomUUID(),
      new Map([['regular', font]]),
      'body',
    );
    const compiler = new Compiler(
      path.resolve(`resources/runtime/mac-${process.arch}`),
      path.join(root, 'builds'),
    );
    const result = await compiler.compile(next.project, next.assets);
    assert.equal(result.status, 'success', result.log);
    assert.ok(result.pdf && result.pdf.length > 1000);
  },
);
