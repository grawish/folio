import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LatestWorkQueue } from '../electron/core/latest-work-queue';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a burst settles obsolete requests while active work is still held', async () => {
  const queue = new LatestWorkQueue<number>();
  const hold = gate();
  const calls: number[] = [];
  const first = queue.enqueue(
    async () => {
      calls.push(0);
      await hold.promise;
      return 0;
    },
    () => -1,
  );
  await turn();
  let settled = 0;
  const pending = Array.from({ length: 10_000 }, (_, i) =>
    queue
      .enqueue(
        async () => {
          calls.push(i + 1);
          return i + 1;
        },
        () => -(i + 1),
      )
      .then((value) => {
        settled++;
        return value;
      }),
  );
  await turn();
  assert.equal(settled, 9999);
  assert.deepEqual(calls, [0]);
  assert.equal(queue.busy, true);
  hold.release();
  assert.equal(await first, 0);
  const results = await Promise.all(pending);
  assert.deepEqual(
    results.slice(0, -1),
    Array.from({ length: 9999 }, (_, i) => -(i + 1)),
  );
  assert.equal(results.at(-1), 10_000);
  assert.deepEqual(calls, [0, 10_000]);
  assert.equal(queue.busy, false);
});

test('cancelling pending work does not hide active cleanup', async () => {
  const queue = new LatestWorkQueue<number>();
  const hold = gate();
  const active = queue.enqueue(
    async () => {
      await hold.promise;
      return 1;
    },
    () => -1,
  );
  const pending = queue.enqueue(
    async () => {
      assert.fail('cancelled work ran');
    },
    () => -2,
  );
  queue.cancelPending();
  assert.equal(await pending, -2);
  assert.equal(queue.running, active);
  assert.equal(queue.busy, true);
  hold.release();
  await active;
  assert.equal(queue.running, undefined);
  assert.equal(queue.busy, false);
});

test('a failed active operation cannot poison the newest request', async () => {
  const queue = new LatestWorkQueue<number>();
  const hold = gate();
  const active = queue.enqueue(
    async () => {
      await hold.promise;
      throw new Error('cleanup');
    },
    () => -1,
  );
  const rejected = assert.rejects(active, /cleanup/);
  const pending = queue.enqueue(
    async () => 2,
    () => -2,
  );
  hold.release();
  await rejected;
  assert.equal(await pending, 2);
  assert.equal(queue.busy, false);
});

test('work can enqueue its replacement without overlapping operations', async () => {
  const queue = new LatestWorkQueue<number>();
  const events: string[] = [];
  let replacement!: Promise<number>;
  const first = queue.enqueue(
    async () => {
      events.push('first-start');
      replacement = queue.enqueue(
        async () => {
          events.push('replacement');
          return 2;
        },
        () => -2,
      );
      await turn();
      events.push('first-end');
      return 1;
    },
    () => -1,
  );
  assert.equal(await first, 1);
  assert.equal(await replacement, 2);
  assert.deepEqual(events, ['first-start', 'first-end', 'replacement']);
});
