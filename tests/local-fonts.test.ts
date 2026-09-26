import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { checkFont, fontByteLimit, fontProject, readLocalFont } from '../electron/core/local-fonts';
import { FontImport } from '../electron/core/font-import';
import { ProjectStore } from '../electron/core/project';
import { SaveTransactions } from '../electron/core/save-transactions';
import type { BuildResult, Project } from '../src/shared/types';

function container() {
  // A minimal table wrapper for boundary tests; never advertised as a renderable font.
  const bytes = Buffer.alloc(72);
  bytes.writeUInt32BE(0x4f54544f);
  bytes.writeUInt16BE(3, 4);
  for (const [index, tag] of ['cmap', 'head', 'name'].entries()) {
    const at = 12 + index * 16;
    bytes.write(tag, at);
    bytes.writeUInt32BE(60 + index * 4, at + 8);
    bytes.writeUInt32BE(4, at + 12);
  }
  return bytes;
}
const sample: Project = {
  id: 'font-test',
  name: 'Sample',
  revision: 0,
  mainFile: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: '\\documentclass{article}\n\\begin{document}Sample\\end{document}',
    },
  ],
};
const font = () =>
  new Map([
    ['regular' as const, { name: 'My font.otf', extension: 'otf' as const, data: container() }],
  ]);
async function fixture(t: { after(action: () => Promise<void>): void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-fonts-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'project'),
    data = path.join(root, 'data');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'main.tex'), sample.files[0].content);
  const store = new ProjectStore(data),
    project = await store.open(folder);
  await store.save(project);
  return { root, folder, data, store, project };
}

test('font container checks reject truncation, web/collection formats, duplicate and out-of-range tables', () => {
  checkFont(container());
  const trueType = container();
  trueType.writeUInt32BE(0x00010000);
  checkFont(trueType);
  for (const mutate of [
    (b: Buffer) => b.subarray(0, 10),
    (b: Buffer) => {
      b.write('ttcf');
      return b;
    },
    (b: Buffer) => {
      b.write('wOF2');
      return b;
    },
    (b: Buffer) => {
      b.writeUInt16BE(50, 4);
      return b;
    },
    (b: Buffer) => {
      b.write('cmap', 28);
      return b;
    },
    (b: Buffer) => {
      b.writeUInt32BE(0xffffffff, 20);
      return b;
    },
    (b: Buffer) => {
      b[12] = 0xe1;
      return b;
    },
    (b: Buffer) => {
      b.write('test', 12);
      return b;
    },
  ])
    assert.throws(() => checkFont(mutate(container())));
});

test('native font reads accept selected files and reject links, pipes, directories and oversized files', async (t) => {
  const f = await fixture(t),
    chosen = path.join(f.root, 'My résumé.OTF');
  await fs.writeFile(chosen, container());
  const read = await readLocalFont(chosen);
  assert.equal(read.name, 'My résumé.OTF');
  assert.deepEqual(read.data, container());
  const linked = path.join(f.root, 'link.otf');
  await fs.symlink(chosen, linked);
  await assert.rejects(readLocalFont(linked));
  const directory = path.join(f.root, 'directory.ttf');
  await fs.mkdir(directory);
  await assert.rejects(readLocalFont(directory), /regular font/);
  const large = path.join(f.root, 'large.ttf');
  await fs.writeFile(large, '');
  await fs.truncate(large, fontByteLimit + 1);
  await assert.rejects(readLocalFont(large), /20 MB/);
  if (process.platform !== 'win32') {
    const pipe = path.join(f.root, 'pipe.ttf');
    execFileSync('mkfifo', [pipe]);
    await assert.rejects(readLocalFont(pipe), /regular font/);
  }
});

test('font setup skips commented and nested document starts and never inserts original filenames into TeX', () => {
  const p = structuredClone(sample);
  p.files[0].content =
    '% \\begin{document}\n\\newcommand{\\example}{\\begin{document}}\n' + sample.files[0].content;
  const fonts = font();
  fonts.get('regular')!.name = 'bad}\n\\input{/private/file}.otf';
  const next = fontProject(p, randomUUID(), fonts, 'body');
  assert.match(
    next.project.files[0].content,
    /\\input\{fonts\/folio-[\w-]+\/font-setup.tex\}\n\\begin\{document\}Sample/,
  );
  assert.doesNotMatch(next.project.files[1].content, /private\/file/);
  assert.match(next.project.files[1].content, /setmainfont/);
  assert.match(next.project.files[1].content, /setsansfont/);
  assert.equal(p.files.length, 1);
  assert.throws(
    () =>
      fontProject(
        { ...p, files: [{ path: 'main.tex', content: '% no document' }] },
        randomUUID(),
        fonts,
        'body',
      ),
    /plain/,
  );
});

test('font assets and source save together, remain available to Save As and respect external edits', async (t) => {
  const f = await fixture(t),
    next = fontProject(f.project, randomUUID(), font(), 'body');
  assert.equal((await f.store.saveWithAssets(next.project, next.assets)).conflict, false);
  assert.equal((await f.store.inspectChanges(f.project.id))!.changes.length, 0);
  for (const [name, bytes] of next.assets)
    assert.deepEqual(await fs.readFile(path.join(f.folder, name)), bytes);
  const copy = path.join(f.root, 'copy');
  await fs.mkdir(copy);
  const copied = await f.store.save(next.project, copy);
  assert.notEqual(copied.projectId, f.project.id);
  for (const [name, bytes] of next.assets)
    assert.deepEqual(await fs.readFile(path.join(copy, name)), bytes);
  await fs.writeFile(path.join(f.folder, 'main.tex'), 'Outside edit');
  const newer = fontProject(next.project, randomUUID(), font(), 'body');
  assert.equal((await f.store.saveWithAssets(newer.project, newer.assets)).conflict, true);
  assert.equal(await fs.readFile(path.join(f.folder, 'main.tex'), 'utf8'), 'Outside edit');
  for (const name of newer.assets.keys())
    await assert.rejects(fs.access(path.join(f.folder, name)));
});

