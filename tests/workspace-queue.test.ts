import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../electron/core/workspace';
import { emptyWorkspace } from '../src/shared/ai';
import type { Project } from '../src/shared/types';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-workspace-queue-'));
  const store = new WorkspaceStore(root);
  t.after(async () => {
    await store.flush().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store };
}
const project = (revision: number): Project => ({
  id: 'resume',
  name: 'Synthetic resume',
  mainFile: 'main.tex',
  revision,
  files: [{ path: 'main.tex', content: `Revision ${revision}` }],
});
const pdf = (revision: number) => Buffer.from(`%PDF-1.4\nSynthetic revision ${revision}`);

test('workspace bursts preserve accepted draft/version order and reject excess work before writing', async (t) => {
  const { store, root } = await fixture(t);
  const first = await store.checkpoint(project(0), pdf(0));
  const state = await store.load('resume');
  // Queue in the same turn so real asynchronous file operations cannot finish
  // before admission. No timers or mocked storage determine the boundary.
  const saves = [
    store.save({ ...state, draft: 'First accepted draft' }),
    store.checkpoint(project(1), pdf(1)),
    store.save({ ...state, draft: 'Last accepted draft' }),
    store.checkpoint(project(2), pdf(2)),
  ];
  await assert.rejects(store.checkpoint(project(3), pdf(3)), /finishing other workspace saves/);
  await Promise.all([store.flush(), ...saves]);
  const saved = await store.load('resume');
  assert.equal(saved.draft, 'Last accepted draft');
  assert.deepEqual(
    saved.versions.map((v) => v.revision),
    [0, 1, 2],
  );
  assert.equal((await store.version('resume', first.id)).files[0].content, 'Revision 0');
  assert.equal((await fs.readdir(path.join(root, 'workspaces/resume/versions'))).length, 3);
  for (const version of saved.versions) {
    const snapshot = await store.version('resume', version.id);
    assert.equal(snapshot.files[0].content, `Revision ${version.revision}`);
    assert.deepEqual(Buffer.from(snapshot.pdf), pdf(version.revision));
  }
  const retry = await store.checkpoint(project(3), pdf(3));
  assert.equal(retry.revision, 3);
  assert.equal((await store.load('resume')).versions.length, 4);
});

test('workspace capacity is shared across projects and fully released after each batch', async (t) => {
  const { store, root } = await fixture(t);
  for (let batch = 0; batch < 4; batch++) {
    const states = Array.from({ length: 8 }, (_, i) => ({
      ...emptyWorkspace(`project-${batch}-${i}`),
      draft: `Accepted ${batch}/${i}`,
    }));
    const accepted = states.map((state) => store.save(state));
    const rejected = `rejected-${batch}`;
    await assert.rejects(store.save(emptyWorkspace(rejected)), /finishing other workspace saves/);
    await Promise.all([store.flush(), ...accepted]);
    await assert.rejects(fs.stat(path.join(root, 'workspaces', rejected)), { code: 'ENOENT' });
    for (const state of states) assert.deepEqual(await store.load(state.projectId), state);
  }
});

test('failed queued writes remain errors, release capacity, and allow later recovery', async (t) => {
  const { store, root } = await fixture(t);
  const broken = path.join(root, 'workspaces/broken');
  await fs.mkdir(broken, { recursive: true });
  await fs.writeFile(path.join(broken, 'state.json'), 'invalid JSON');
  const failures = Array.from({ length: 4 }, () =>
    assert.rejects(store.save(emptyWorkspace('broken')), /saved conversation could not be read/),
  );
  // A different project remains usable while the broken project's queue drains.
  const other = { ...emptyWorkspace('other'), draft: 'Keep this draft' };
  const valid = store.save(other);
  await assert.rejects(store.flush(), /saved conversation could not be read/);
  await Promise.all([...failures, valid]);
  assert.equal(await fs.readFile(path.join(broken, 'state.json'), 'utf8'), 'invalid JSON');
  assert.deepEqual(await store.load('other'), other);
  const recovered = { ...emptyWorkspace('broken'), draft: 'Recovered input' };
  await fs.writeFile(path.join(broken, 'state.json'), JSON.stringify(emptyWorkspace('broken')));
  await store.save(recovered);
  await store.flush();
  assert.deepEqual(await store.load('broken'), recovered);
});
