import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyLocalAiTiming } from '../scripts/verify-local-ai-timing.mjs';

async function writeWorkspace(root: string, projectId: string, messages: unknown[]) {
  const dir = path.join(root, 'app-data', 'workspaces', projectId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectId,
      messages,
      annotations: [],
      draft: '',
      attachedNoteIds: [],
    }),
  );
}

function execution(overrides: Record<string, unknown> = {}) {
  return {
    models: ['fixture-model'],
    escalated: false,
    validation: 'visual',
    timings: { setup: 0.5, inference: 1.5, compile: 100, render: 10, review: 0.5, total: 115 },
    ...overrides,
  };
}

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-local-ai-timing-'));
  return root;
}

test('verifies a valid completed test:chat directory and deduplicates a copied workspace', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shared = {
    id: 'msg-shared',
    role: 'assistant',
    text: 'Updated.',
    createdAt: '2026-09-29T16:08:32.137Z',
    annotationIds: [],
    status: 'complete',
    execution: execution(),
  };
  const originalOnly = {
    id: 'msg-original-only',
    role: 'user',
    text: 'Try again.',
    createdAt: '2026-09-29T16:08:38.087Z',
    annotationIds: [],
  };
  await writeWorkspace(root, 'workspace-original', [shared, originalOnly]);
  // Save As copies the entire workspace archive verbatim into a new project id.
  await writeWorkspace(root, 'workspace-copy', [shared]);

  const summary = await verifyLocalAiTiming(root);
  assert.equal(summary.executionCount, 1);
  assert.equal(summary.executions[0].id, 'msg-shared');
  assert.deepEqual(summary.executions[0].workspaceIds, ['workspace-copy', 'workspace-original']);
  assert.equal(summary.executions[0].knownStageMs, 112.5);
  assert.equal(summary.executions[0].uninstrumentedMs, 2.5);
  const relation = summary.workspaceRelationships.find(
    (r: { workspaces: string[] }) =>
      r.workspaces.includes('workspace-original') && r.workspaces.includes('workspace-copy'),
  );
  assert.ok(relation);
  assert.equal(relation.relation, 'subset');
  assert.equal(relation.sharedMessages, 1);

  const again = await verifyLocalAiTiming(root);
  assert.equal(JSON.stringify(again), JSON.stringify(summary));
});

test('rejects a missing directory and one without saved workspace states', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(verifyLocalAiTiming(path.join(root, 'missing')), /is not a directory/);
  await assert.rejects(verifyLocalAiTiming(root), /app-data\/workspaces/);
});

test('rejects a negative stage duration', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeWorkspace(root, 'workspace-a', [
    {
      id: 'msg-1',
      role: 'assistant',
      text: 'x',
      createdAt: '2026-09-29T16:08:32.137Z',
      annotationIds: [],
      execution: execution({ timings: { setup: -1, inference: 1, total: 0 } }),
    },
  ]);
  await assert.rejects(verifyLocalAiTiming(root), /finite non-negative/);
});

test('rejects a non-finite stage duration', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeWorkspace(root, 'workspace-a', [
    {
      id: 'msg-1',
      role: 'assistant',
      text: 'x',
      createdAt: '2026-09-29T16:08:32.137Z',
      annotationIds: [],
      execution: execution({ timings: { setup: Number.POSITIVE_INFINITY, total: 1 } }),
    },
  ]);
  await assert.rejects(verifyLocalAiTiming(root), /finite non-negative/);
});

test('rejects a total that understates its recorded stages', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeWorkspace(root, 'workspace-a', [
    {
      id: 'msg-1',
      role: 'assistant',
      text: 'x',
      createdAt: '2026-09-29T16:08:32.137Z',
      annotationIds: [],
      execution: execution({ timings: { setup: 10, inference: 10, total: 5 } }),
    },
  ]);
  await assert.rejects(verifyLocalAiTiming(root), /understates its recorded stages/);
});

test('allows documented uninstrumented checkpoint/apply time above recorded stages', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeWorkspace(root, 'workspace-a', [
    {
      id: 'msg-1',
      role: 'assistant',
      text: 'x',
      createdAt: '2026-09-29T16:08:32.137Z',
      annotationIds: [],
      execution: execution({ timings: { setup: 1, inference: 1, total: 50 } }),
    },
  ]);
  const summary = await verifyLocalAiTiming(root);
  assert.equal(summary.executions[0].knownStageMs, 2);
  assert.equal(summary.executions[0].uninstrumentedMs, 48);
});

test('rejects an execution model outside the local fixture pattern', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeWorkspace(root, 'workspace-a', [
    {
      id: 'msg-1',
      role: 'assistant',
      text: 'x',
      createdAt: '2026-09-29T16:08:32.137Z',
      annotationIds: [],
      execution: execution({ models: ['gpt-4o'] }),
    },
  ]);
  await assert.rejects(
    verifyLocalAiTiming(root),
    /not a recognized local scripted-provider fixture/,
  );
});

test('rejects an unknown timing stage key', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeWorkspace(root, 'workspace-a', [
    {
      id: 'msg-1',
      role: 'assistant',
      text: 'x',
      createdAt: '2026-09-29T16:08:32.137Z',
      annotationIds: [],
      execution: execution({ timings: { setup: 1, total: 1, network: 5 } }),
    },
  ]);
  await assert.rejects(verifyLocalAiTiming(root), /unknown timing stage/);
});

test('rejects copied workspace states that disagree on a shared message id', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeWorkspace(root, 'workspace-original', [
    {
      id: 'msg-shared',
      role: 'assistant',
      text: 'Updated.',
      createdAt: '2026-09-29T16:08:32.137Z',
      annotationIds: [],
      execution: execution(),
    },
  ]);
  await writeWorkspace(root, 'workspace-copy', [
    {
      id: 'msg-shared',
      role: 'assistant',
      text: 'Updated differently.',
      createdAt: '2026-09-29T16:08:32.137Z',
      annotationIds: [],
      execution: execution(),
    },
  ]);
  await assert.rejects(verifyLocalAiTiming(root), /differs between copied workspace states/);
});

test('rejects a workspace whose projectId does not match its directory name', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'app-data', 'workspaces', 'workspace-a');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectId: 'mismatched-id',
      messages: [],
      annotations: [],
      draft: '',
      attachedNoteIds: [],
    }),
  );
  await assert.rejects(verifyLocalAiTiming(root), /does not match its directory name/);
});

test('rejects a directory with saved workspaces but no recorded executions', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeWorkspace(root, 'workspace-a', [
    {
      id: 'msg-1',
      role: 'user',
      text: 'Hello',
      createdAt: '2026-09-29T16:08:32.137Z',
      annotationIds: [],
    },
  ]);
  await assert.rejects(verifyLocalAiTiming(root), /no recorded AI execution timings/);
});

test('rejects malformed state.json JSON', async (t) => {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'app-data', 'workspaces', 'workspace-a');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), '{not json');
  await assert.rejects(verifyLocalAiTiming(root), /could not be read or parsed/);
});