test('font saves reject size and filename conflicts and roll back new font bytes after a write failure', async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => f.store.saveWithAssets(f.project, new Map([['main.tex', container()]])),
    /Unsupported asset|Unsupported project asset/,
  );
  assert.throws(
    () =>
      f.store.saveWithAssets(
        f.project,
        new Map([['too-large.otf', Buffer.alloc(25 * 1024 * 1024 + 1)]]),
      ),
    /size limit/,
  );
  const next = fontProject(f.project, randomUUID(), font(), 'body');
  const broken = new ProjectStore(
    f.data,
    new SaveTransactions(f.data, {
      afterApply: async (index) => {
        if (index === 2) throw new Error('Disk full fixture');
      },
    }),
  );
  await broken.open(f.folder);
  await assert.rejects(
    broken.saveWithAssets(next.project, next.assets),
    /previous files were restored/,
  );
  assert.equal(
    await fs.readFile(path.join(f.folder, 'main.tex'), 'utf8'),
    f.project.files[0].content,
  );
  for (const name of [next.setupFile, ...next.assets.keys()])
    await assert.rejects(fs.access(path.join(f.folder, name)));
  assert.equal((await broken.inspectChanges(f.project.id))!.changes.length, 0);
  // Rollback may retain empty directories. Use a fresh project so the case
  // conflict exists on both case-sensitive and case-insensitive volumes.
  const other = await fixture(t);
  await fs.mkdir(path.join(other.folder, 'Fonts'));
  await fs.writeFile(path.join(other.folder, 'Fonts/existing.otf'), container());
  const registered = await other.store.open(other.folder);
  const cased = fontProject(registered, randomUUID(), font(), 'body');
  await assert.rejects(other.store.saveWithAssets(cased.project, cased.assets), /folder spelling/);
});

test('font source and binary additions recover together after real process termination', async (t) => {
  const f = await fixture(t);
  for (const stage of ['applying', 'committed']) {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/fixtures/font-crash.ts', f.data, f.folder, stage],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      stderr = '';
    child.stderr.on('data', (b) => {
      stderr += b;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Font save did not reach its kill boundary: ' + stderr));
      }, 15000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on('data', (b) => {
        output += b;
        if (output.includes('READY-TO-KILL')) child.kill('SIGKILL');
      });
      child.on('exit', (_, signal) => {
        clearTimeout(timer);
        if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
        else reject(new Error(stderr));
      });
    });
    const reopened = await new ProjectStore(f.data).open(f.folder);
    if (stage === 'applying') {
      assert.equal(reopened.files[0].content, f.project.files[0].content);
      await assert.rejects(fs.access(path.join(f.folder, 'fonts/fixture.otf')));
    } else {
      assert.match(
        reopened.files.find((file) => file.path === 'main.tex')!.content,
        /FONT-SAVE-COMMITTED/,
      );
      assert.deepEqual(
        await fs.readFile(path.join(f.folder, 'fonts/fixture.otf')),
        Buffer.from([0, 1, 2, 255]),
      );
    }
  }
});

test('font preview does not write, rejects stale source/assets and cancellation prevents publication', async (t) => {
  const f = await fixture(t),
    chosen = path.join(f.root, 'regular.otf');
  await fs.writeFile(chosen, container());
  let files = new Map<string, Buffer>(),
    saves = 0;
  let hold: (() => void) | undefined;
  const preview = new FontImport({
    start: async () => {},
    choose: async () => chosen,
    checkDisk: async () => {},
    assets: async () => files,
    compile: async (project) => {
      if (hold)
        await new Promise<void>((resolve) => {
          hold = resolve;
        });
      return {
        projectId: project.id,
        revision: project.revision,
        status: 'success',
        diagnostics: [],
        durationMs: 0,
        log: '',
        pdf: Buffer.from('%PDF-1.7\nfixture'),
      } as BuildResult;
    },
    cancel: async () => {
      hold?.();
    },
    save: async (project, _, build) => {
      saves++;
      return { project, build };
    },
  });
  const id = randomUUID();
  await preview.begin(id, f.project);
  await preview.choose(id, 'regular');
  await preview.preview(id, f.project, 'body');
  assert.equal(saves, 0);
  assert.throws(() => preview.apply(id, { ...f.project, revision: 3 }), /source changed/);
  files = new Map([['photo.png', Buffer.from('changed')]]);
  await assert.rejects(preview.apply(id, f.project), /assets changed/);
  assert.equal(saves, 0);
  files = new Map();
  await preview.preview(id, f.project, 'body');
  await preview.apply(id, f.project);
  assert.equal(saves, 1);
  preview.requireIdle();
  const cancelled = randomUUID();
  await preview.begin(cancelled, f.project);
  await preview.choose(cancelled, 'regular');
  hold = () => {};
  const pending = preview.preview(cancelled, f.project, 'body');
  await new Promise((resolve) => setImmediate(resolve));
  const failure = assert.rejects(pending, /new font setup/);
  await preview.cancel(cancelled);
  await failure;
  assert.equal(saves, 1);
  preview.requireIdle();
});
