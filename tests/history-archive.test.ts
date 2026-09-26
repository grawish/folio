import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import { HistoryArchiver } from '../electron/core/history-archive';

const fixture = fileURLToPath(new URL('./fixtures/history-worker.cjs', import.meta.url));
const content = (text: string) => ({ 'state.json': Buffer.from(text) });

test('real history worker preserves every source/PDF byte and keeps caller buffers usable', async (t) => {
  const archiver = new HistoryArchiver();
  t.after(() => archiver.close());
  const files: Record<string, Uint8Array> = content('{"projectId":"synthetic"}');
  for (let i = 0; i < 100; i++) {
    files[`versions/version-${i}/source.json`] = Buffer.from(
      JSON.stringify({ source: `\\textbf{Version ${i}}` }),
    );
    files[`versions/version-${i}/resume.pdf`] = Buffer.from(`%PDF-1.4\nSynthetic PDF ${i}\n`);
  }
  const before = Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, Buffer.from(data)]),
  );
  const archive = await archiver.run(async () => files);
  const unpacked = unzipSync(archive);
  assert.deepEqual(Object.keys(unpacked), Object.keys(files));
  for (const [name, data] of Object.entries(before)) {
    assert.deepEqual(Buffer.from(unpacked[name]), data);
    assert.deepEqual(Buffer.from(files[name]), data);
  }
});

test('history requests queue before loading files and the fifth request is rejected', async (t) => {
  const archiver = new HistoryArchiver();
  t.after(() => archiver.close());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: number[] = [];
  const jobs = Array.from({ length: 4 }, (_, id) =>
    archiver.run(async () => {
      started.push(id);
      await gate;
      return content(String(id));
    }),
  );
  await delay(10);
  assert.deepEqual(started, [0]);
  await assert.rejects(
    archiver.run(async () => {
      throw new Error('must not load');
    }),
    /finishing other history/,
  );
  release();
  const archives = await Promise.all(jobs);
  assert.deepEqual(started, [0, 1, 2, 3]);
  for (const [id, archive] of archives.entries())
    assert.equal(Buffer.from(unzipSync(archive)['state.json']).toString(), String(id));
});

test('a failed snapshot does not poison later history saves', async (t) => {
  const archiver = new HistoryArchiver();
  t.after(() => archiver.close());
  await assert.rejects(
    archiver.run(async () => {
      throw new Error('damaged source');
    }),
    /damaged source/,
  );
  assert.ok((await archiver.run(async () => content('recovered'))).length > 22);
});

for (const mode of ['crash', 'exit', 'hang', 'wrong-id', 'bad-output'])
  test(`history worker ${mode} fails within its bound and the next save recovers`, async (t) => {
    const archiver = new HistoryArchiver({ workerFile: fixture, timeoutMs: 500 });
    t.after(() => archiver.close());
    await assert.rejects(
      archiver.run(async () => content(mode)),
      /compression|history worker/,
    );
    const archive = await archiver.run(async () => content('recovered'));
    assert.equal(Buffer.from(unzipSync(archive)['state.json']).toString(), 'recovered');
  });

test('history count, per-file, expanded-byte and filename limits refuse invalid inputs', async (t) => {
  const archiver = new HistoryArchiver();
  t.after(() => archiver.close());
  await assert.rejects(
    archiver.run(async () => ({})),
    /file-count/,
  );
  await assert.rejects(
    archiver.run(async () =>
      Object.fromEntries(Array.from({ length: 2002 }, (_, id) => [String(id), new Uint8Array()])),
    ),
    /file-count/,
  );
  await assert.rejects(
    archiver.run(async () => ({ 'state.json': new Uint8Array(25 * 1024 * 1024 + 1) })),
    /25 MB/,
  );
  const large = new Uint8Array(25 * 1024 * 1024);
  await assert.rejects(
    archiver.run(async () =>
      Object.fromEntries(
        Array.from({ length: 9 }, (_, id) => [`versions/v${id}/resume.pdf`, large]),
      ),
    ),
    /200 MB/,
  );
  await assert.rejects(
    archiver.run(async () => ({ '../outside': Buffer.from('unchanged') })),
    /invalid/,
  );
});

test('near-limit histories fall back to the original compression without losing any bytes', async (t) => {
  const archiver = new HistoryArchiver();
  t.after(() => archiver.close());
  const block = Buffer.alloc(21 * 1024 * 1024, 32);
  block.write('%PDF-1.4\nSynthetic archive-bound fixture\n');
  const files = Object.fromEntries(
    Array.from({ length: 5 }, (_, id) => [`versions/v${id}/resume.pdf`, block]),
  );
  const archive = await archiver.run(async () => files);
  assert.ok(archive.byteLength < 1024 * 1024);
  const expanded = unzipSync(archive);
  for (const name of Object.keys(files)) assert.deepEqual(Buffer.from(expanded[name]), block);
});

test('real incompressible history exceeding the output limit fails before returning an archive', async (t) => {
  const archiver = new HistoryArchiver();
  t.after(() => archiver.close());
  const block = randomBytes(21 * 1024 * 1024);
  await assert.rejects(
    archiver.run(async () =>
      Object.fromEntries(
        Array.from({ length: 5 }, (_, id) => [`versions/v${id}/resume.pdf`, block]),
      ),
    ),
    /100 MB/,
  );
  assert.ok((await archiver.run(async () => content('retry'))).length > 22);
});

test('idle worker releases its thread, close waits for compression and refuses later requests', async () => {
  const archiver = new HistoryArchiver({ idleMs: 20 });
  await archiver.run(async () => content('first'));
  // Inspect the actual Node worker lifecycle, rather than just a bookkeeping flag.
  const worker = archiver['worker'] as Worker;
  assert.ok(worker.threadId > 0);
  assert.equal(worker.resourceLimits?.maxOldGenerationSizeMb, 64);
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Idle worker did not exit')), 2000);
    worker.once('exit', () => {
      clearTimeout(deadline);
      resolve();
    });
  });
  assert.equal(worker.threadId, -1);
  const job = archiver.run(async () => content('second'));
  await delay(10);
  const closing = archiver.close();
  await job;
  await closing;
  assert.equal(archiver['worker'], undefined);
  await assert.rejects(
    archiver.run(async () => content('late')),
    /closed/,
  );
});
