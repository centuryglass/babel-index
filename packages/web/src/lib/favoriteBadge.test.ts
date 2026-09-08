import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../../../../tools/center-placement/lib/geometry.ts';
import {
  MIN_FAVORITE_HIT_TOUCH,
  favoriteIconScreenRect,
  favoriteHitRect,
  pointInRect,
  FAVORITE_TOGGLE_PATH,
  favoriteToggleAtPoint,
} from './favoriteBadge.ts';
import { BASE_TILE } from './pyramid.ts';

const GEO = layout({ width: 1, height: 1 });
// An arbitrary stand-in for the art's decoded pixel size - drawing no longer
// reads a hardcoded constant, so these tests supply their own to exercise
// the scaling math independent of whatever the real asset happens to be.
const ICON_SIZE = { w: 92, h: 198 };

test('the icon is anchored to the tile\'s upper right corner and scales with cellPx', () => {
  const cellPx = { x: BASE_TILE.w, y: BASE_TILE.h }; // 1x scale
  const rect = favoriteIconScreenRect(cellPx, 100, 200, ICON_SIZE);
  assert.equal(rect.w, ICON_SIZE.w);
  assert.equal(rect.h, ICON_SIZE.h);
  // Right edge of the icon meets the right edge of the tile; top edges align.
  assert.equal(rect.x + rect.w, 100 + cellPx.x);
  assert.equal(rect.y, 200);
});

test('halving the scale halves the icon', () => {
  const full = favoriteIconScreenRect({ x: BASE_TILE.w, y: BASE_TILE.h }, 0, 0, ICON_SIZE);
  const half = favoriteIconScreenRect({ x: BASE_TILE.w / 2, y: BASE_TILE.h / 2 }, 0, 0, ICON_SIZE);
  assert.equal(half.w, full.w / 2);
  assert.equal(half.h, full.h / 2);
});

test('the mouse hit rect matches the traced bbox scaled per axis, unrelated to icon draw size', () => {
  assert.ok(GEO.favoriteToggle, 'the trace must carry a tile_fav_toggle bbox for this test to mean anything');
  const cellPx = { x: 400, y: 300 };
  const sx = 50;
  const sy = 60;
  const hit = favoriteHitRect(cellPx, sx, sy, false);
  assert.ok(hit);
  const b = GEO.favoriteToggle!.bbox;
  assert.ok(Math.abs(hit!.x - (sx + b.x * cellPx.x)) < 1e-9);
  assert.ok(Math.abs(hit!.y - (sy + b.y * cellPx.y)) < 1e-9);
  assert.ok(Math.abs(hit!.w - b.w * cellPx.x) < 1e-9);
  assert.ok(Math.abs(hit!.h - b.h * cellPx.y) < 1e-9);
});

test('halving cellPx halves the hit rect too', () => {
  const full = favoriteHitRect({ x: BASE_TILE.w, y: BASE_TILE.h }, 0, 0, false);
  const half = favoriteHitRect({ x: BASE_TILE.w / 2, y: BASE_TILE.h / 2 }, 0, 0, false);
  assert.ok(full && half);
  assert.equal(half!.w, full!.w / 2);
  assert.equal(half!.h, full!.h / 2);
});

test('a mouse never pads the hit rect, no matter how small the tile', () => {
  const cellPx = { x: 100, y: 100 };
  const hit = favoriteHitRect(cellPx, 0, 0, false);
  assert.ok(hit);
  assert.ok(hit!.w < MIN_FAVORITE_HIT_TOUCH);
  assert.ok(hit!.h < MIN_FAVORITE_HIT_TOUCH);
});

