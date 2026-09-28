// Deterministic raster comparison for the PDF change-highlight overlay. Pure
// pixel-grid math so it stays unit-testable without a canvas or pdf.js.
export type RasterFrame = { width: number; height: number; data: Uint8ClampedArray };
// Page-relative fractions (0..1) so callers can place highlights at any zoom.
export type NormalizedRect = { x: number; y: number; width: number; height: number };
export type ChangeRegion = NormalizedRect & { kind: 'changed' | 'removed' };

// Comparison cell size in raster pixels, and the tolerance for anti-aliasing
// noise between two independently rendered canvases of the same PDF page.
const CELL = 12;
const CHANNEL_THRESHOLD = 28;
const DIRTY_PIXEL_RATIO = 0.06;
const NEIGHBOURS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function contentFraction(frame: RasterFrame, x0: number, y0: number, x1: number, y1: number) {
  let content = 0,
    total = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * frame.width * 4;
    for (let x = x0; x < x1; x++) {
      const i = row + x * 4;
      total++;
      // Resume PDFs render on a white page background; distance from white
      // is a cheap, domain-appropriate proxy for "has content here".
      if (255 - frame.data[i] > 20 || 255 - frame.data[i + 1] > 20 || 255 - frame.data[i + 2] > 20)
        content++;
    }
  }
  return total ? content / total : 0;
}

/**
 * Groups pixel differences between two same-size renders of a PDF page into
 * readable rectangles, snapping to supplied text geometry when it overlaps a
 * detected patch. Returns an empty array for visually identical pages.
 */
export function diffRasterRegions(
  before: RasterFrame,
  after: RasterFrame,
  textRects: readonly NormalizedRect[] = [],
): ChangeRegion[] {
  if (before.width !== after.width || before.height !== after.height)
    return [{ x: 0, y: 0, width: 1, height: 1, kind: 'changed' }];
  const { width, height } = after;
  if (!width || !height) return [];
  const cols = Math.ceil(width / CELL),
    rows = Math.ceil(height / CELL);
  const dirty = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    const y0 = cy * CELL,
      y1 = Math.min(height, y0 + CELL);
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * CELL,
        x1 = Math.min(width, x0 + CELL);
      let differing = 0,
        total = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width * 4;
        for (let x = x0; x < x1; x++) {
          const i = row + x * 4;
          total++;
          if (
            Math.abs(before.data[i] - after.data[i]) > CHANNEL_THRESHOLD ||
            Math.abs(before.data[i + 1] - after.data[i + 1]) > CHANNEL_THRESHOLD ||
            Math.abs(before.data[i + 2] - after.data[i + 2]) > CHANNEL_THRESHOLD ||
            Math.abs(before.data[i + 3] - after.data[i + 3]) > CHANNEL_THRESHOLD
          )
            differing++;
        }
      }
      if (total && differing / total >= DIRTY_PIXEL_RATIO) dirty[cy * cols + cx] = 1;
    }
  }
  // Dilate by one cell so adjacent dirty patches (e.g. a rewrapped line) merge
  // into a single readable region instead of a scatter of tiny boxes.
  const dilated = new Uint8Array(dirty);
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      if (!dirty[cy * cols + cx]) continue;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = cx + dx,
          ny = cy + dy;
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) dilated[ny * cols + nx] = 1;
      }
    }
  const visited = new Uint8Array(cols * rows);
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (!dilated[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      sawDirty = false;
    while (stack.length) {
      const idx = stack.pop()!;
      const cx = idx % cols,
        cy = (idx / cols) | 0;
      if (dirty[idx]) {
        sawDirty = true;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
      }
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = cx + dx,
          ny = cy + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const nIdx = ny * cols + nx;
        if (dilated[nIdx] && !visited[nIdx]) {
          visited[nIdx] = 1;
          stack.push(nIdx);
        }
      }
    }
    if (!sawDirty) continue;
    boxes.push({
      x0: minX * CELL,
      y0: minY * CELL,
      x1: Math.min(width, (maxX + 1) * CELL),
      y1: Math.min(height, (maxY + 1) * CELL),
    });
  }
  const regions: ChangeRegion[] = boxes.map(({ x0, y0, x1, y1 }) => {
    // Snap against text geometry that overlaps the *original* pixel bounds
    // only, so one matched word cannot chain-expand across a whole line.
    let sx0 = x0,
      sy0 = y0,
      sx1 = x1,
      sy1 = y1;
    for (const rect of textRects) {
      const rx0 = rect.x * width,
        ry0 = rect.y * height,
        rx1 = rx0 + rect.width * width,
        ry1 = ry0 + rect.height * height;
      if (rx1 <= x0 || rx0 >= x1 || ry1 <= y0 || ry0 >= y1) continue;
      sx0 = Math.min(sx0, rx0);
      sy0 = Math.min(sy0, ry0);
      sx1 = Math.max(sx1, rx1);
      sy1 = Math.max(sy1, ry1);
    }
    const bx0 = Math.max(0, Math.round(sx0)),
      by0 = Math.max(0, Math.round(sy0)),
      bx1 = Math.min(width, Math.round(sx1)),
      by1 = Math.min(height, Math.round(sy1));
    const beforeContent = contentFraction(before, bx0, by0, bx1, by1),
      afterContent = contentFraction(after, bx0, by0, bx1, by1);
    const kind: ChangeRegion['kind'] =
      beforeContent > 0.02 && afterContent < beforeContent * 0.5 ? 'removed' : 'changed';
    return {
      x: bx0 / width,
      y: by0 / height,
      width: (bx1 - bx0) / width,
      height: (by1 - by0) / height,
      kind,
    };
  });
  // A final merge pass: text snapping above can make two originally distinct
  // boxes overlap once expanded to word/line boundaries.
  regions.sort((a, b) => a.y - b.y || a.x - b.x);
  const merged: ChangeRegion[] = [];
  for (const region of regions) {
    const overlap = merged.find(
      (m) =>
        m.kind === region.kind &&
        region.x < m.x + m.width &&
        m.x < region.x + region.width &&
        region.y < m.y + m.height &&
        m.y < region.y + region.height,
    );
    if (overlap) {
      const x1 = Math.max(overlap.x + overlap.width, region.x + region.width);
      const y1 = Math.max(overlap.y + overlap.height, region.y + region.height);
      overlap.x = Math.min(overlap.x, region.x);
      overlap.y = Math.min(overlap.y, region.y);
      overlap.width = x1 - overlap.x;
      overlap.height = y1 - overlap.y;
    } else merged.push({ ...region });
  }
  return merged;
}
