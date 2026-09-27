import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ProjectStore, maxPendingRecoveryWrites } from '../electron/core/project';
import type { Project } from '../src/shared/types';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const project = (revision: number): Project => ({
  id: 'native-recovery',
  name: 'Recovery',
  revision,
  mainFile: 'main.tex',
  files: [{ path: 'main.tex', content: `Recovery source ${revision}` }],
});
async function fixture(t: TestContext) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'folio-recovery-admission-')),
  );
  const data = path.join(root, 'data');
  await fs.mkdir(data);
  const store = new ProjectStore(data);
  const releases: (() => void)[] = [];
  t.after(async () => {
    releases.forEach((release) => release());
    await store.flushRecovery().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, data, store, releases };
}

test('native recovery admits four writes, rejects a 10,000-request excess, and keeps every accepted acknowledgement durable', async (t) => {
  const { store, data, releases } = await fixture(t);
  const first = gate(),
    entered = gate(),
    last = gate(),
    lastEntered = gate();
  releases.push(first.release, last.release);
  const original = store['writeRecovery'].bind(store);
  const calls: number[] = [];
  store['writeRecovery'] = async (p, ...args) => {
    calls.push(p.revision);
    if (calls.length === 1) {
      entered.release();
      await first.promise;
    }
    if (calls.length === maxPendingRecoveryWrites) {
      lastEntered.release();
      await last.promise;
    }
    return original(p, ...args);
  };
  let settled = 0;
  const accepted: Promise<void>[] = [
    store.recover(project(0)).then(() => {
      settled++;
    }),
  ];
  await entered.promise;
  for (let i = 1; i < maxPendingRecoveryWrites; i++)
    accepted.push(
      store.recover(project(i)).then(() => {
        settled++;
      }),
    );
  const rejected = Array.from({ length: 10_000 }, (_, i) =>
    assert.rejects(store.recover(project(i + 4)), /Recovery is busy/),
  );
  await Promise.all(rejected);
  assert.equal(settled, 0);
  assert.deepEqual(calls, [0]);
  let flushed = false;
  const flushing = store.flushRecovery().then(() => {
    flushed = true;
  });
  first.release();
  await lastEntered.promise;
  await turn();
  assert.equal(flushed, false);
  assert.equal(settled, 3);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(data, 'recovery.json'), 'utf8')).project.revision,
    2,
  );
  last.release();
  await Promise.all([...accepted, flushing]);
  assert.deepEqual(calls, [0, 1, 2, 3]);
  assert.equal((await store.loadRecovery())?.revision, 3);
  await store.recover(project(10_003));
  assert.equal(
    (await store.loadRecovery())?.revision,
    10_003,
    'a rejected newest snapshot can be retried',
  );
});

test('a failed recovery releases admission and flush keeps the error visible until a new write succeeds', async (t) => {
  const { store } = await fixture(t);
  const original = store['writeRecovery'].bind(store);
  store['writeRecovery'] = async () => {
    throw new Error('Cannot replace recovery');
  };
  for (let i = 0; i < 8; i++) {
    await assert.rejects(store.recover(project(i)), /Cannot replace recovery/);
    await assert.rejects(store.flushRecovery(), /Cannot replace recovery/);
  }
  store['writeRecovery'] = original;
  await store.recover(project(8));
  await store.flushRecovery();
  assert.equal((await store.loadRecovery())?.revision, 8);
});

test('recovery and normal saves preserve call order and the baseline for later outside-file checks', async (t) => {
  const { store, root, data } = await fixture(t);
  const folder = path.join(root, 'project');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'main.tex'), 'Initial saved source');
  const opened = await store.open(folder);
  const first = { ...opened, revision: 1, files: [{ path: 'main.tex', content: 'Saved source' }] };
  const latest = {
    ...first,
    revision: 2,
    files: [{ path: 'main.tex', content: 'New unsaved source' }],
  };
  const olderRecovery = store.recover(first);
  const saving = store.save(first);
  const newestRecovery = store.recover(latest);
  await Promise.all([olderRecovery, saving, newestRecovery]);
  const raw = JSON.parse(await fs.readFile(path.join(data, 'recovery.json'), 'utf8'));
  assert.equal(raw.project.revision, 2);
  assert.equal(raw.directory, folder);
  assert.equal(
    new Map(raw.baseline).get('main.tex'),
    createHash('sha256').update('Saved source').digest('hex'),
  );
  assert.equal(await fs.readFile(path.join(folder, 'main.tex'), 'utf8'), 'Saved source');
  const restarted = new ProjectStore(data);
  const recovered = await restarted.loadRecovery();
  assert.ok(recovered);
  assert.equal((await restarted.save(recovered)).conflict, false);
  assert.equal(await fs.readFile(path.join(folder, 'main.tex'), 'utf8'), 'New unsaved source');
});

