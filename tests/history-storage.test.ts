import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import {
  WorkspaceStore,
  HISTORY_BYTES,
  HISTORY_VERSIONS,
  validateAnnotation,
} from '../electron/core/workspace';
import type { Project } from '../src/shared/types';
import type { PdfAnnotation } from '../src/shared/ai';
import { Compiler } from '../electron/core/compiler';

const project = (revision: number): Project => ({
  id: 'resume',
  name: 'Synthetic resume',
  mainFile: 'main.tex',
  revision,
  files: [{ path: 'main.tex', content: `Revision ${revision}` }],
});
const pdf = (revision: number) => Buffer.from(`%PDF-1.4\nSynthetic ${revision}`);
test('compiler activity includes queued replacements and clears after failure or cancellation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-history-compiler-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const compiler = new Compiler(path.join(root, 'missing-runtime'), path.join(root, 'builds'));
  assert.equal(compiler.busy, false);
  const first = compiler.compile(project(0));
  const second = compiler.compile(project(1));
  assert.equal(compiler.busy, true);
  assert.equal((await first).status, 'cancelled');
  assert.equal(compiler.busy, true);
  assert.equal((await second).status, 'error');
  assert.equal(compiler.busy, false);
  const third = compiler.compile(project(2));
  await compiler.cancel();
  await third;
  assert.equal(compiler.busy, false);
});
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-history-storage-'));
  const store = new WorkspaceStore(root);
  t.after(async () => {
    await store.flush().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const first = await store.checkpoint(project(0), pdf(0));
  const last = await store.checkpoint(project(1), pdf(1));
  return {
    root,
    store,
    first,
    last,
    versionPath: (id: string, name: string) =>
      path.join(root, 'workspaces/resume/versions', id, name),
  };
}

test('removal preserves current content and sent note text, rejects stale saves, and survives archive round-trip', async (t) => {
  const f = await fixture(t);
  const note: PdfAnnotation = {
    id: 'note',
    versionId: f.first.id,
    page: 1,
    kind: 'note',
    rect: { x: 0, y: 0, width: 0.1, height: 0.1 },
    text: 'Keep the sent feedback',
    createdAt: new Date().toISOString(),
  };
  const before = {
    ...(await f.store.load('resume')),
    draft: 'Unsaved request',
    annotations: [note],
    attachedNoteIds: [note.id],
    messages: [
      {
        id: 'message',
        role: 'user' as const,
        text: 'Change this',
        createdAt: new Date().toISOString(),
        annotationIds: [note.id],
        annotationSnapshot: [note],
        versionId: f.first.id,
      },
    ],
  };
  await f.store.save(before);
  const usage = await f.store.storage('resume');
  assert.equal(
    usage.bytes,
    (await fs.stat(f.versionPath(f.first.id, 'source.json'))).size +
      (await fs.stat(f.versionPath(f.last.id, 'source.json'))).size +
      pdf(0).length +
      pdf(1).length,
  );
  const result = await f.store.removeVersion('resume', f.first.id, f.last.id);
  assert.equal(result.draft, before.draft);
  assert.equal(result.historyRevision, 1);
  assert.deepEqual(result.versions, [f.last]);
  assert.deepEqual(result.annotations, []);
  assert.deepEqual(result.attachedNoteIds, []);
  assert.deepEqual(result.messages[0].annotationSnapshot, [validateAnnotation(note)]);
  assert.equal(result.messages[0].text, 'Change this');
  assert.equal(result.messages[0].versionId, undefined);
  await assert.rejects(fs.stat(f.versionPath(f.first.id, 'resume.pdf')), { code: 'ENOENT' });
  assert.deepEqual(Buffer.from((await f.store.version('resume', f.last.id)).pdf), pdf(1));
  await assert.rejects(f.store.save(before), /History changed/);
  assert.deepEqual(await f.store.load('resume'), result);
  const folder = path.join(f.root, 'portable');
  await fs.mkdir(folder);
  await f.store.exportTo('resume', folder);
  const imported = new WorkspaceStore(path.join(f.root, 'other-profile'));
  await imported.importFrom('resume', folder);
  assert.deepEqual(await imported.load('resume'), result);
  await imported.save({ ...result, draft: 'Continued after import' });
  assert.equal((await imported.load('resume')).draft, 'Continued after import');
});

test('current and newest versions cannot be removed, even when current PDF is older', async (t) => {
  const f = await fixture(t);
  const before = await f.store.load('resume');
  await assert.rejects(f.store.removeVersion('resume', f.last.id), /newest saved/);
  await assert.rejects(f.store.removeVersion('resume', f.first.id, f.first.id), /current PDF/);
  await assert.rejects(f.store.removeVersion('resume', '../escape'), /Invalid workspace/);
  assert.deepEqual(await f.store.load('resume'), before);
});

test('failed removal rolls back deleted bytes and the conversation together', async (t) => {
  const f = await fixture(t);
  const before = await f.store.load('resume');
  const failed = new WorkspaceStore(f.root, {
    afterApply: async (index) => {
      if (index === 1) throw new Error('synthetic disk failure');
    },
  });
  await assert.rejects(failed.removeVersion('resume', f.first.id), /previous files were restored/);
  assert.deepEqual(await f.store.load('resume'), before);
  assert.deepEqual(Buffer.from((await f.store.version('resume', f.first.id)).pdf), pdf(0));
  await f.store.removeVersion('resume', f.first.id);
  assert.equal((await f.store.load('resume')).versions.length, 1);
});

test('linked workspace or version folders cannot redirect history removal', async (t) => {
  const f = await fixture(t);
  const original = path.join(f.root, 'workspaces/resume/versions', f.first.id);
  const outside = path.join(f.root, 'preserved-version');
  await fs.rename(original, outside);
  await fs.symlink(outside, original);
  const state = await f.store.load('resume');
  await assert.rejects(f.store.removeVersion('resume', f.first.id), /without symbolic links/);
  assert.deepEqual(await f.store.load('resume'), state);
  assert.deepEqual(await fs.readFile(path.join(outside, 'resume.pdf')), pdf(0));
  const workspace = path.join(f.root, 'workspaces/resume');
  const moved = path.join(f.root, 'preserved-workspace');
  await fs.rename(workspace, moved);
  await fs.symlink(moved, workspace);
  await assert.rejects(
    f.store.removeVersion('resume', f.first.id),
    /saved conversation could not be read/,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(moved, 'state.json'), 'utf8')).versions.map(
      (v: { id: string }) => v.id,
    ),
    state.versions.map((v) => v.id),
  );
});

