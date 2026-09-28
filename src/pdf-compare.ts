// Deterministic before/after PDF comparison for the AI-change highlight
// overlay. Renders both documents off-screen at a canonical scale (never the
// live viewer's zoom/DPR) and diffs each page in document order, reporting
// pages back through `onPage` in priority order so a viewer can flash visible
// pages before the rest finish.
import type { PDFPageProxy } from 'pdfjs-dist';
import { createPdfJob, type PdfJob } from './pdf-job';
import { PDF_LIMITS } from './pdf-policy';
import { diffRasterRegions, type ChangeRegion, type NormalizedRect } from './pdf-diff';

export type PageComparison =
  | { status: 'unchanged' }
  | { status: 'changed'; regions: ChangeRegion[] }
  | { status: 'inserted' }
  | { status: 'removed' };

export type ComparePdfsOptions = {
  signal: AbortSignal;
  /** 0-indexed inclusive window to diff first; the rest follow lazily. */
  priorityStart?: number;
  priorityEnd?: number;
  onPage(index: number, page: PageComparison): void;
};

// A fixed supersampling factor, independent of the viewer's zoom or the
// display's pixel ratio, so two runs of the same before/after pair always
// compare identical rasters.
const COMPARISON_SCALE = 2;

function canonicalScale(page: PDFPageProxy) {
  const natural = page.getViewport({ scale: 1 });
  return Math.min(
    COMPARISON_SCALE,
    PDF_LIMITS.canvasSide / natural.width,
    PDF_LIMITS.canvasSide / natural.height,
    Math.sqrt(PDF_LIMITS.pagePixels / (natural.width * natural.height)),
  );
}

async function rasterize(page: PDFPageProxy, signal: AbortSignal) {
  const scale = canonicalScale(page);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.round(viewport.width)),
    height = Math.max(1, Math.round(viewport.height));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('An offscreen canvas is unavailable for PDF comparison.');
  // pdf.js accepts any canvas-like object exposing getContext/width/height;
  // its DOM lib types only name HTMLCanvasElement.
  const render = page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport });
  const cancel = () => render.cancel();
  signal.addEventListener('abort', cancel);
  try {
    await render.promise;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  signal.throwIfAborted();
  const { data } = context.getImageData(0, 0, width, height);
  const content = await page.getTextContent();
  signal.throwIfAborted();
  const textRects: NormalizedRect[] = [];
  const [m0, m1, m2, m3, m4, m5] = viewport.transform;
  for (const item of content.items) {
    if (!('str' in item) || !item.str) continue;
    const tx = item.transform;
    const x1 = tx[4],
      y1 = tx[5],
      x2 = tx[4] + item.width,
      y2 = tx[5] + item.height;
    const dx1 = m0 * x1 + m2 * y1 + m4,
      dy1 = m1 * x1 + m3 * y1 + m5;
    const dx2 = m0 * x2 + m2 * y2 + m4,
      dy2 = m1 * x2 + m3 * y2 + m5;
    const rx0 = Math.min(dx1, dx2),
      rx1 = Math.max(dx1, dx2);
    const ry0 = Math.min(dy1, dy2),
      ry1 = Math.max(dy1, dy2);
    textRects.push({
      x: rx0 / width,
      y: ry0 / height,
      width: (rx1 - rx0) / width,
      height: (ry1 - ry0) / height,
    });
  }
  return { frame: { width, height, data }, textRects };
}

/**
 * Compares two PDFs page by page, in document order, reporting results
 * through `onPage` as each page resolves (visible-window pages first, then
 * the rest). Throws if either document fails to open or a page cannot be
 * rasterized; callers should treat that as "comparison unavailable".
 */
export async function comparePdfs(
  before: Uint8Array,
  after: Uint8Array,
  { signal, priorityStart = 0, priorityEnd = -1, onPage }: ComparePdfsOptions,
): Promise<void> {
  const jobs: PdfJob[] = [];
  const open = (data: Uint8Array) => {
    const job = createPdfJob(data);
    jobs.push(job);
    return job.promise;
  };
  try {
    const [beforeDoc, afterDoc] = await Promise.all([open(before), open(after)]);
    signal.throwIfAborted();
    const pageCount = Math.max(beforeDoc.numPages, afterDoc.numPages);
    const order = Array.from({ length: pageCount }, (_, i) => i);
    order.sort((a, b) => {
      const aPriority = a >= priorityStart && a <= priorityEnd ? 0 : 1;
      const bPriority = b >= priorityStart && b <= priorityEnd ? 0 : 1;
      return aPriority - bPriority || a - b;
    });
    for (const index of order) {
      signal.throwIfAborted();
      const number = index + 1;
      const hasBefore = number <= beforeDoc.numPages,
        hasAfter = number <= afterDoc.numPages;
      if (!hasAfter) {
        onPage(index, { status: 'removed' });
        continue;
      }
      if (!hasBefore) {
        onPage(index, { status: 'inserted' });
        continue;
      }
      const [beforePage, afterPage] = await Promise.all([
        beforeDoc.getPage(number),
        afterDoc.getPage(number),
      ]);
      try {
        const [b, a] = await Promise.all([
          rasterize(beforePage, signal),
          rasterize(afterPage, signal),
        ]);
        const regions = diffRasterRegions(b.frame, a.frame, a.textRects);
        onPage(index, regions.length ? { status: 'changed', regions } : { status: 'unchanged' });
      } finally {
        beforePage.cleanup();
        afterPage.cleanup();
      }
    }
  } finally {
    await Promise.all(jobs.map((job) => job.destroy()));
  }
}
