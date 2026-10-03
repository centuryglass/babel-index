import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../../../../tools/center-placement/lib/geometry.ts';
import {
  DISTILL_OFF_PATH,
  DISTILL_ON_PATH,
  distillToggleAtPoint,
} from './distillToggle.ts';

const GEO = layout({ width: 1, height: 1 });
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
