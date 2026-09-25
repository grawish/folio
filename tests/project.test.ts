import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprint, ProjectStore, safeRelative, validateProject } from '../electron/core/project';
import { parseDiagnostics } from '../electron/core/diagnostics';
import type { Project } from '../src/shared/types';

const example = (): Project => ({
  id: 'test-project',
  name: 'Resume',
  revision: 0,
  mainFile: 'main.tex',
  files: [
    { path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}Test\\end{document}' },
  ],
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-test-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  return { root, project, store: new ProjectStore(path.join(root, 'app')) };
}

test('project validation rejects traversal, hidden files, collisions, and missing entry files', () => {
  for (const name of [
    '../secret.tex',
    '/etc/passwd',
    'a/../../x.tex',
    'a\\b.tex',
    'a//b.tex',
    '.env',
    'C:/x.tex',
    'a\0.tex',
  ])
    assert.throws(() => safeRelative(name));
  assert.equal(safeRelative('sections/experience.tex'), 'sections/experience.tex');
  assert.throws(() => validateProject({ ...example(), mainFile: 'missing.tex' }));
  assert.throws(() =>
    validateProject({
      ...example(),
      files: [...example().files, { path: 'MAIN.tex', content: '' }],
    }),
  );
});
test('fingerprint catches unsaved content and main-file changes even if revision is unchanged', () => {
  const p = example();
  assert.notEqual(
    fingerprint(p),
    fingerprint({ ...p, files: [{ path: 'main.tex', content: 'changed' }] }),
  );
  assert.equal(fingerprint(p), fingerprint({ ...p, revision: 99 }));
});
test('save refuses external changes, explicit overwrite succeeds, and recovery preserves the original conflict baseline', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.project, 'main.tex'), example().files[0].content);
    const p = await f.store.open(f.project);
    p.files[0].content += '\n% editor change';
    p.revision++;
    await f.store.recover(p);
    await fs.writeFile(path.join(f.project, 'main.tex'), '% external change');
    const restarted = new ProjectStore(path.join(f.root, 'app'));
    const recovered = await restarted.loadRecovery();
    assert.ok(recovered);
    assert.equal((await restarted.save(recovered)).conflict, true);
    assert.equal(await fs.readFile(path.join(f.project, 'main.tex'), 'utf8'), '% external change');
    assert.equal((await restarted.save(recovered, undefined, true)).conflict, false);
    assert.equal(await fs.readFile(path.join(f.project, 'main.tex'), 'utf8'), p.files[0].content);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test('opening a project rejects a symlink into unrelated files', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'private.tex'), 'private');
    await fs.symlink(path.join(f.root, 'private.tex'), path.join(f.project, 'main.tex'));
    await assert.rejects(f.store.open(f.project), /symbolic links/);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test('Save As preserves project assets without replacing existing files', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.project, 'main.tex'), example().files[0].content);
    await fs.mkdir(path.join(f.project, 'assets'));
    await fs.writeFile(path.join(f.project, 'assets/photo.png'), 'image-placeholder');
    const p = await f.store.open(f.project);
    const target = path.join(f.root, 'copy');
    await fs.mkdir(target);
    await f.store.save(p, target);
    assert.equal(
      await fs.readFile(path.join(target, 'assets/photo.png'), 'utf8'),
      'image-placeholder',
    );
    assert.equal(
      await fs.readFile(path.join(f.project, 'main.tex'), 'utf8'),
      example().files[0].content,
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test('diagnostics only assign source locations when the compiler provides them', () => {
  const diagnostics = parseDiagnostics(
    'error: main.tex:17: Undefined control sequence.\nwarning: Missing character\nnote: done',
  );
  assert.deepEqual(diagnostics, [
    { severity: 'error', file: 'main.tex', line: 17, message: 'Undefined control sequence.' },
    { severity: 'warning', message: 'Missing character' },
  ]);
});

test('font tracing and many warnings cannot hide compiler errors', () => {
  const log = [
    'warning: fonts.sty:10:',
    'warning: fonts.sty:10: Requested font "Roboto" at 10pt',
    ...Array.from({ length: 80 }, (_, i) => `warning: main.tex:${i + 1}: Overfull box`),
    'error: main.tex:95: Missing package',
  ].join('\n');
  const diagnostics = parseDiagnostics(log);
  assert.equal(diagnostics.length, 60);
  assert.deepEqual(diagnostics[0], {
    severity: 'error',
    file: 'main.tex',
    line: 95,
    message: 'Missing package',
  });
  assert.ok(diagnostics.every((d) => d.message && !d.message.startsWith('Requested font')));
});

test('Tectonic locations with extensionless included filenames stay source-linked', () => {
  assert.deepEqual(parseDiagnostics('error: sections/body:1: Undefined control sequence.'), [
    { severity: 'error', file: 'sections/body', line: 1, message: 'Undefined control sequence.' },
  ]);
  assert.deepEqual(
    parseDiagnostics(
      'warning: sections/body:1: Requested font "Example"\nwarning: main.tex:1: -> cmmi9',
    ),
    [],
  );
});
