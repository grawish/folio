import { useCallback, useEffect, useRef, useState } from 'react';
import { type PDFDocumentProxy } from 'pdfjs-dist';
import { createPdfJob, type PdfJob } from './pdf-job';
import {
  checkPdfBytes,
  checkPdfPages,
  checkPdfPageSize,
  PDF_LIMITS,
  type PdfPageSize,
} from './pdf-policy';

type LoadedPdf = {
  data: Uint8Array;
  document: PDFDocumentProxy;
  task: PdfJob;
  sizes: PdfPageSize[];
};
const emptySizes: PdfPageSize[] = [];

export function usePdfDocument(data?: Uint8Array) {
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const confirmed = useRef<LoadedPdf | null>(null);
  const [failure, setFailure] = useState<{ data: Uint8Array; message: string } | null>(null);
  const error = failure && failure.data === data ? failure.message : '';
  const tasks = useRef(new Set<PdfJob>());
  const release = useCallback((task: PdfJob) => {
    if (tasks.current.delete(task))
      void task.destroy().catch((error) => console.error('PDF cleanup failed', error));
  }, []);

  // Include tasks whose promise resolved just before unmount, but whose state
  // update has not committed yet. Strict Mode also disposes its first load here.
  useEffect(
    () => () => {
      for (const task of tasks.current) release(task);
    },
    [release],
  );

  // A displayed document stays alive until React replaces its pages. Tying
  // destruction to the incoming bytes instead lets a resize render a closed
  // document while the next worker is still loading.
  useEffect(
    () => () => {
      if (loaded && confirmed.current !== loaded) release(loaded.task);
    },
    [loaded, release],
  );

  const confirmRendered = useCallback(() => {
    if (!loaded || loaded.data !== data || error) return;
    const previous = confirmed.current;
    confirmed.current = loaded;
    if (previous && previous !== loaded) release(previous.task);
  }, [loaded, data, error, release]);

  const rejectRender = useCallback(
    (message: string) => {
      if (!loaded) return;
      setFailure({ data: loaded.data, message });
      const previous = confirmed.current === loaded ? null : confirmed.current;
      if (!previous) confirmed.current = null;
      // Retire the rejected pages before destroying their task and worker. A
      // render timeout must not leave stalled text/image work running.
      setLoaded(previous);
    },
    [loaded],
  );

  useEffect(() => {
    setFailure(null);
    if (!data) {
      const previous = confirmed.current;
      confirmed.current = null;
      if (previous && previous !== loaded) release(previous.task);
      setLoaded(null);
      return;
    }
    let disposed = false;
    let published = false;
    let finished = false;
    let task: PdfJob;
    try {
      checkPdfBytes(data);
      task = createPdfJob(data);
    } catch (error) {
      setFailure({ data, message: (error as Error).message });
      return;
    }
    tasks.current.add(task);
    const fail = (message: string) => {
      if (disposed || finished) return;
      finished = true;
      setFailure({ data, message });
      release(task);
    };
    const timeout = window.setTimeout(() => {
      fail('This PDF took too long to open. Reduce its size or complexity and build it again.');
    }, PDF_LIMITS.loadMs);
    void task.promise
      .then(async (document) => {
        if (disposed) return;
        checkPdfPages(document.numPages);
        const sizes: PdfPageSize[] = [];
        // Read only page dimensions, never operator lists or canvases here.
        // Exact sizes keep scroll positions stable for mixed paper sizes.
        for (let number = 1; number <= document.numPages; number++) {
          if (disposed || finished) return;
          const page = await document.getPage(number);
          sizes.push(checkPdfPageSize(page.getViewport({ scale: 1 }), number));
          page.cleanup();
        }
        if (disposed || finished) return;
        finished = true;
        published = true;
        setLoaded({ data, document, task, sizes });
      })
      .catch((error) => {
        fail(error.message);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      disposed = true;
      clearTimeout(timeout);
      // Pending/superseded loads have no visible pages to retain.
      if (!published) release(task);
    };
  }, [data, release]);

  return {
    document: data ? (loaded?.document ?? null) : null,
    sizes: data ? (loaded?.sizes ?? emptySizes) : emptySizes,
    acceptedData: data ? loaded?.data : undefined,
    loading: !!data && loaded?.data !== data && !error,
    error,
    confirmRendered,
    rejectRender,
  };
}
