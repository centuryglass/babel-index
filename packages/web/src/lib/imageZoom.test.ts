import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampZoomState, INITIAL_ZOOM, MAX_SCALE } from './imageZoom.ts';

test('clampZoomState leaves an in-range state untouched', () => {
  const state = { scale: 2, tx: 10, ty: -5 };
  assert.deepEqual(clampZoomState(state, 400, 300), state);
});

test('clampZoomState floors scale at 1', () => {
  assert.equal(clampZoomState({ scale: 0.4, tx: 0, ty: 0 }, 400, 300).scale, 1);
});

test('clampZoomState caps scale at MAX_SCALE', () => {
  assert.equal(clampZoomState({ scale: 99, tx: 0, ty: 0 }, 400, 300).scale, MAX_SCALE);
});

test('clampZoomState forces tx/ty to 0 at scale 1 - no zoomed content to pan around', () => {
  const clamped = clampZoomState({ scale: 1, tx: 500, ty: -500 }, 400, 300);
  assert.equal(clamped.tx, 0);
  assert.equal(clamped.ty, 0);
});

test('clampZoomState bounds tx/ty to the zoomed-past-the-edge margin', () => {
  // scale 2 over a 400x300 element: each axis can pan by half its own
  // (scale - 1) size before empty space beyond the image would show.
  const clamped = clampZoomState({ scale: 2, tx: 1000, ty: -1000 }, 400, 300);
  assert.equal(clamped.tx, 200);
  assert.equal(clamped.ty, -150);
});

test('INITIAL_ZOOM is already stable under its own clamp', () => {
  assert.deepEqual(clampZoomState(INITIAL_ZOOM, 400, 300), INITIAL_ZOOM);
});
