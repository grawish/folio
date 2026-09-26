import { withPdfJob } from './pdf-job';
import type { PdfAnnotation, RenderedPdf, PdfInspection } from './shared/ai';
import { checkPdfPages, checkPdfPageSize } from './pdf-policy';

export function inspectPdf(pdf: Uint8Array): Promise<PdfInspection> {
  return withPdfJob(pdf, 15_000, async (documentPdf) => {
    if (documentPdf.numPages < 1 || documentPdf.numPages > 20)
      throw new Error('PDF validation supports up to 20 pages.');
    // No canvases, text layers or image encoding are needed to compare pagination.
    for (let number = 1; number <= documentPdf.numPages; number++) {
      const page = await documentPdf.getPage(number);
      checkPdfPageSize(page.getViewport({ scale: 1 }), number);
      page.cleanup();
    }
    return { pageCount: documentPdf.numPages };
  });
}

export function drawAnnotation(
  context: CanvasRenderingContext2D,
  note: PdfAnnotation,
  width: number,
  height: number,
) {
  const { x, y, width: w, height: h } = note.rect;
  context.save();
  context.strokeStyle = '#0ba9be';
  context.lineWidth = Math.max(2, width / 450);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (note.kind === 'highlight') {
    context.fillStyle = '#44cfe75c';
    context.fillRect(x * width, y * height, w * width, h * height);
  } else if (note.kind === 'pen' && note.points?.length) {
    context.beginPath();
    note.points.forEach((p, i) =>
      i ? context.lineTo(p.x * width, p.y * height) : context.moveTo(p.x * width, p.y * height),
    );
    context.stroke();
  } else if (note.kind === 'rectangle')
    context.strokeRect(x * width, y * height, w * width, h * height);
  else {
    context.beginPath();
    context.arc(x * width, y * height, 10, 0, Math.PI * 2);
    context.fillStyle = '#0ba9be';
    context.fill();
  }
  context.restore();
}

export function cropNote(canvas: HTMLCanvasElement, annotation: PdfAnnotation): string {
  const { width, height } = canvas,
    rect = annotation.rect;
  const padding = 35;
  const x = Math.max(0, Math.floor(rect.x * width) - padding),
    y = Math.max(0, Math.floor(rect.y * height) - padding);
  const right = Math.min(width, Math.ceil((rect.x + Math.max(rect.width, 0.1)) * width) + padding);
  const bottom = Math.min(
    height,
    Math.ceil((rect.y + Math.max(rect.height, 0.025)) * height) + padding,
  );
  const crop = document.createElement('canvas');
  crop.width = right - x;
  crop.height = bottom - y;
  crop
    .getContext('2d')!
    .drawImage(canvas, x, y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return crop.toDataURL('image/jpeg', 0.85);
}

export async function renderPdfFeedback(
  pdf: Uint8Array,
  annotations: PdfAnnotation[] = [],
): Promise<RenderedPdf> {
  return withPdfJob(pdf, 45_000, async (documentPdf) => {
    if (documentPdf.numPages > 20)
      throw new Error(
        'Visual review supports up to 20 PDF pages. Reduce the document before sending.',
      );
    if (annotations.some((note) => note.page > documentPdf.numPages))
      throw new Error('A PDF note refers to a missing page.');
    const output: RenderedPdf = { pages: [], notes: [] };
    let bytes = 0;
    for (let number = 1; number <= documentPdf.numPages; number++) {
      const page = await documentPdf.getPage(number);
      checkPdfPageSize(page.getViewport({ scale: 1 }), number);
      const base = page.getViewport({ scale: 1 }),
        viewport = page.getViewport({ scale: Math.min(1200 / base.width, 1700 / base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport, background: 'white' }).promise;
      const text = (await page.getTextContent()).items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .slice(0, 100_000);
      const notes = annotations.filter((note) => note.page === number);
      const context = canvas.getContext('2d')!;
      notes.forEach((note) => drawAnnotation(context, note, canvas.width, canvas.height));
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      output.pages.push({ page: number, text, dataUrl });
      bytes += dataUrl.length;
      for (const note of notes) {
        const dataUrl = cropNote(canvas, note);
        output.notes.push({ annotationId: note.id, page: number, dataUrl });
        bytes += dataUrl.length;
      }
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
      if (bytes > 8 * 1024 * 1024)
        throw new Error(
          'These PDF images are too large to send. Attach fewer notes or reduce the page count.',
        );
    }
    // Crop order follows the supplied notes, even when the user selects page 2 before page 1.
    output.notes.sort(
      (a, b) =>
        annotations.findIndex((n) => n.id === a.annotationId) -
        annotations.findIndex((n) => n.id === b.annotationId),
    );
    return output;
  });
}

export async function renderNoteThumbnail(pdf: Uint8Array, note: PdfAnnotation): Promise<string> {
  return withPdfJob(pdf, 15_000, async (documentPdf) => {
    checkPdfPages(documentPdf.numPages);
    const page = await documentPdf.getPage(note.page);
    const base = page.getViewport({ scale: 1 });
    checkPdfPageSize(base, note.page);
    const viewport = page.getViewport({ scale: Math.min(800 / base.width, 1200 / base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport, background: 'white' }).promise;
    drawAnnotation(canvas.getContext('2d')!, note, canvas.width, canvas.height);
    const image = cropNote(canvas, note);
    canvas.width = 0;
    canvas.height = 0;
    return image;
  });
}
