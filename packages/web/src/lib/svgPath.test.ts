import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenPath, pointInPolygon, parsePath } from './svgPath.ts';

const SQUARE = 'M0,0 L1,0 L1,1 L0,1 Z';

test('flattenPath walks M/L into on-curve points, in order', () => {
  const pts = flattenPath(SQUARE);
  assert.deepEqual(pts, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]);
});

test('flattenPath samples a cubic segment, landing on its endpoint', () => {
  const pts = flattenPath('M0,0 C0,1 1,1 1,0', 4);
  assert.equal(pts.length, 5); // the M point plus 4 samples
  const last = pts[pts.length - 1];
  assert.ok(Math.abs(last.x - 1) < 1e-9 && Math.abs(last.y - 0) < 1e-9);
});

test('pointInPolygon is true inside a square, false outside', () => {
  const poly = flattenPath(SQUARE);
  assert.equal(pointInPolygon(0.5, 0.5, poly), true);
  assert.equal(pointInPolygon(2, 2, poly), false);
});

test('parsePath preserves M/L/C/Z as structured commands, not flattened points', () => {
  const cmds = parsePath('M0,0 L1,0 C1,1 0,1 0,0 Z');
  assert.deepEqual(cmds, [
    { type: 'M', x: 0, y: 0 },
    { type: 'L', x: 1, y: 0 },
    { type: 'C', x1: 1, y1: 1, x2: 0, y2: 1, x: 0, y: 0 },
    { type: 'Z' },
  ]);
});
