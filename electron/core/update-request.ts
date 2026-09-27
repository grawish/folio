import { net, type Session } from 'electron';
import { Readable } from 'node:stream';
import type { UpdateDownloadRequest } from './update-download';

/** Keep Electron's Node stream: its fetch Web-stream bridge can race on abort. */
export function updateDownloadRequest(session: Session): UpdateDownloadRequest {
  return (url, signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const request = net.request({
        url,
        session,
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          Accept: 'application/zip',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-store',
        },
      });
      let body: Readable | undefined;
      const cleanup = () => signal.removeEventListener('abort', abort);
      const abort = () => {
        cleanup();
        request.abort();
        body?.destroy(signal.reason instanceof Error ? signal.reason : undefined);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      request.on('error', (error) => {
        cleanup();
        body?.destroy(error);
        reject(error);
      });
      // In pinned Electron 44, ClientRequest's Writable close can precede its
      // response. Keep cancellation until the response closes, not that event.
      request.on('redirect', (status, _method, location) => {
        cleanup();
        resolve({ status, headers: new Headers({ location }), body: Readable.from([]) });
        // Each redirect starts a fresh request only after the URL policy checks it.
        request.abort();
      });
      request.once('response', (response) => {
        // Electron documents IncomingMessage as a Node Readable; its type
        // declaration lists only events. Avoid converting it to a Web stream.
        body = response as unknown as Readable;
        // Keep early errors handled while the caller opens its file. The async
        // iterator still observes the stream's error and rejects the transfer.
        body.on('error', () => {});
        body.once('close', () => {
          cleanup();
          request.abort();
        });
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        resolve({ status: response.statusCode, headers, body });
      });
      if (signal.aborted) abort();
      else request.end();
    });
}
