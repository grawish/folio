// Application bounds, not an operating-system memory quota. PDF.js can also
// allocate fonts, decoded images and worker structures outside these canvases.
export const PDF_LIMITS = {
  bytes: 25 * 1024 * 1024,
  pages: 100,
  loadMs: 15_000,
  renderMs: 15_000,
  pagePixels: 4 * 1024 * 1024,
  viewerPixels: 16 * 1024 * 1024,
  canvasSide: 8192,
} as const;

export type PdfPageSize = { width: number; height: number };
export type PdfPageLayout = PdfPageSize & { top: number; bottom: number };

export function checkPdfBytes(data: Uint8Array) {
  if (!data.byteLength || data.byteLength > PDF_LIMITS.bytes)
    throw new Error('PDF preview supports files up to 25 MB. Reduce images or split the document.');
}

export function checkPdfPages(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > PDF_LIMITS.pages)
    throw new Error('PDF preview supports up to 100 pages. Split the document and build it again.');
}

export function checkPdfPageSize(size: PdfPageSize, page: number) {
  const { width, height } = size;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 14_400 ||
    height > 14_400 ||
    height / width > 10 ||
    width / height > 10
  )
    throw new Error(
      `PDF page ${page} has an unsupported size. Use a standard paper size and build again.`,
    );
  return { width, height };
}

export function pdfPageLayout(sizes: readonly PdfPageSize[], width: number): PdfPageLayout[] {
  let top = 8;
  return sizes.map((size) => {
    const height = (width * size.height) / size.width;
    const result = { width, height, top, bottom: top + height };
    top += height + 12;
    return result;
  });
}

export function visiblePdfPages(layout: readonly PdfPageLayout[], top: number, height: number) {
  if (!layout.length) return { start: 0, end: -1, page: 1 };
  let first = layout.findIndex((size) => size.bottom > top);
  if (first < 0) first = layout.length - 1;
  let last = first;
  while (last + 1 < layout.length && layout[last + 1].top < top + height) last++;
  // The mostly visible page drives the page indicator, including manual scroll.
  let current = first,
    overlap = -1;
  for (let i = first; i <= last; i++) {
    const amount = Math.min(layout[i].bottom, top + height) - Math.max(layout[i].top, top);
    if (amount > overlap) {
      overlap = amount;
      current = i;
    }
  }
  return {
    start: Math.max(0, first - 1),
    end: Math.min(layout.length - 1, last + 1),
    page: current + 1,
  };
}

export function pdfScrollAnchor(layout: readonly PdfPageLayout[], top: number) {
  let page = layout.findIndex((size) => size.bottom > top);
  if (page < 0) page = Math.max(0, layout.length - 1);
  return { page, fraction: layout[page] ? (top - layout[page].top) / layout[page].height : 0 };
}

export function pdfScrollPosition(
  layout: readonly PdfPageLayout[],
  anchor: ReturnType<typeof pdfScrollAnchor>,
) {
  const size = layout[Math.min(anchor.page, layout.length - 1)];
  return size ? size.top + anchor.fraction * size.height : 0;
}

export function pdfCanvasSize(width: number, height: number, ratio: number, visibleCount = 1) {
  const pixels = Math.min(
    PDF_LIMITS.pagePixels,
    PDF_LIMITS.viewerPixels / Math.max(1, visibleCount),
  );
  const scale = Math.min(
    Math.max(1, Number.isFinite(ratio) ? ratio : 1),
    Math.sqrt(pixels / (width * height)),
    PDF_LIMITS.canvasSide / width,
    PDF_LIMITS.canvasSide / height,
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
