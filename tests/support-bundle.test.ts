import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { SupportBundles, validateSupportContext } from '../electron/core/support-bundle';
import { supportSnapshot, type SupportContext } from '../src/shared/support';
import { emptyWorkspace, type AISettings } from '../src/shared/ai';
import type { BuildResult, Project, RuntimeStatus } from '../src/shared/types';

const secret = 'SyntheticPrivateMarker',
  userPath = '/Users/SyntheticOwner/private.tex';
const project: Project = {
  id: secret,
  name: secret,
  directory: '/Users/SyntheticOwner/resume',
  mainFile: `${secret}.tex`,
  revision: 4,
  files: [
    {
      path: `${secret}.tex`,
      content: `\\documentclass{article} ${secret} owner@example.invalid sk-test-private`,
    },
  ],
};
const build: BuildResult = {
  projectId: secret,
  revision: 4,
  status: 'error',
  durationMs: 320,
  log: `${userPath}\n${secret}\nHOME=/Users/SyntheticOwner\nAPI_KEY=sk-test-private`,
  diagnostics: [
    { severity: 'error', message: `File '${secret}.sty' not found`, file: userPath, line: 12 },
  ],
};
const runtime: RuntimeStatus = {
  ready: true,
  engine: secret,
  bundle: secret,
  platform: 'darwin-arm64',
  message: userPath,
  isolation: 'macos-seatbelt',
  canRepair: true,
  pin: {
    engine: 'tectonic',
    version: '0.17.0',
    bundle: secret,
    id: 'a'.repeat(64),
    platform: 'darwin-arm64',
  },
  defaultPin: {
    engine: 'tectonic',
    version: '0.17.0',
    bundle: secret,
    id: 'a'.repeat(64),
    platform: 'darwin-arm64',
  },
};
const connections: AISettings = {
  activeId: secret,
  connections: [
    {
      id: secret,
      name: secret,
      kind: 'custom',
      model: secret,
      baseUrl: 'https://private.example.invalid/v1',
      executable: userPath,
      format: 'responses',
      hasKey: true,
      vision: 'verified',
    },
  ],
};
const workspace = emptyWorkspace(secret);
workspace.messages.push({
  id: secret,
  text: secret,
  role: 'user',
  createdAt: new Date().toISOString(),
  annotationIds: [],
});
workspace.draft = secret;
const snapshot = () =>
  supportSnapshot({
    project,
    result: build,
    runtime,
    workspace,
    connections,
    appearance: 'dark',
    autoSave: false,
    autoCompile: true,
    dirty: true,
    needsDiskReview: false,
  });
const system = () => ({
  app: '0.1.0',
  electron: '44.4.5',
  chromium: '142.0.123.0',
  node: '24.21.0',
  kernel: '27.0.0',
  architecture: 'arm64',
  platform: 'darwin',
  packaged: true,
  env: { HOME: userPath, API_KEY: secret },
  username: secret,
});
function fixture() {
  let chosen: string | undefined = '/tmp/folio-support-test.zip';
  let failure = false;
  const writes: Uint8Array[] = [];
  const bundles = new SupportBundles({
    system,
    choose: async () => chosen,
    write: async (_, bytes) => {
      if (failure) throw new Error('Synthetic failed write');
      writes.push(bytes);
    },
  });
  return {
    bundles,
    writes,
    choose: (path?: string) => {
      chosen = path;
    },
    fail: (value: boolean) => {
      failure = value;
    },
  };
}
const assertPrivate = (text: string) => {
  for (const marker of [
    secret,
    'SyntheticOwner',
    '/Users/',
    'example.invalid',
    'sk-test-private',
    'API_KEY=',
    'HOME=',
  ])
    assert.ok(!text.includes(marker), `Leaked ${marker}`);
};

test('support snapshot excludes source, diagnostics, paths, connection identities and environment text before IPC', () => {
  const value = snapshot();
  assertPrivate(JSON.stringify(value));
  assert.equal(value.compiler.problem, 'package');
  assert.equal(value.compiler.errors, 1);
  assert.equal(value.compiler.buildMatchesSource, true);
  assert.equal(value.workspace.sourceBytes, Buffer.byteLength(project.files[0].content));
  assert.equal(value.ai.activeKind, 'custom');
  const stale = supportSnapshot({
    project,
    result: { ...build, revision: 3 },
    runtime,
    workspace,
    connections,
    appearance: 'dark',
    autoSave: false,
    autoCompile: true,
    dirty: true,
    needsDiskReview: true,
  });
  assert.equal(stale.compiler.buildMatchesSource, false);
});

