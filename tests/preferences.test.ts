import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { PreferenceStore } from '../electron/core/preferences';
import { atomicWrite } from '../electron/core/file-io';
import {
  defaultPreferences,
  validatePreferences,
  validatePreferencePatch,
} from '../src/shared/preferences';
import { PreferenceWrites } from '../src/shared/preference-writes';

const fixture = async (t: TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-preferences-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};
test('first open migrates all existing valid preferences once and keeps native values on reload', async (t) => {
  const root = await fixture(t),
    store = new PreferenceStore(root);
  const legacy = {
    ...defaultPreferences,
    'folio:auto': 'false',
    'folio:autosave': 'true',
    'folio:appearance': 'light',
    'folio:font': '18',
    'folio:panes': '{"sidebar":240,"editorRatio":0.6}',
  };
  assert.deepEqual(await store.initialize(legacy), legacy);
  assert.deepEqual(await new PreferenceStore(root).initialize(defaultPreferences), legacy);
  const returned = await store.initialize(defaultPreferences);
  returned['folio:auto'] = 'true';
  assert.equal((await store.initialize(defaultPreferences))['folio:auto'], 'false');
});
test('concurrent changes preserve every independent setting and complete before flush', async (t) => {
  const root = await fixture(t),
    store = new PreferenceStore(root);
  await store.initialize(defaultPreferences);
  await Promise.all([
    store.update({ 'folio:auto': 'false' }),
    store.update({ 'folio:font': '18' }),
    store.update({ 'folio:appearance': 'system' }),
  ]);
  await store.flush();
  const read = await new PreferenceStore(root).initialize(defaultPreferences);
  assert.equal(read['folio:auto'], 'false');
  assert.equal(read['folio:font'], '18');
  assert.equal(read['folio:appearance'], 'system');
});
test('invalid patches and incomplete snapshots cannot change saved preferences', async (t) => {
  const root = await fixture(t),
    store = new PreferenceStore(root);
  await store.initialize(defaultPreferences);
  const before = await fs.readFile(store.filename);
  for (const bad of [
    null,
    [],
    { extra: 'true' },
    { 'folio:auto': true },
    { 'folio:auto': 'yes' },
    { 'folio:font': 'Infinity' },
    { 'folio:font': '24' },
    { 'folio:appearance': 'auto' },
    { 'folio:panes': '{"sidebar":900,"editorRatio":0.5}' },
    { 'folio:panes': '{"sidebar":null,"editorRatio":0}' },
    { 'folio:panes': '{"sidebar":null,"editorRatio":0.5,"extra":1}' },
    { 'folio:panes': 'x'.repeat(161) },
  ])
    assert.throws(() => store.update(bad));
  assert.throws(() => validatePreferences({ 'folio:auto': 'false' }));
  assert.deepEqual(await fs.readFile(store.filename), before);
});
test('failed replacement preserves committed values and a later retry succeeds', async (t) => {
  const root = await fixture(t);
  let fail = false;
  const store = new PreferenceStore(root, async (file, bytes) => {
    if (fail) throw new Error('fixture disk full');
    await atomicWrite(file, bytes);
  });
  await store.initialize(defaultPreferences);
  fail = true;
  await assert.rejects(store.update({ 'folio:auto': 'false' }), /disk full/);
  assert.deepEqual(
    await new PreferenceStore(root).initialize(defaultPreferences),
    defaultPreferences,
  );
  assert.deepEqual(await store.initialize(defaultPreferences), defaultPreferences);
  fail = false;
  await store.update({ 'folio:auto': 'false' });
  assert.equal(
    (await new PreferenceStore(root).initialize(defaultPreferences))['folio:auto'],
    'false',
  );
});
for (const [name, content] of [
  ['torn', '{"schema":'],
  ['unknown format', JSON.stringify({ schema: 'folio-preferences-9', values: defaultPreferences })],
  [
    'unknown fields',
    JSON.stringify({ schema: 'folio-preferences-1', values: defaultPreferences, extra: 1 }),
  ],
  ['oversized', ' '.repeat(2049)],
])
  test(`preserves ${name} records rather than replacing them with defaults`, async (t) => {
    const root = await fixture(t),
      store = new PreferenceStore(root);
    await fs.writeFile(store.filename, content);
    await assert.rejects(store.initialize(defaultPreferences));
    await store.flush(); // A failed initial read must still allow the unopened app to close.
    assert.equal(await fs.readFile(store.filename, 'utf8'), content);
  });
