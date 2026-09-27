import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { downloadRuntimeArchive } from '../scripts/lib/runtime-download.mjs';

const archive = Buffer.from('synthetic pinned runtime archive');
const digest = createHash('sha256').update(archive).digest('hex');
const source = 'https://runtime.example/archive.tar.gz';

async function fixture(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse, attempt: number) => void,
) {
  let requests = 0;
  const server = createServer((request, response) => handler(request, response, ++requests));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  });
  const fetchImpl: typeof fetch = (url, options) => {
    assert.equal(url, source);
    // Use real HTTP sockets and native fetch, while the production helper requires HTTPS.
    return fetch(`http://127.0.0.1:${address.port}/archive`, options);
  };
  return { fetchImpl, requests: () => requests };
}

test('runtime downloads recover from HTTP 503 and 429, returning only the pinned bytes', async (t) => {
  const server = await fixture(t, (_request, response, attempt) => {
    if (attempt < 3)
      response.writeHead(attempt === 1 ? 503 : 429, { 'Retry-After': '0' }).end('busy');
    else response.end(archive);
  });
  const retries: number[] = [];
  const result = await downloadRuntimeArchive(source, digest, {
    fetchImpl: server.fetchImpl,
    retryDelayMs: 0,
    onRetry: (retry) => retries.push(retry.attempt),
  });
  assert.deepEqual(result, archive);
  assert.deepEqual(retries, [2, 3]);
  assert.equal(server.requests(), 3);
});

test('runtime downloads recover from connection reset and interrupted response bodies', async (t) => {
  const server = await fixture(t, (request, response, attempt) => {
    if (attempt === 1) request.socket.destroy();
    else if (attempt === 2) {
      response.writeHead(200, { 'Content-Length': archive.length });
      response.write(archive.subarray(0, 5));
      setTimeout(() => response.destroy(), 20);
    } else response.end(archive);
  });
  assert.deepEqual(
    await downloadRuntimeArchive(source, digest, { fetchImpl: server.fetchImpl, retryDelayMs: 0 }),
    archive,
  );
  assert.equal(server.requests(), 3);
});

test('runtime attempt deadline covers both waiting for headers and stalled body transfer', async (t) => {
  const server = await fixture(t, (_request, response, attempt) => {
    if (attempt === 1) return;
    if (attempt === 2) {
      response.writeHead(200, { 'Content-Length': archive.length });
      response.write(archive.subarray(0, 5));
    } else response.end(archive);
  });
  assert.deepEqual(
    await downloadRuntimeArchive(source, digest, {
      fetchImpl: server.fetchImpl,
      retryDelayMs: 0,
      timeoutMs: 1000,
    }),
    archive,
  );
  assert.equal(server.requests(), 3);
});

test('runtime download stops after three temporary failures and keeps the last cause', async (t) => {
  const server = await fixture(t, (_request, response) =>
    response.writeHead(502).end('unavailable'),
  );
  await assert.rejects(
    downloadRuntimeArchive(source, digest, { fetchImpl: server.fetchImpl, retryDelayMs: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /failed after 3 attempts/);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /HTTP 502/);
      return true;
    },
  );
  assert.equal(server.requests(), 3);
});

test('runtime retry observes the server delay without allowing an unbounded wait', async (t) => {
  const server = await fixture(t, (_request, response, attempt) => {
    if (attempt === 1) response.writeHead(503, { 'Retry-After': '1' }).end();
    else response.end(archive);
  });
  const waits: number[] = [];
  const started = performance.now();
  await downloadRuntimeArchive(source, digest, {
    fetchImpl: server.fetchImpl,
    retryDelayMs: 0,
    onRetry: ({ delayMs }) => waits.push(delayMs),
  });
  assert.deepEqual(waits, [1000]);
  assert.ok(performance.now() - started >= 990);
  assert.equal(server.requests(), 2);
});

test('runtime download leaves long Retry-After intervals for a later setup run', async (t) => {
  for (const value of ['3600', new Date(Date.now() + 3_600_000).toUTCString()]) {
    const server = await fixture(t, (_request, response) => {
      response.writeHead(503, { 'Retry-After': value }).end();
    });
    await assert.rejects(
      downloadRuntimeArchive(source, digest, { fetchImpl: server.fetchImpl, retryDelayMs: 0 }),
      /HTTP 503/,
    );
    assert.equal(server.requests(), 1);
  }
});

test('runtime download rejects permanent HTTP failures and changed bytes without retrying', async (t) => {
  for (const status of [401, 403, 404, 200]) {
    const server = await fixture(t, (_request, response) =>
      response.writeHead(status).end('changed'),
    );
    await assert.rejects(
      downloadRuntimeArchive(source, digest, { fetchImpl: server.fetchImpl, retryDelayMs: 0 }),
      status === 200 ? /checksum mismatch/ : new RegExp(`HTTP ${status}`),
    );
    assert.equal(server.requests(), 1);
  }
});

test('runtime download rejects oversized declared or streamed bodies without retrying', async (t) => {
  for (const declared of [true, false]) {
    const server = await fixture(t, (_request, response) => {
      if (declared) response.writeHead(200, { 'Content-Length': '1000000' });
      else response.writeHead(200);
      response.write(archive);
      response.end();
    });
    await assert.rejects(
      downloadRuntimeArchive(source, digest, {
        fetchImpl: server.fetchImpl,
        retryDelayMs: 0,
        maxBytes: 10,
      }),
      /size limit/,
    );
    assert.equal(server.requests(), 1);
  }
});

test('runtime download retries the observed Undici connect timeout but rejects certificate errors', async () => {
  for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED']) {
    let requests = 0;
    const fetchImpl: typeof fetch = async () => {
      requests++;
      if (requests === 1)
        throw new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
      return new Response(archive);
    };
    const result = downloadRuntimeArchive(source, digest, { fetchImpl, retryDelayMs: 0 });
    if (code === 'CERT_HAS_EXPIRED') {
      await assert.rejects(result, /fetch failed/);
      assert.equal(requests, 1);
    } else {
      assert.deepEqual(await result, archive);
      assert.equal(requests, 2);
    }
  }
});

test('runtime download rejects invalid pins, non-HTTPS origins and excessive configured bounds before connecting', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error('must not connect');
  };
  for (const options of [
    { timeoutMs: 300_001 },
    { maxBytes: 128 * 1024 * 1024 + 1 },
    { retryDelayMs: 1001 },
  ])
    await assert.rejects(
      downloadRuntimeArchive(source, digest, { fetchImpl, ...options }),
      /configuration/,
    );
  await assert.rejects(
    downloadRuntimeArchive('http://runtime.example/archive', digest, { fetchImpl }),
    /configuration/,
  );
  await assert.rejects(downloadRuntimeArchive(source, 'bad-pin', { fetchImpl }), /configuration/);
});
