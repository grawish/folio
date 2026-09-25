import {
  getDocument,
  PDFWorker,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { checkPdfBytes, PDF_LIMITS } from './pdf-policy';

export type PdfJob = { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> };

// Own the actual Worker, including while the PDF.js setup promise is pending.
// PDFDocumentLoadingTask.destroy() alone can wait indefinitely for that setup
// or for a stuck operator stream's termination acknowledgement.
export function createPdfJob(data: Uint8Array): PdfJob {
  checkPdfBytes(data);
  const url = URL.createObjectURL(
    new Blob([`await import(${JSON.stringify(new URL(workerUrl, window.location.href).href)});`], {
      type: 'text/javascript',
    }),
  );
  let port: Worker;
  try {
    port = new Worker(url, { type: 'module' });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  let worker: PDFWorker | undefined, task: PDFDocumentLoadingTask | undefined;
  let closed = false;
  let stopWaiting = () => {};
  // A module imported through a blob may not have installed its message
  // handler yet. Supplied PDFWorker ports assume the caller did this handshake.
  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      port.removeEventListener('message', message);
      port.removeEventListener('error', failed);
    };
    const message = (event: MessageEvent) => {
      if (event.data?.sourceName !== 'worker' || event.data?.action !== 'ready') return;
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error('The PDF worker could not start. Reopen Folio and try again.'));
    };
    stopWaiting = () => {
      cleanup();
      reject(new Error('PDF loading was cancelled.'));
    };
    port.addEventListener('message', message);
    port.addEventListener('error', failed);
  });
  const promise = ready.then(() => {
    if (closed) throw new Error('PDF loading was cancelled.');
    worker = PDFWorker.create({ port });
    task = getDocument({
      data: data.slice(),
      worker,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      stopAtErrors: true,
      canvasMaxAreaInBytes: PDF_LIMITS.pagePixels * 4,
    });
    return task.promise;
  });
  let shutdown: Promise<void> | undefined;
  return {
    promise,
    destroy() {
      shutdown ??= (async () => {
        closed = true;
        stopWaiting();
        let timer = 0;
        try {
          await Promise.race([
            task?.destroy().catch(() => {}),
            new Promise<void>((resolve) => {
              timer = window.setTimeout(resolve, 200);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          // Supplied worker ports are caller-owned; terminate independently of
          // PDF.js cleanup, and never fall back to parsing on the UI thread.
          worker?.destroy();
          port.terminate();
          URL.revokeObjectURL(url);
        }
      })();
      return shutdown;
    },
  };
}

export async function withPdfJob<T>(
  data: Uint8Array,
  milliseconds: number,
  work: (document: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  const job = createPdfJob(data);
  let timer = 0;
  try {
    return await Promise.race([
      job.promise.then(work),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () =>
            reject(
              new Error(
                'PDF rendering took too long. Reduce its size or complexity and try again.',
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await job.destroy();
  }
}