test('native validation drops arbitrary extra fields and rejects text in allowed numeric/enum/boolean fields', () => {
  const raw = snapshot() as SupportContext & { log: string };
  raw.log = secret;
  Object.assign(raw.compiler, { log: secret, path: userPath });
  Object.assign(raw.workspace, { files: project.files, username: secret });
  Object.assign(raw.ai, { model: secret, key: secret });
  assertPrivate(JSON.stringify(validateSupportContext(raw)));
  for (const [section, field, value] of [
    ['compiler', 'durationMs', userPath],
    ['compiler', 'durationMs', Infinity],
    ['compiler', 'errors', -1],
    ['compiler', 'problem', secret],
    ['compiler', 'state', secret],
    ['workspace', 'saved', secret],
    ['workspace', 'sourceFiles', 101],
    ['workspace', 'sourceBytes', 6 * 1024 * 1024],
    ['workspace', 'notes', 1.5],
    ['ai', 'activeKind', secret],
    ['ai', 'apiFormat', secret],
    ['ai', 'configured', 31],
  ] as const) {
    const input = structuredClone(raw) as unknown as Record<string, Record<string, unknown>>;
    input[section][field] = value;
    assert.throws(() => validateSupportContext(input), /Invalid support/);
  }
  raw.compiler.version = secret;
  assert.equal(validateSupportContext(raw).compiler.version, null);
});

test('support ZIP contains exactly the selected reviewed bytes, with immutable snapshots and no hidden files', async () => {
  const f = fixture(),
    preview = f.bundles.prepare(snapshot());
  const reviewed = structuredClone(preview);
  assertPrivate(JSON.stringify(preview));
  preview.files[0].text = secret;
  assert.equal(await f.bundles.export(preview.id, ['app', 'compiler']), true);
  const files = unzipSync(f.writes[0]);
  assert.deepEqual(Object.keys(files), ['app.json', 'compiler.json']);
  for (const file of reviewed.files.slice(0, 2))
    assert.equal(strFromU8(files[file.name]), file.text);
  assertPrivate(
    Object.values(files)
      .map((bytes) => strFromU8(bytes))
      .join('\n'),
  );
  const renewed = f.bundles.prepare(snapshot());
  assert.throws(() => f.bundles.export(preview.id, ['app']), /new support preview/);
  for (const selected of [
    [],
    ['app', 'app'],
    ['../private'],
    ['unknown'],
    null,
    ['app', 'compiler', 'workspace', 'ai', 'app'],
  ])
    assert.throws(() => f.bundles.export(renewed.id, selected), /valid support section/);
  await f.bundles.cancel(renewed.id);
  assert.throws(() => f.bundles.export(renewed.id, ['app']), /new support preview/);
});

test('cancelled picker and failed export permit retry without creating a new unreviewed snapshot', async () => {
  const f = fixture(),
    preview = f.bundles.prepare(snapshot());
  f.choose();
  assert.equal(await f.bundles.export(preview.id, ['workspace']), false);
  assert.equal(f.writes.length, 0);
  f.choose('/tmp/folio-support-test.zip');
  f.fail(true);
  await assert.rejects(f.bundles.export(preview.id, ['workspace']), /failed write/);
  f.fail(false);
  assert.equal(await f.bundles.export(preview.id, ['workspace']), true);
  assert.equal(
    strFromU8(unzipSync(f.writes[0])['workspace.json']),
    preview.files.find((f) => f.id === 'workspace')!.text,
  );
});

test('close waits for export; concurrent changes cannot replace the reviewed archive, and old cleanup cannot erase a new preview', async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const written: Uint8Array[] = [];
  const bundles = new SupportBundles({
    system,
    choose: async () => '/tmp/folio-support-test.zip',
    write: async (_, bytes) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      written.push(bytes);
    },
  });
  const first = bundles.prepare(snapshot());
  const saving = bundles.export(first.id, ['compiler']);
  await started;
  assert.throws(() => bundles.prepare(snapshot()), /finish saving/);
  assert.throws(() => bundles.export(first.id, ['ai']), /finish saving/);
  let closed = false;
  const closing = bundles.cancel(first.id).then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await saving;
  await closing;
  assert.equal(written.length, 1);
  assert.throws(() => bundles.export(first.id, ['compiler']), /new support preview/);
  const old = bundles.prepare(snapshot());
  const cleanup = bundles.cancel(old.id);
  const next = bundles.prepare(snapshot());
  await cleanup;
  // Native cancellation with an old id must preserve the new preview.
  await bundles.cancel(old.id);
  const savingAgain = bundles.export(next.id, ['compiler']);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal(await savingAgain, true);
  assert.equal(written.length, 2);
});
