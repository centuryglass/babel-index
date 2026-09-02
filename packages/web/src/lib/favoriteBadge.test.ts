import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../../../../tools/center-placement/lib/geometry.ts';
import {
  FAV_ICON_SIZE,
  MIN_FAVORITE_HIT_TOUCH,
  favoriteIconScreenRect,
  favoriteHitRect,
  pointInRect,
  FAVORITE_TOGGLE_PATH,
  favoriteToggleAtPoint,
} from './favoriteBadge.ts';
import { BASE_TILE } from './pyramid.ts';

const GEO = layout({ width: 1, height: 1 });

test('the icon is anchored to the tile\'s upper right corner and scales with cellPx', () => {
  const cellPx = { x: BASE_TILE.w, y: BASE_TILE.h }; // 1x scale
  const rect = favoriteIconScreenRect(cellPx, 100, 200);
  assert.equal(rect.w, FAV_ICON_SIZE.w);
  assert.equal(rect.h, FAV_ICON_SIZE.h);
  // Right edge of the icon meets the right edge of the tile; top edges align.
  assert.equal(rect.x + rect.w, 100 + cellPx.x);
  assert.equal(rect.y, 200);
});

test('halving the scale halves the icon and its hit rect together', () => {
  const full = favoriteIconScreenRect({ x: BASE_TILE.w, y: BASE_TILE.h }, 0, 0);
  const half = favoriteIconScreenRect({ x: BASE_TILE.w / 2, y: BASE_TILE.h / 2 }, 0, 0);
  assert.equal(half.w, full.w / 2);
  assert.equal(half.h, full.h / 2);

  const fullHit = favoriteHitRect(full, { x: BASE_TILE.w, y: BASE_TILE.h }, false);
  const halfHit = favoriteHitRect(half, { x: BASE_TILE.w / 2, y: BASE_TILE.h / 2 }, false);
  assert.equal(halfHit.w, fullHit.w / 2);
  assert.equal(halfHit.h, fullHit.h / 2);
});

test('the hit rect sits inside the icon rect on a mouse', () => {
  const cellPx = { x: 400, y: 300 };
  const icon = favoriteIconScreenRect(cellPx, 50, 60);
  const hit = favoriteHitRect(icon, cellPx, false);
  assert.ok(hit.x >= icon.x && hit.x + hit.w <= icon.x + icon.w);
  assert.ok(hit.y >= icon.y && hit.y + hit.h <= icon.y + icon.h);
});

test('a mouse never pads the hit rect, no matter how small the badge', () => {
  const cellPx = { x: 100, y: 100 };
  const tiny = favoriteIconScreenRect(cellPx, 0, 0);
  const hit = favoriteHitRect(tiny, cellPx, false);
  assert.ok(hit.w < MIN_FAVORITE_HIT_TOUCH);
  assert.ok(hit.h < MIN_FAVORITE_HIT_TOUCH);
});

test('a coarse pointer pads a tiny badge up to the touch floor, centered on the art', () => {
  const cellPx = { x: 1000, y: 1000 }; // large tile - the area cap doesn't bind here
  const tiny = favoriteIconScreenRect({ x: 100, y: 100 }, 0, 0);
  const unpadded = favoriteHitRect(tiny, cellPx, false);
  const padded = favoriteHitRect(tiny, cellPx, true);
  assert.equal(padded.w, MIN_FAVORITE_HIT_TOUCH);
  assert.equal(padded.h, MIN_FAVORITE_HIT_TOUCH);
  assert.ok(Math.abs(padded.x + padded.w / 2 - (unpadded.x + unpadded.w / 2)) < 1e-9);
  assert.ok(Math.abs(padded.y + padded.h / 2 - (unpadded.y + unpadded.h / 2)) < 1e-9);
});

test('a coarse pointer leaves a badge already past the touch floor unpadded', () => {
  const cellPx = { x: 4000, y: 4000 };
  const big = favoriteIconScreenRect(cellPx, 0, 0);
  const padded = favoriteHitRect(big, cellPx, true);
  const unpadded = favoriteHitRect(big, cellPx, false);
  assert.equal(padded.w, unpadded.w);
  assert.equal(padded.h, unpadded.h);
});

test('the touch pad is capped at 10% of the tile\'s own area', () => {
  const cellPx = { x: 30, y: 30 }; // small enough that MIN_FAVORITE_HIT_TOUCH would overshoot the cap
  const tiny = favoriteIconScreenRect(cellPx, 0, 0);
  const hit = favoriteHitRect(tiny, cellPx, true);
  assert.ok(hit.w * hit.h <= cellPx.x * cellPx.y * 0.1 + 1e-9);
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
