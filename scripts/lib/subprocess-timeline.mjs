import { performance } from 'node:perf_hooks';

// Observation only: retain bounded raw output and local receipt times. These
// are parent-process timestamps, not native CPU time or internal engine timers.
export function observeSubprocess(child, now = () => performance.now(), limit = 1024 * 1024) {
  const record = {
    startedAtMs: now(),
    outputBytes: 0,
    retainedBytes: 0,
    truncated: false,
    chunks: [],
  };
  const capture = (stream) => (chunk) => {
    const bytes = Buffer.from(chunk);
    record.outputBytes += bytes.length;
    const retained = bytes.subarray(0, Math.max(0, limit - record.retainedBytes));
    if (retained.length) {
      record.chunks.push({ stream, atMs: now(), base64: retained.toString('base64') });
      record.retainedBytes += retained.length;
    }
    if (retained.length < bytes.length) record.truncated = true;
  };
  const stdout = capture('stdout'),
    stderr = capture('stderr');
  child.stdout?.on('data', stdout);
  child.stderr?.on('data', stderr);
  child.once('spawn', () => {
    record.spawnedAtMs = now();
  });
  child.once('error', (error) => {
    record.error = error.message;
  });
  child.once('exit', (code, signal) => {
    record.exitedAtMs = now();
    record.exitCode = code;
    record.signal = signal;
  });
  child.once('close', () => {
    record.closedAtMs = now();
    child.stdout?.off('data', stdout);
    child.stderr?.off('data', stderr);
  });
  return record;
}
