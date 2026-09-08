import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearHistoryBookScreenRect } from './clearHistoryBook.ts';
import { BASE_TILE } from './pyramid.ts';

// An arbitrary stand-in for the art's decoded pixel size - drawing reads the
// real decoded size at runtime, not a constant, so this exercises the
// scaling math independent of whatever the real asset happens to be.
const ICON_SIZE = { w: 345, h: 241 };

test("the icon is anchored to the TILE's lower right corner, not any book's", () => {
  const cellPx = { x: BASE_TILE.w, y: BASE_TILE.h }; // 1x scale
  const rect = clearHistoryBookScreenRect(cellPx, 100, 200, ICON_SIZE);
  assert.equal(rect.w, ICON_SIZE.w);
  assert.equal(rect.h, ICON_SIZE.h);
  // Right/bottom edges of the icon meet the right/bottom edges of the tile -
  // an earlier version anchored to the "forget searches" book's own bounding
  // box instead, landing this deep inside the shelf rather than at the edge.
  assert.equal(rect.x + rect.w, 100 + cellPx.x);
  assert.equal(rect.y + rect.h, 200 + cellPx.y);
});

test('halving the scale halves the icon', () => {
  const full = clearHistoryBookScreenRect({ x: BASE_TILE.w, y: BASE_TILE.h }, 0, 0, ICON_SIZE);
  const half = clearHistoryBookScreenRect({ x: BASE_TILE.w / 2, y: BASE_TILE.h / 2 }, 0, 0, ICON_SIZE);
  assert.equal(half.w, full.w / 2);
  assert.equal(half.h, full.h / 2);
});