test('linked settings are rejected without modifying their targets', async (t) => {
  const root = await fixture(t),
    outside = path.join(root, 'original.json'),
    store = new PreferenceStore(root);
  const content = JSON.stringify({ schema: 'folio-preferences-1', values: defaultPreferences });
  await fs.writeFile(outside, content);
  await fs.symlink(outside, store.filename);
  await assert.rejects(store.initialize(defaultPreferences));
  await fs.unlink(store.filename);
  await fs.link(outside, store.filename);
  await assert.rejects(store.initialize(defaultPreferences));
  assert.equal(await fs.readFile(outside, 'utf8'), content);
});
for (const boundary of ['before-commit', 'after-commit', 'acknowledged'])
  test(`a real killed writer at ${boundary} leaves a complete recoverable settings record`, async (t) => {
    const root = await fixture(t);
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/fixtures/preferences-crash.ts', root, boundary],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      stderr = '';
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Preference fixture timeout: ' + stderr));
      }, 10_000);
      child.stdout.on('data', (bytes) => {
        output += bytes;
        if (output.includes('READY-TO-KILL')) child.kill('SIGKILL');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (_code, signal) => {
        clearTimeout(timer);
        if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
        else reject(new Error(stderr));
      });
    });
    await completion;
    const expected =
      boundary === 'before-commit'
        ? defaultPreferences
        : {
            ...defaultPreferences,
            'folio:auto': 'false',
            'folio:appearance': 'light',
            'folio:font': '18',
          };
    assert.deepEqual(await new PreferenceStore(root).initialize(defaultPreferences), expected);
  });
test('slow preference writes coalesce thousands of pane edits without losing other controls', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: ReturnType<typeof validatePreferencePatch>[] = [];
  const writer = new PreferenceWrites(async (patch) => {
    calls.push(patch);
    if (calls.length === 1) await held;
  });
  writer.set({ 'folio:auto': 'false' });
  for (let i = 0; i < 10_000; i++)
    writer.set({ 'folio:panes': JSON.stringify({ sidebar: 200 + (i % 100), editorRatio: 0.6 }) });
  writer.set({ 'folio:font': '18' });
  assert.equal(calls.length, 1);
  release();
  await writer.flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    'folio:panes': '{"sidebar":299,"editorRatio":0.6}',
    'folio:font': '18',
  });
});
test('retry after an asynchronous error retains newer pending values and reports success only after writing', async () => {
  let reject!: (error: Error) => void;
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const calls: ReturnType<typeof validatePreferencePatch>[] = [];
  const writer = new PreferenceWrites(async (patch) => {
    calls.push(patch);
    if (calls.length === 1) await held;
  });
  writer.set({ 'folio:auto': 'false' });
  writer.set({ 'folio:auto': 'true', 'folio:appearance': 'light' });
  reject(new Error('fixture disk full'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(writer.error, /disk full/);
  assert.equal(calls.length, 1);
  writer.set({ 'folio:font': '18' });
  assert.equal(calls.length, 1);
  await writer.flush();
  assert.equal(writer.error, '');
  assert.deepEqual(calls[1], {
    'folio:auto': 'true',
    'folio:appearance': 'light',
    'folio:font': '18',
  });
});
test('flush rejects a repeated write failure and permits a later successful retry', async () => {
  let fail = true;
  const writer = new PreferenceWrites(async () => {
    if (fail) throw new Error('read only');
  });
  writer.set({ 'folio:auto': 'false' });
  await assert.rejects(writer.flush(), /read only/);
  fail = false;
  await writer.flush();
  assert.equal(writer.error, '');
});
