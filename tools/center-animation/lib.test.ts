import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeBounds,
  unionBounds,
  boundsSize,
  boundsToRect,
  packLayout,
  frameCellAt,
  type Bounds,
} from './lib.ts';

test('mergeBounds treats null as no content', () => {
  const b: Bounds = { x0: 2, y0: 3, x1: 5, y1: 7 };
  assert.deepEqual(mergeBounds(null, b), b);
  assert.deepEqual(mergeBounds(b, null), b);
  assert.equal(mergeBounds(null, null), null);
});

test('mergeBounds is the smallest covering box', () => {
  const a: Bounds = { x0: 2, y0: 4, x1: 6, y1: 8 };
  const b: Bounds = { x0: 1, y0: 5, x1: 5, y1: 10 };
  assert.deepEqual(mergeBounds(a, b), { x0: 1, y0: 4, x1: 6, y1: 10 });
});

test('unionBounds folds a frame list and ignores empty frames', () => {
  const list: (Bounds | null)[] = [
    { x0: 10, y0: 10, x1: 12, y1: 12 },
    null,
    { x0: 8, y0: 11, x1: 20, y1: 15 },
  ];
  assert.deepEqual(unionBounds(list), { x0: 8, y0: 10, x1: 20, y1: 15 });
  assert.equal(unionBounds([null, null]), null);
});

test('boundsSize reads a half-open box as width/height', () => {
  assert.deepEqual(boundsSize({ x0: 525, y0: 392, x1: 584, y1: 478 }), { w: 59, h: 86 });
});

test('boundsToRect divides per axis against the tile', () => {
  const rect = boundsToRect({ x0: 512, y0: 384, x1: 1024, y1: 768 }, { w: 1024, h: 768 });
  assert.deepEqual(rect, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
});

test('packLayout defaults to a near-square grid that holds every frame', () => {
  const layout = packLayout(16, { w: 59, h: 86 });
  assert.equal(layout.columns, 4);
  assert.equal(layout.rows, 4);
  assert.deepEqual(layout.sheet, { w: 236, h: 344 });
});

test('packLayout adds a partial final row when frames do not fill the grid', () => {
  const layout = packLayout(15, { w: 10, h: 20 });
  assert.equal(layout.columns, 4);
  assert.equal(layout.rows, 4); // ceil(15/4)
  assert.deepEqual(layout.sheet, { w: 40, h: 80 });
});

test('packLayout honours an explicit column count', () => {
  const layout = packLayout(16, { w: 10, h: 10 }, 16);
  assert.equal(layout.columns, 16);
  assert.equal(layout.rows, 1);
  assert.deepEqual(layout.sheet, { w: 160, h: 10 });
});

test('packLayout rejects an empty cycle', () => {
  assert.throws(() => packLayout(0, { w: 10, h: 10 }));
});

test('frameCellAt walks left-to-right then wraps down a row', () => {
  const layout = packLayout(16, { w: 59, h: 86 });
  assert.deepEqual(frameCellAt(0, layout), { left: 0, top: 0 });
  assert.deepEqual(frameCellAt(3, layout), { left: 177, top: 0 });
  assert.deepEqual(frameCellAt(4, layout), { left: 0, top: 86 });
  assert.deepEqual(frameCellAt(15, layout), { left: 177, top: 258 });
});
