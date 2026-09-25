import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectStore } from '../electron/core/project';
import { defaultPanes, paneLayout, readPanes } from '../src/shared/workspace-layout';

test('pane preferences preserve usable writing/PDF widths when the window shrinks or sidebar closes', () => {
  for (const width of [680, 1040, 1480, 2560]) {
    for (const open of [false, true]) {
      for (const preferences of [
        defaultPanes,
        { sidebar: 360, editorRatio: 0.9 },
        { sidebar: 176, editorRatio: 0.1 },
      ]) {
        const layout = paneLayout(width, open, preferences);
        assert.ok(layout.editor >= 360);
        assert.ok(layout.preview >= 420);
        assert.ok(!open || layout.sidebar >= 176);
        const actual = layout.sidebar + layout.editor + layout.preview + (open ? 12 : 6);
        assert.equal(actual, Math.max(width, open ? 968 : 786));
      }
    }
  }
  for (const invalid of [
    'bad JSON',
    '{}',
    '{"sidebar":0,"editorRatio":0.5}',
    '{"sidebar":200,"editorRatio":2}',
  ])
    assert.deepEqual(readPanes(invalid), defaultPanes);
  assert.deepEqual(readPanes('{"sidebar":280,"editorRatio":0.6}'), {
    sidebar: 280,
    editorRatio: 0.6,
  });
});

test('autosave writes an existing project and rejects every outside-change class without acknowledging it', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-autosave-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'main.tex'), 'Original source');
  await fs.writeFile(path.join(directory, 'photo.png'), 'Original asset');
  const store = new ProjectStore(path.join(root, 'data'));
  const original = await store.open(directory);
  const edited = {
    ...original,
    revision: 1,
    files: [{ path: 'main.tex', content: 'Edited source' }],
  };
  assert.equal((await store.save(edited, undefined, false, undefined, true)).conflict, false);
  assert.equal(await fs.readFile(path.join(directory, 'main.tex'), 'utf8'), 'Edited source');
  for (const name of ['main.tex', 'photo.png', 'resume.project.json', 'new.tex', 'resume.folio']) {
    const target = path.join(directory, name);
    const before = await fs.readFile(target).catch(() => null);
    const manifest = await fs.readFile(path.join(directory, 'resume.project.json'));
    await fs.writeFile(target, 'External edit');
    const result = await store.save(
      { ...edited, revision: 2, name: 'Autosave must not commit' },
      undefined,
      false,
      undefined,
      true,
    );
    assert.equal(result.conflict, true, name);
    assert.equal(await fs.readFile(target, 'utf8'), 'External edit');
    if (name !== 'resume.project.json')
      assert.deepEqual(await fs.readFile(path.join(directory, 'resume.project.json')), manifest);
    assert.ok((await store.inspectChanges(edited.id))!.changes.some((item) => item.path === name));
    if (before) await fs.writeFile(target, before);
    else await fs.unlink(target);
  }
  await fs.unlink(path.join(directory, 'photo.png'));
  assert.equal((await store.save(edited, undefined, false, undefined, true)).conflict, true);
  await assert.rejects(
    store.save({ ...edited, id: 'unregistered' }, undefined, false, undefined, true),
    /Save this project once/,
  );
  await assert.rejects(
    store.save(edited, undefined, true, undefined, true),
    /Save this project once/,
  );
  await assert.rejects(
    store.save(edited, directory, false, undefined, true),
    /Save this project once/,
  );
});

test('autosave checks disk after queued saves and keeps source intact if history preparation fails', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-autosave-queue-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.tex'), 'Original');
  const store = new ProjectStore(path.join(root, 'data'));
  const project = await store.open(root);
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = store.save(project, undefined, false, async () => {
    started();
    await gate;
    return Buffer.from('History');
  });
  await ready;
  const second = store.save(
    {
      ...project,
      revision: 1,
      files: [{ path: 'main.tex', content: 'Do not replace outside source' }],
    },
    undefined,
    false,
    undefined,
    true,
  );
  await fs.writeFile(path.join(root, 'added.tex'), 'Outside addition during earlier save');
  release();
  await first;
  assert.equal((await second).conflict, true);
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'Original');
  await fs.unlink(path.join(root, 'added.tex'));
  await assert.rejects(
    store.save(
      { ...project, files: [{ path: 'main.tex', content: 'New' }] },
      undefined,
      false,
      async () => {
        throw new Error('History unavailable');
      },
      true,
    ),
    /History unavailable/,
  );
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'Original');
});