test('clear recovery is serialized between accepted writes', async (t) => {
  const { store, releases } = await fixture(t);
  const hold = gate(),
    entered = gate();
  releases.push(hold.release);
  const original = store['writeRecovery'].bind(store);
  store['writeRecovery'] = async (p, ...args) => {
    if (p.revision === 0) {
      entered.release();
      await hold.promise;
    }
    return original(p, ...args);
  };
  const first = store.recover(project(0));
  await entered.promise;
  const cleared = store.clearRecovery();
  const latest = store.recover(project(1));
  hold.release();
  await Promise.all([first, cleared, latest]);
  assert.equal((await store.loadRecovery())?.revision, 1);
  await store.clearRecovery();
  assert.equal(await store.loadRecovery(), null);
});

test('admitted writes and clear cannot replace a pending guided-recovery marker', async (t) => {
  const { store, data } = await fixture(t);
  const marker = JSON.stringify({
    pendingSaveResolution: { root: '/synthetic', nonce: 'kept' },
    project: project(0),
  });
  await fs.writeFile(path.join(data, 'recovery.json'), marker);
  await assert.rejects(store.recover(project(1)), /Reopen save recovery/);
  await assert.rejects(store.flushRecovery(), /Reopen save recovery/);
  await assert.rejects(store.clearRecovery(), /Reopen save recovery/);
  assert.equal(await fs.readFile(path.join(data, 'recovery.json'), 'utf8'), marker);
});

test('recovery acknowledges only after flushing the temporary file and published directory', async (t) => {
  const { store, data } = await fixture(t);
  const originalOpen = fs.open,
    originalRename = fs.rename;
  const events: string[] = [];
  const directorySync = gate(),
    entered = gate();
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const filename = String(args[0]);
    const sync = handle.sync.bind(handle);
    if (filename.startsWith(path.join(data, 'recovery.json.'))) {
      handle.sync = async () => {
        events.push('file-sync');
        await sync();
      };
    } else if (filename === data) {
      handle.sync = async () => {
        events.push('directory-sync-entered');
        entered.release();
        await directorySync.promise;
        await sync();
        events.push('directory-sync-finished');
      };
    }
    return handle;
  }) as typeof fs.open;
  fs.rename = async (from, to) => {
    if (to === path.join(data, 'recovery.json')) events.push('rename');
    return originalRename(from, to);
  };
  let acknowledged = false;
  const recovering = store.recover(project(1)).then(() => {
    acknowledged = true;
    events.push('acknowledged');
  });
  try {
    await entered.promise;
    assert.equal(acknowledged, false);
    assert.deepEqual(events, ['file-sync', 'rename', 'directory-sync-entered']);
    directorySync.release();
    await recovering;
    assert.deepEqual(events, [
      'file-sync',
      'rename',
      'directory-sync-entered',
      'directory-sync-finished',
      'acknowledged',
    ]);
  } finally {
    directorySync.release();
    await recovering.catch(() => {});
    fs.open = originalOpen;
    fs.rename = originalRename;
  }
});

for (const kind of ['file', 'directory'] as const) {
  test(`a ${kind} flush failure is reported and recovery can retry the newest source`, async (t) => {
    const { store, data } = await fixture(t);
    await store.recover(project(0));
    const previous = await fs.readFile(path.join(data, 'recovery.json'));
    const originalOpen = fs.open;
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const filename = String(args[0]);
      if (
        (kind === 'file' && filename.startsWith(path.join(data, 'recovery.json.'))) ||
        (kind === 'directory' && filename === data)
      )
        handle.sync = async () => {
          throw new Error(`Synthetic ${kind} flush failure`);
        };
      return handle;
    }) as typeof fs.open;
    try {
      await assert.rejects(store.recover(project(1)), new RegExp(`${kind} flush failure`));
      await assert.rejects(store.flushRecovery(), new RegExp(`${kind} flush failure`));
      if (kind === 'file')
        assert.deepEqual(await fs.readFile(path.join(data, 'recovery.json')), previous);
      else
        assert.equal(
          JSON.parse(await fs.readFile(path.join(data, 'recovery.json'), 'utf8')).project.revision,
          1,
        );
    } finally {
      fs.open = originalOpen;
    }
    await store.recover(project(2));
    assert.equal((await store.loadRecovery())?.revision, 2);
    assert.deepEqual(
      (await fs.readdir(data)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });
}
