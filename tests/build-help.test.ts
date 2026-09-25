import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHelp } from '../src/shared/build-help';
import { parseDiagnostics } from '../electron/core/diagnostics';
import type { BuildResult } from '../src/shared/types';

function failure(log: string): BuildResult {
  return {
    projectId: 'sample',
    revision: 1,
    status: 'error',
    durationMs: 10,
    log,
    diagnostics: parseDiagnostics(log),
  };
}

test('real compiler message forms distinguish missing packages, classes, files and fonts', () => {
  for (const [name, kind] of [
    ['folio-unavailable.sty', 'package'],
    ['my-resume.cls', 'package'],
    ['sections/experience.tex', 'file'],
    ['images/photo.png', 'file'],
    ['fonts/My Font.otf', 'font'],
    ['fonts/My Font.ttf', 'font'],
  ]) {
    const result = failure(`error: main.tex:2: ! LaTeX Error: File \`${name}' not found.`);
    const original = structuredClone(result);
    assert.equal(buildHelp(result)?.kind, kind);
    assert.ok(buildHelp(result)?.title.includes(name));
    assert.deepEqual(
      result,
      original,
      'guidance must not replace or alter source-linked diagnostics',
    );
  }
  const font = buildHelp(
    failure(
      'error: main.tex:3: Package fontspec Error: The font "Folio Missing Font" cannot be found.',
    ),
  );
  assert.equal(font?.kind, 'font');
  assert.match(font?.steps.join(' ') ?? '', /lmroman10-regular\.otf/);
});

test('iftex raw output identifies the required engine without inventing a source link', () => {
  for (const name of ['LuaTeX', 'pdfTeX', 'LuaLaTeX', 'pdfLaTeX']) {
    const result = failure(
      `error: something bad happened inside XeTeX; its output follows:\n\n ********\n * ${name} is required to compile this document.\n * Sorry!\n ********\nerror: the XeTeX engine had an unrecoverable error`,
    );
    assert.equal(buildHelp(result)?.kind, 'engine');
    assert.ok(buildHelp(result)?.title.endsWith(name));
    assert.equal(result.diagnostics[0].file, undefined);
  }
});

test('generic engine crashes and engine names in source excerpts are not compatibility diagnoses', () => {
  for (const log of [
    'error: the XeTeX engine had an unrecoverable error',
    'error: something bad happened inside XeTeX; its output follows:\nl.2 \\RequireLuaTeX',
    'error: main.tex:4: \\typeout{LuaTeX is required to compile this document.}',
    "error: unfamiliar error\nwarning: File `missing.sty' not found.",
  ])
    assert.equal(buildHelp(failure(log)), undefined);
});

test('success, cancellation and runtime unavailability never get document repair advice', () => {
  const result = failure('error: main.tex:3: Undefined control sequence');
  assert.equal(buildHelp({ ...result, status: 'success' }), undefined);
  assert.equal(buildHelp({ ...result, status: 'cancelled' }), undefined);
  assert.equal(buildHelp({ ...result, runtimeUnavailable: true }), undefined);
  assert.equal(buildHelp(null), undefined);
});

test('syntax and bounded build timeouts give different next steps', () => {
  assert.equal(buildHelp(failure('error: main.tex:3: Undefined control sequence'))?.kind, 'syntax');
  assert.equal(
    buildHelp(
      failure(
        'error: Compilation exceeded the 30-second time limit. Simplify the document and try again.',
      ),
    )?.kind,
    'limit',
  );
});

test('long filenames are bounded in advice while the full diagnostic stays intact', () => {
  const filename = `${'long-name/'.repeat(40)}resume.sty`;
  const result = failure(`error: main.tex:2: File \`${filename}' not found.`);
  assert.equal(buildHelp(result)?.kind, 'package');
  assert.ok((buildHelp(result)?.title.length ?? 0) < 210);
  assert.ok(result.diagnostics[0].message.includes(filename));
});
