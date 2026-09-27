import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const attempts = 3;
const maxArchiveBytes = 128 * 1024 * 1024;
const transientStatus = new Set([408, 429, 500, 502, 503, 504]);
const transientCode = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function retryable(error) {
  return (
    error?.retryable === true ||
    error?.name === 'TimeoutError' ||
    transientCode.has(error?.code) ||
    transientCode.has(error?.cause?.code)
  );
}

function retryAfter(value) {
  if (!value) return 0;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isNaN(milliseconds) ? 0 : Math.max(0, milliseconds);
}

async function download(url, digest, { fetchImpl, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Runtime archive download timed out.', 'TimeoutError')),
    timeoutMs,
  );
  let reader;
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`Runtime archive HTTP ${response.status}.`);
      error.retryAfterMs = retryAfter(response.headers.get('retry-after'));
      // A longer server-requested wait is left for a later setup run.
      error.retryable = transientStatus.has(response.status) && error.retryAfterMs <= 30_000;
      throw error;
    }
    if (!response.body) throw new Error('Runtime archive response has no body.');
    reader = response.body.getReader();
    const declaredBytes = response.headers.get('content-length');
    if (declaredBytes && Number(declaredBytes) > maxBytes)
      throw new Error('Runtime archive exceeds its download size limit.');
    const chunks = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maxBytes) throw new Error('Runtime archive exceeds its download size limit.');
      chunks.push(next.value);
    }
    const bytes = Buffer.concat(chunks, size);
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new Error('Runtime archive checksum mismatch. Download rejected.');
    return bytes;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
}

// Developer setup only: returned bytes are verified before the caller caches or extracts them.
export async function downloadRuntimeArchive(
  url,
  digest,
  {
    fetchImpl = fetch,
    timeoutMs = 300_000,
    maxBytes = maxArchiveBytes,
    retryDelayMs = 1000,
    onRetry = () => {},
  } = {},
) {
  if (
    new URL(url).protocol !== 'https:' ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > maxArchiveBytes ||
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < 0 ||
    retryDelayMs > 1000
  )
    throw new Error('Invalid runtime archive download configuration.');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await download(url, digest, { fetchImpl, timeoutMs, maxBytes });
    } catch (error) {
      if (!retryable(error)) throw error;
      if (attempt === attempts)
        throw new Error(
          `Runtime archive download failed after ${attempts} attempts. Retry setup later.`,
          { cause: error },
        );
      const delayMs = Math.max(retryDelayMs * attempt, error.retryAfterMs ?? 0);
      onRetry({
        attempt: attempt + 1,
        maxAttempts: attempts,
        delayMs,
        reason: error.cause?.code ?? error.code ?? error.message,
      });
      await delay(delayMs);
    }
  }
}
