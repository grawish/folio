import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryWrites } from '../src/shared/recovery-writes';
import type { Project } from '../src/shared/types';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const project = (revision: number, id = 'recovery-test'): Project => ({
  id,
  name: id,
  revision,
  mainFile: 'main.tex',
  files: [{ path: 'main.tex', content: `Latest recovery ${revision}` }],
});

test('10,000 automatic edits retain only the active and newest snapshot without early flush acknowledgement', async () => {
  const first = gate(),
    last = gate(),
    entered = gate();
  const written: Project[] = [];
  const recovery = new RecoveryWrites(async (p) => {
    written.push(p);
    if (written.length === 1) {
      entered.release();
      await first.promise;
    } else await last.promise;
  });
  recovery.set(project(0));
  await entered.promise;
  for (let i = 1; i <= 10_000; i++) assert.equal(recovery.set(project(i)), undefined);
  let finished = false;
  const flushing = recovery.flush().then(() => {
    finished = true;
  });
  await turn();
  assert.equal(written.length, 1);
  assert.equal(finished, false);
  first.release();
  await turn();
  assert.deepEqual(
    written.map((p) => p.revision),
    [0, 10_000],
  );
  assert.equal(finished, false, 'the newest snapshot has not been acknowledged by native storage');
  last.release();
  await flushing;
  assert.deepEqual(written.at(-1), project(10_000));
  assert.equal(recovery.error, '');
});

test('a failed write retains newer edits, pauses automatic retries, and flush saves the latest', async () => {
  const entered = gate(),
    hold = gate();
  const calls: Project[] = [],
    errors: string[] = [];
  const recovery = new RecoveryWrites(
    async (p) => {
      calls.push(p);
      if (calls.length === 1) {
        entered.release();
        await hold.promise;
        throw new Error('Disk full');
      }
    },
    (error) => errors.push(error),
  );
  recovery.set(project(0));
  await entered.promise;
  recovery.set(project(1));
  hold.release();
  await turn();
  assert.equal(recovery.error, 'Disk full');
  recovery.set(project(2));
  await turn();
  assert.equal(calls.length, 1, 'automatic writes must not spin on a failed disk');
  await recovery.flush();
  assert.deepEqual(
    calls.map((p) => p.revision),
    [0, 2],
  );
  assert.deepEqual(errors, ['Disk full', '']);
});

test('failure without a newer edit keeps the failed snapshot available for Retry', async () => {
  let failing = true;
  const calls: number[] = [];
  const recovery = new RecoveryWrites(async (p) => {
    calls.push(p.revision);
    if (failing) throw new Error('No space');
  });
  recovery.set(project(7));
  await turn();
  await assert.rejects(recovery.flush(), /No space/);
  assert.equal(recovery.error, 'No space');
  failing = false;
  await recovery.flush();
  assert.deepEqual(calls, [7, 7, 7]);
  assert.equal(recovery.error, '');
});

test('opening a new project replaces an older waiting snapshot without writing during bootstrap', async () => {
  const hold = gate(),
    entered = gate();
  const calls: Project[] = [];
  const recovery = new RecoveryWrites(async (p) => {
    calls.push(p);
    if (calls.length === 1) {
      entered.release();
      await hold.promise;
    }
  });
  recovery.replacePending(project(0, 'bootstrap'));
  await turn();
  assert.equal(calls.length, 0);
  recovery.set(project(0, 'previous'));
  await entered.promise;
  recovery.set(project(1, 'previous'));
  recovery.replacePending(project(0, 'new-project'));
  hold.release();
  await recovery.flush();
  assert.deepEqual(
    calls.map((p) => [p.id, p.revision]),
    [
      ['previous', 0],
      ['new-project', 0],
    ],
  );
});

test('an edit arriving in the completion callback still gets its own automatic write', async () => {
  const calls: number[] = [];
  let once = false;
  const recovery = new RecoveryWrites(
    async (p) => {
      calls.push(p.revision);
    },
    () => {
      if (!once) {
        once = true;
        recovery.set(project(2));
      }
    },
  );
  recovery.set(project(1));
  await turn();
  assert.deepEqual(calls, [1, 2]);
});

test('explicit flush replaces a waiting old project and waits for the newly selected source', async () => {
  const hold = gate(),
    entered = gate();
  const calls: Project[] = [];
  const recovery = new RecoveryWrites(async (p) => {
    calls.push(p);
    if (calls.length === 1) {
      entered.release();
      await hold.promise;
    }
  });
  recovery.set(project(0, 'old'));
  await entered.promise;
  recovery.set(project(1, 'old'));
  const flushing = recovery.flush(project(9, 'saved-as'));
  hold.release();
  await flushing;
  assert.deepEqual(
    calls.map((p) => [p.id, p.revision]),
    [
      ['old', 0],
      ['saved-as', 9],
    ],
  );
});

test('empty flush and an idle project replacement do not create a recovery file', async () => {
  const recovery = new RecoveryWrites(async () => {
    assert.fail('unexpected recovery write');
  });
  recovery.replacePending(project(0));
  await recovery.flush();
});
