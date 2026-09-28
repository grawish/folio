import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRasterRegions, type RasterFrame } from '../src/pdf-diff';

function whiteFrame(width: number, height: number): RasterFrame {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

function paint(frame: RasterFrame, x0: number, y0: number, x1: number, y1: number, value = 0) {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * frame.width + x) * 4;
      frame.data[i] = frame.data[i + 1] = frame.data[i + 2] = value;
      frame.data[i + 3] = 255;
    }
}

test('identical pages produce no change regions', () => {
  const before = whiteFrame(200, 100);
  paint(before, 10, 10, 60, 30);
  const after: RasterFrame = { ...before, data: before.data.slice() };
  assert.deepEqual(diffRasterRegions(before, after), []);
});

test('a single edited patch becomes one region covering the dirty cells', () => {
  const before = whiteFrame(200, 100);
  const after = whiteFrame(200, 100);
  paint(after, 40, 20, 90, 40);
  const regions = diffRasterRegions(before, after);
  assert.equal(regions.length, 1);
  const [region] = regions;
  assert.equal(region.kind, 'changed');
  // Region covers the painted patch (in normalized page fractions), with
  // dilation/cell-snapping keeping it close but not exact.
  assert.ok(region.x <= 40 / 200 && region.x + region.width >= 90 / 200);
  assert.ok(region.y <= 20 / 100 && region.y + region.height >= 40 / 100);
});

test('two well-separated patches stay as distinct regions', () => {
  const before = whiteFrame(200, 200);
  const after = whiteFrame(200, 200);
  paint(after, 10, 10, 40, 30);
  paint(after, 150, 150, 180, 180);
  const regions = diffRasterRegions(before, after);
  assert.equal(regions.length, 2);
});

test('content that disappears without replacement is reported as removed', () => {
  const before = whiteFrame(200, 100);
  paint(before, 40, 20, 90, 40);
  const after = whiteFrame(200, 100);
  const regions = diffRasterRegions(before, after);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].kind, 'removed');
});

test('text geometry overlapping a dirty patch expands the region to the full word box', () => {
  const before = whiteFrame(200, 100);
  const after = whiteFrame(200, 100);
  paint(after, 40, 20, 60, 30);
  const regions = diffRasterRegions(before, after, [
    { x: 30 / 200, y: 18 / 100, width: 40 / 200, height: 14 / 100 },
  ]);
  assert.equal(regions.length, 1);
  assert.ok(regions[0].x <= 30 / 200);
  assert.ok(regions[0].x + regions[0].width >= 70 / 200);
});

test('mismatched page dimensions report a single full-page region instead of throwing', () => {
  const before = whiteFrame(200, 100);
  const after = whiteFrame(300, 150);
  assert.deepEqual(diffRasterRegions(before, after), [
    { x: 0, y: 0, width: 1, height: 1, kind: 'changed' },
  ]);
});
