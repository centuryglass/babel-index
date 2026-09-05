import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../../../../tools/center-placement/lib/geometry.ts';
import {
  DISTILL_ICON_SIZE,
  DISTILL_OFF_PATH,
  DISTILL_ON_PATH,
  distillIconScreenRect,
  distillToggleAtPoint,
} from './distillToggle.ts';
import { BASE_TILE } from './pyramid.ts';

const GEO = layout({ width: 1, height: 1 });

test("the icon is anchored to the tile's lower right corner and scales with cellPx", () => {
  const cellPx = { x: BASE_TILE.w, y: BASE_TILE.h }; // 1x scale
  const rect = distillIconScreenRect(cellPx, 100, 200);
  assert.equal(rect.w, DISTILL_ICON_SIZE.w);
  assert.equal(rect.h, DISTILL_ICON_SIZE.h);
  // Right/bottom edges of the icon meet the right/bottom edges of the tile.
  assert.equal(rect.x + rect.w, 100 + cellPx.x);
  assert.equal(rect.y + rect.h, 200 + cellPx.y);
});

test('halving the scale halves the icon', () => {
  const full = distillIconScreenRect({ x: BASE_TILE.w, y: BASE_TILE.h }, 0, 0);
  const half = distillIconScreenRect({ x: BASE_TILE.w / 2, y: BASE_TILE.h / 2 }, 0, 0);
  assert.equal(half.w, full.w / 2);
  assert.equal(half.h, full.h / 2);
});

test('DISTILL_OFF_PATH/DISTILL_ON_PATH are closed absolute paths tracing the icons', () => {
  assert.ok(DISTILL_OFF_PATH, 'the trace must carry a distill_off path for this test to mean anything');
  assert.ok(DISTILL_ON_PATH, 'the trace must carry a distill_on path for this test to mean anything');
  for (const d of [DISTILL_OFF_PATH, DISTILL_ON_PATH]) {
    assert.match(d as string, /^M/, 'must start with an absolute moveto');
    assert.match(d as string, /Z$/, 'must close its subpath');
  }
});

test('distillToggleAtPoint hits each state\'s own silhouette at its bbox centre, only when that state is active', () => {
  assert.ok(GEO.distillOff && GEO.distillOn, 'the trace must carry both distill icons for this test to mean anything');
  const cellPx = { x: 4000, y: 3000 };
  const sx = 0;
  const sy = 0;

  // The two icons share a corner and so may share bbox space (only their
  // outlines differ) - each is only asserted against its OWN activation, not
  // cross-checked against the other, which would assume a non-overlap the
  // art makes no promise about.
  const offCentre = GEO.distillOff!.bbox;
  const offX = sx + (offCentre.x + offCentre.w / 2) * cellPx.x;
  const offY = sy + (offCentre.y + offCentre.h / 2) * cellPx.y;
  assert.equal(distillToggleAtPoint(offX, offY, cellPx, sx, sy, false), true);

  const onCentre = GEO.distillOn!.bbox;
  const onX = sx + (onCentre.x + onCentre.w / 2) * cellPx.x;
  const onY = sy + (onCentre.y + onCentre.h / 2) * cellPx.y;
  assert.equal(distillToggleAtPoint(onX, onY, cellPx, sx, sy, true), true);

  // Well outside either bbox entirely - never hits, in either state.
  assert.equal(distillToggleAtPoint(sx, sy, cellPx, sx, sy, false), false);
  assert.equal(distillToggleAtPoint(sx, sy, cellPx, sx, sy, true), false);
});

test('distillToggleAtPoint scales per-axis with cellPx and translates with sx/sy', () => {
  assert.ok(GEO.distillOff);
  const b = GEO.distillOff!.bbox;
  const cellPx = { x: 4000, y: 3000 };
  const sx = 120;
  const sy = 80;
  const cx = sx + (b.x + b.w / 2) * cellPx.x;
  const cy = sy + (b.y + b.h / 2) * cellPx.y;
  assert.equal(distillToggleAtPoint(cx, cy, cellPx, sx, sy, false), true);
});
