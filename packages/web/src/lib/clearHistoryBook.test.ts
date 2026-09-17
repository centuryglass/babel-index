import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearHistoryBookScreenRect } from './clearHistoryBook.ts';
import { BASE_TILE } from './pyramid.ts';

// A stand-in for the art's decoded pixel size - the real size is read from
// the decoded image at runtime, so the math is exercised against a fixed
// value, independent of the actual asset.
const ICON_SIZE = { w: 345, h: 241 };

test("the icon is anchored to the TILE's lower right corner, not any book's", () => {
  const cellPx = { x: BASE_TILE.w, y: BASE_TILE.h }; // 1x scale
  const rect = clearHistoryBookScreenRect(cellPx, 100, 200, ICON_SIZE);
  assert.equal(rect.w, ICON_SIZE.w);
  assert.equal(rect.h, ICON_SIZE.h);
  // The icon's right/bottom edges meet the tile's right/bottom edges - the
  // anchor is the tile corner, not the book's own rect (see the source
  // header for why that would land inside the shelf).
  assert.equal(rect.x + rect.w, 100 + cellPx.x);
  assert.equal(rect.y + rect.h, 200 + cellPx.y);
});

test('halving the scale halves the icon', () => {
  const full = clearHistoryBookScreenRect({ x: BASE_TILE.w, y: BASE_TILE.h }, 0, 0, ICON_SIZE);
  const half = clearHistoryBookScreenRect({ x: BASE_TILE.w / 2, y: BASE_TILE.h / 2 }, 0, 0, ICON_SIZE);
  assert.equal(half.w, full.w / 2);
  assert.equal(half.h, full.h / 2);
});
