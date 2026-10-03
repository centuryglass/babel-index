import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayScreenRect } from './overlay.ts';
import { BASE_TILE, sizeOf } from './pyramid.ts';

// An arbitrary stand-in for the art's decoded pixel size - placement reads
// no constant, so these tests exercise the scaling math on their own.
const ART = { w: 92, h: 198 };
const FULL = { x: BASE_TILE.w, y: BASE_TILE.h };

test('each anchor pins the art\'s matching corner to the tile\'s', () => {
  const sx = 100;
  const sy = 200;
  const tl = overlayScreenRect('top-left', FULL, sx, sy, ART);
  assert.deepEqual(tl, { x: sx, y: sy, w: ART.w, h: ART.h });
  const tr = overlayScreenRect('top-right', FULL, sx, sy, ART);
  assert.equal(tr.x + tr.w, sx + FULL.x);
  assert.equal(tr.y, sy);
  const bl = overlayScreenRect('bottom-left', FULL, sx, sy, ART);
  assert.equal(bl.x, sx);
  assert.equal(bl.y + bl.h, sy + FULL.y);
  const br = overlayScreenRect('bottom-right', FULL, sx, sy, ART);
  assert.equal(br.x + br.w, sx + FULL.x);
  assert.equal(br.y + br.h, sy + FULL.y);
});

test('halving the cell halves the art, on both axes, off the cell\'s width', () => {
  const full = overlayScreenRect('bottom-right', FULL, 0, 0, ART);
  const half = overlayScreenRect('bottom-right', { x: FULL.x / 2, y: FULL.y / 2 }, 0, 0, ART);
  assert.equal(half.w, full.w / 2);
  assert.equal(half.h, full.h / 2);
});

test('art from a coarser level scales off that level\'s width, so it is not shrunk twice', () => {
  const coarse = sizeOf(1);
  assert.ok(coarse, 'the ladder must have a level 1 for this test to mean anything');
  const ratio = coarse!.w / BASE_TILE.w;
  // The same cell, backed by level 0 art or by level 1 art scaled down on disk.
  const cell = { x: coarse!.w, y: coarse!.h };
  const fromLevel0 = overlayScreenRect('top-right', cell, 0, 0, ART, 0);
  const fromLevel1 = overlayScreenRect('top-right', cell, 0, 0, { w: ART.w * ratio, h: ART.h * ratio }, 1);
  assert.ok(Math.abs(fromLevel1.w - fromLevel0.w) < 1e-9);
  assert.ok(Math.abs(fromLevel1.h - fromLevel0.h) < 1e-9);
});
