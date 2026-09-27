import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { observeSubprocess } from '../scripts/lib/subprocess-timeline.mjs';

test('subprocess observer preserves actual output, ordering, exit status and a controlled phase delay', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `process.stdout.write('first phase\\n');process.once('message',()=>setTimeout(()=>{process.stderr.write('second phase\\n');process.exitCode=7;process.disconnect();},100));`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  const trace = observeSubprocess(child);
  // Start the controlled wait only after the parent has received phase one.
  // This keeps a busy test host from coalescing both observations.
  child.stdout!.once('data', () => child.send('continue'));
  const [code] = await once(child, 'close');
  assert.equal(code, 7);
  assert.equal(trace.exitCode, 7);
  assert.equal(trace.signal, null);
  assert.equal(trace.error, undefined);
  assert.equal(trace.truncated, false);
  assert.ok(trace.startedAtMs <= trace.spawnedAtMs!);
  assert.ok(trace.spawnedAtMs! <= trace.exitedAtMs!);
  assert.ok(trace.exitedAtMs! <= trace.closedAtMs!);
  const streams = ['stdout', 'stderr'].map((stream) =>
    Buffer.concat(
      trace.chunks
        .filter((chunk) => chunk.stream === stream)
        .map((chunk) => Buffer.from(chunk.base64, 'base64')),
    ).toString(),
  );
  assert.deepEqual(streams, ['first phase\n', 'second phase\n']);
  assert.equal(trace.outputBytes, Buffer.byteLength(streams.join('')));
  assert.equal(trace.retainedBytes, trace.outputBytes);
  const first = trace.chunks.find((chunk) => chunk.stream === 'stdout')!;
  const second = trace.chunks.find((chunk) => chunk.stream === 'stderr')!;
  assert.ok(
    second.atMs - first.atMs >= 60,
    'The observer must preserve the real inter-phase wait.',
  );
  assert.ok(
    trace.chunks.every(
      (chunk, i) =>
        chunk.atMs >= trace.startedAtMs &&
        chunk.atMs <= trace.closedAtMs! &&
        (!i || chunk.atMs >= trace.chunks[i - 1].atMs),
    ),
  );
});

test('subprocess observation is bounded without cutting off the child output or changing its result', async () => {
  const child = spawn(process.execPath, ['-e', `process.stdout.write(Buffer.alloc(65536,37));`]);
  const trace = observeSubprocess(child, undefined, 32);
  let actualBytes = 0;
  child.stdout.on('data', (chunk) => {
    actualBytes += chunk.length;
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.equal(actualBytes, 65536);
  assert.equal(trace.outputBytes, actualBytes);
  assert.equal(trace.retainedBytes, 32);
  assert.equal(trace.truncated, true);
  assert.deepEqual(
    Buffer.concat(trace.chunks.map((chunk) => Buffer.from(chunk.base64, 'base64'))),
    Buffer.alloc(32, 37),
  );
});