for (const stage of ['apply-0', 'apply-1', 'apply-2', 'committed']) {
  test(`killed history removal recovers complete state at ${stage}`, async (t) => {
    const f = await fixture(t);
    const before = await f.store.load('resume');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/fixtures/history-removal-crash.ts', f.root, f.first.id, stage],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      errors = '';
    child.stderr.on('data', (d) => {
      errors += d;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Did not reach removal boundary: ' + errors));
      }, 15000);
      child.on('error', reject);
      child.stdout.on('data', (d) => {
        output += d;
        if (output.includes('READY-TO-KILL')) child.kill('SIGKILL');
      });
      child.on('exit', (_code, signal) => {
        clearTimeout(timer);
        if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
        else reject(new Error(errors));
      });
    });
    const reopened = new WorkspaceStore(f.root);
    const after = await reopened.load('resume');
    if (stage === 'committed') {
      assert.deepEqual(after.versions, [f.last]);
      assert.equal(after.historyRevision, 1);
      await assert.rejects(fs.stat(f.versionPath(f.first.id, 'resume.pdf')), { code: 'ENOENT' });
    } else {
      assert.deepEqual(after, before);
      assert.deepEqual(Buffer.from((await reopened.version('resume', f.first.id)).pdf), pdf(0));
    }
    assert.deepEqual(Buffer.from((await reopened.version('resume', f.last.id)).pdf), pdf(1));
    assert.deepEqual(await reopened.load('resume'), after);
  });
}

test('history admission stops at the actual byte limit without writing a new version, then resumes after removal', async (t) => {
  const f = await fixture(t);
  const large = Buffer.alloc(24 * 1024 * 1024);
  large.write('%PDF-1.4');
  const a = await f.store.checkpoint(project(2), large);
  await f.store.checkpoint(project(3), large);
  const before = await f.store.load('resume');
  const files = await fs.readdir(path.dirname(f.versionPath(f.first.id, '')));
  await assert.rejects(f.store.checkpoint(project(4), large), /History is full/);
  assert.deepEqual(await f.store.load('resume'), before);
  assert.deepEqual(await fs.readdir(path.dirname(f.versionPath(f.first.id, ''))), files);
  assert((await f.store.storage('resume')).bytes < HISTORY_BYTES);
  await f.store.removeVersion('resume', a.id);
  await f.store.checkpoint(project(4), large);
  const exported = unzipSync(await f.store.archive('resume'));
  assert.equal(JSON.parse(strFromU8(exported['state.json'])).versions.at(-1).revision, 4);
});

test('legacy over-limit history is kept, but cannot admit more versions', async (t) => {
  const f = await fixture(t);
  const before = await f.store.load('resume');
  before.versions = Array.from({ length: HISTORY_VERSIONS }, (_, i) => ({
    ...f.first,
    id: `old-${i}`,
  }));
  const file = path.join(f.root, 'workspaces/resume/state.json');
  await fs.writeFile(file, JSON.stringify(before));
  await assert.rejects(f.store.checkpoint(project(4), pdf(4)), /History is full/);
  assert.deepEqual(await f.store.load('resume'), before);
});

test('concurrent archive and removal produce a complete history snapshot', async (t) => {
  const f = await fixture(t);
  const archive = f.store.archive('resume');
  const remove = f.store.removeVersion('resume', f.first.id);
  const zip = unzipSync(await archive);
  await remove;
  const saved = JSON.parse(strFromU8(zip['state.json']));
  for (const v of saved.versions) {
    assert(zip[`versions/${v.id}/source.json`]);
    assert(zip[`versions/${v.id}/resume.pdf`]);
  }
  assert.equal((await f.store.load('resume')).versions.length, 1);
});

test('bounded history reads preserve write admission and release their own capacity', async (t) => {
  const f = await fixture(t),
    state = await f.store.load('resume');
  const reads = Array.from({ length: 8 }, () => f.store.version('resume', f.first.id));
  const writes = Array.from({ length: 4 }, (_, i) =>
    f.store.save({ ...state, draft: `Draft ${i}` }),
  );
  await assert.rejects(f.store.version('resume', f.first.id), /loading other history previews/);
  await assert.rejects(f.store.save(state), /finishing other workspace saves/);
  const results = await Promise.all(reads);
  await Promise.all(writes);
  for (const snapshot of results) assert.deepEqual(Buffer.from(snapshot.pdf), pdf(0));
  assert.equal((await f.store.load('resume')).draft, 'Draft 3');
  assert.equal((await f.store.storage('resume')).versions.length, 2);
});