test('a coarse pointer pads a tiny hit rect up to the touch floor, centered on the traced bbox', () => {
  const cellPx = { x: 100, y: 100 }; // small enough that the bbox lands under the touch floor
  const unpadded = favoriteHitRect(cellPx, 0, 0, false);
  const padded = favoriteHitRect(cellPx, 0, 0, true);
  assert.ok(unpadded && padded);
  assert.ok(unpadded!.w < MIN_FAVORITE_HIT_TOUCH, 'unpadded must actually be under the floor for this test to mean anything');
  assert.equal(padded!.w, MIN_FAVORITE_HIT_TOUCH);
  assert.equal(padded!.h, MIN_FAVORITE_HIT_TOUCH);
  assert.ok(Math.abs(padded!.x + padded!.w / 2 - (unpadded!.x + unpadded!.w / 2)) < 1e-9);
  assert.ok(Math.abs(padded!.y + padded!.h / 2 - (unpadded!.y + unpadded!.h / 2)) < 1e-9);
});

test('a coarse pointer leaves a hit rect already past the touch floor unpadded', () => {
  const cellPx = { x: 4000, y: 4000 };
  const padded = favoriteHitRect(cellPx, 0, 0, true);
  const unpadded = favoriteHitRect(cellPx, 0, 0, false);
  assert.ok(padded && unpadded);
  assert.equal(padded!.w, unpadded!.w);
  assert.equal(padded!.h, unpadded!.h);
});

test('the touch pad is capped at 10% of the tile\'s own area', () => {
  const cellPx = { x: 30, y: 30 }; // small enough that MIN_FAVORITE_HIT_TOUCH would overshoot the cap
  const hit = favoriteHitRect(cellPx, 0, 0, true);
  assert.ok(hit);
  assert.ok(hit!.w * hit!.h <= cellPx.x * cellPx.y * 0.1 + 1e-9);
});

test('pointInRect is inclusive on the low edge, exclusive on the high edge', () => {
  const rect = { x: 10, y: 10, w: 5, h: 5 };
  assert.equal(pointInRect(10, 10, rect), true);
  assert.equal(pointInRect(14.9, 14.9, rect), true);
  assert.equal(pointInRect(15, 10, rect), false);
  assert.equal(pointInRect(10, 15, rect), false);
  assert.equal(pointInRect(9.9, 10, rect), false);
});

test('FAVORITE_TOGGLE_PATH is a closed absolute path tracing the badge', () => {
  assert.ok(FAVORITE_TOGGLE_PATH, 'the trace must carry a tile_fav_toggle path for this test to mean anything');
  assert.match(FAVORITE_TOGGLE_PATH as string, /^M/, 'must start with an absolute moveto');
  assert.match(FAVORITE_TOGGLE_PATH as string, /Z$/, 'must close its subpath');
});

test('favoriteToggleAtPoint hits the traced silhouette but not its own bbox corner', () => {
  assert.ok(GEO.favoriteToggle, 'the trace must carry a tile_fav_toggle path for this test to mean anything');
  const b = GEO.favoriteToggle!.bbox;
  const cellPx = { x: 4000, y: 4000 };
  const sx = 0;
  const sy = 0;
  const cx = sx + (b.x + b.w / 2) * cellPx.x;
  const cy = sy + (b.y + b.h / 2) * cellPx.y;
  assert.equal(favoriteToggleAtPoint(cx, cy, cellPx, sx, sy), true);
  // Well outside the bbox entirely - never hits.
  assert.equal(favoriteToggleAtPoint(sx, sy, cellPx, sx, sy), false);
  // An ellipse's own bbox corner sits outside the curve itself.
  const cornerX = sx + b.x * cellPx.x;
  const cornerY = sy + b.y * cellPx.y;
  assert.equal(favoriteToggleAtPoint(cornerX, cornerY, cellPx, sx, sy), false);
});

test('favoriteToggleAtPoint scales per-axis with cellPx and translates with sx/sy', () => {
  assert.ok(GEO.favoriteToggle);
  const b = GEO.favoriteToggle!.bbox;
  const cellPx = { x: 4000, y: 3000 };
  const sx = 120;
  const sy = 80;
  const cx = sx + (b.x + b.w / 2) * cellPx.x;
  const cy = sy + (b.y + b.h / 2) * cellPx.y;
  assert.equal(favoriteToggleAtPoint(cx, cy, cellPx, sx, sy), true);
});
