import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDF_LIMITS,
  checkPdfBytes,
  checkPdfPages,
  checkPdfPageSize,
  pdfPageLayout,
  visiblePdfPages,
  pdfCanvasSize,
  pdfScrollAnchor,
  pdfScrollPosition,
} from '../src/pdf-policy';

test('PDF admission accepts the boundary and rejects oversized counts, bytes and page geometry', () => {
  checkPdfBytes(new Uint8Array(PDF_LIMITS.bytes));
  assert.throws(() => checkPdfBytes(new Uint8Array(PDF_LIMITS.bytes + 1)), /25 MB/);
  assert.throws(() => checkPdfBytes(new Uint8Array()), /25 MB/);
  checkPdfPages(100);
  for (const count of [0, -1, 1.5, 101, Infinity, NaN])
    assert.throws(() => checkPdfPages(count), /100 pages/);
  for (const size of [
    { width: 0, height: 800 },
    { width: 600, height: Infinity },
    { width: 1, height: 100 },
    { width: 600, height: 14401 },
  ])
    assert.throws(() => checkPdfPageSize(size, 7), /page 7/);
  assert.deepEqual(checkPdfPageSize({ width: 842, height: 595 }, 1), { width: 842, height: 595 });
});

test('virtual page ranges contain the visible pages and immediate neighbours without rendering the whole document', () => {
  const layout = pdfPageLayout(
    Array.from({ length: 100 }, () => ({ width: 600, height: 800 })),
    600,
  );
  assert.deepEqual(visiblePdfPages(layout, 0, 900), { start: 0, end: 2, page: 1 });
  const middle = visiblePdfPages(layout, layout[49].top, 900);
  assert.deepEqual(middle, { start: 48, end: 51, page: 50 });
  assert.deepEqual(visiblePdfPages(layout, layout[99].top, 800), { start: 98, end: 99, page: 100 });
  assert.equal(visiblePdfPages(layout, layout[0].bottom - 50, 800).page, 2);
  // When many short landscape pages genuinely fit, all visible ones remain
  // available. The separate shared pixel budget still bounds their canvases.
  const short = pdfPageLayout(
    Array.from({ length: 100 }, () => ({ width: 800, height: 100 })),
    160,
  );
  const range = visiblePdfPages(short, 0, 900);
  assert.ok(range.end > 20 && range.end < 100);
});

test('exact mixed page geometry keeps navigation offsets stable across width and zoom', () => {
  const sizes = [
    { width: 600, height: 800 },
    { width: 800, height: 400 },
    { width: 600, height: 900 },
  ];
  assert.deepEqual(
    pdfPageLayout(sizes, 600).map((p) => [p.height, p.top]),
    [
      [800, 8],
      [300, 820],
      [900, 1132],
    ],
  );
  assert.deepEqual(
    pdfPageLayout(sizes, 1200).map((p) => [p.height, p.top]),
    [
      [1600, 8],
      [600, 1620],
      [1800, 2232],
    ],
  );
});

test('high-DPI, zoomed, tall and wide canvases stay within the per-page and shared pixel budgets', () => {
  for (const count of [1, 2, 4, 8, 32, 100])
    for (const ratio of [1, 2, 4, 10, Infinity])
      for (const [width, height] of [
        [850, 1200],
        [1530, 15300],
        [15300, 1530],
        [96, 9.6],
      ]) {
        const canvas = pdfCanvasSize(width, height, ratio, count);
        assert.ok(canvas.width > 0 && canvas.height > 0);
        assert.ok(canvas.width <= PDF_LIMITS.canvasSide && canvas.height <= PDF_LIMITS.canvasSide);
        assert.ok(canvas.width * canvas.height <= PDF_LIMITS.pagePixels);
        assert.ok(canvas.width * canvas.height * count <= PDF_LIMITS.viewerPixels);
      }
});

test('scroll anchors preserve the position within a page after zoom and clamp a shorter replacement', () => {
  const sizes = [
    { width: 600, height: 800 },
    { width: 800, height: 400 },
    { width: 600, height: 900 },
  ];
  const before = pdfPageLayout(sizes, 600);
  const anchor = pdfScrollAnchor(before, before[2].top + before[2].height / 3);
  assert.deepEqual(anchor, { page: 2, fraction: 1 / 3 });
  const zoomed = pdfPageLayout(sizes, 1200);
  assert.equal(pdfScrollPosition(zoomed, anchor), zoomed[2].top + zoomed[2].height / 3);
  const shorter = pdfPageLayout(sizes.slice(0, 1), 600);
  assert.ok(
    Math.abs(pdfScrollPosition(shorter, anchor) - (shorter[0].top + shorter[0].height / 3)) < 1e-8,
  );
  assert.equal(pdfScrollPosition([], anchor), 0);
});
