import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_CAMERA, MAX_SCALE, clampToBounds, panBy, zoomAtPoint } from './contentZoomCamera.ts';

test('zoomAtPoint keeps the anchor point fixed on screen across a scale change', () => {
  const camera = { scale: 1, tx: 0, ty: 0 };
  const anchor = { x: 50, y: 20 };
  const zoomed = zoomAtPoint(camera, anchor, 2, MAX_SCALE);
  // screen position of `anchor` before: contentOrigin + 1*50 + 0 = contentOrigin + 50
  // screen position of `anchor` after: contentOrigin + 2*50 + tx
  // so tx must be -50 for those to match (contentOrigin cancels out either way).
  assert.equal(zoomed.scale, 2);
  assert.equal(zoomed.tx, -50);
  assert.equal(zoomed.ty, -20);
});

test('zoomAtPoint composed over several steps still keeps the anchor fixed relative to its start', () => {
  const anchor = { x: 30, y: -10 };
  let camera = INITIAL_CAMERA;
  camera = zoomAtPoint(camera, anchor, 1.5, MAX_SCALE);
  camera = zoomAtPoint(camera, anchor, 1.5, MAX_SCALE);
  // screen(anchor) = scale*anchor + t must equal the original scale(1)*anchor + 0.
  assert.equal(camera.scale * anchor.x + camera.tx, anchor.x);
  assert.equal(camera.scale * anchor.y + camera.ty, anchor.y);
});

test('zoomAtPoint floors scale at 1', () => {
  const camera = { scale: 1, tx: 5, ty: 5 };
  const zoomed = zoomAtPoint(camera, { x: 0, y: 0 }, 0.1, MAX_SCALE);
  assert.equal(zoomed.scale, 1);
});

test('zoomAtPoint caps scale at maxScale', () => {
  const zoomed = zoomAtPoint(INITIAL_CAMERA, { x: 0, y: 0 }, 999, MAX_SCALE);
  assert.equal(zoomed.scale, MAX_SCALE);
});

test('zoomAtPoint is a no-op when the factor does not change the (clamped) scale', () => {
  const camera = { scale: 1, tx: 3, ty: -4 };
  assert.deepEqual(zoomAtPoint(camera, { x: 10, y: 10 }, 1, MAX_SCALE), camera);
});

test('panBy adds a plain translate', () => {
  assert.deepEqual(panBy({ scale: 2, tx: 1, ty: 2 }, 5, -5), { scale: 2, tx: 6, ty: -3 });
});

test('clampToBounds forces the identity at scale <= 1 - no leftover pan at rest', () => {
  const clamped = clampToBounds({ scale: 1, tx: 500, ty: -500 }, { width: 400, height: 300 }, { width: 4000, height: 3000 }, { x: -100, y: -50 });
  assert.deepEqual(clamped, INITIAL_CAMERA);
});

test('clampToBounds pans a viewport-filling element across its own full reachable range (the old image-fits-viewport case)', () => {
  // A 400x300 element filling its own viewport, contentOrigin (0,0). With
  // `transform-origin: 0 0` the reachable range at scale 2 is
  // [viewport - content*scale, 0] per axis - the origin, not the center, is
  // the fixed point, so the range is not centered on 0.
  const clamped = clampToBounds({ scale: 2, tx: 1000, ty: -1000 }, { width: 400, height: 300 }, { width: 400, height: 300 }, { x: 0, y: 0 });
  assert.equal(clamped.tx, 0); // requested +1000 clamps down to the max reachable, 0
  assert.equal(clamped.ty, -300); // requested -1000 clamps up to the min reachable, 300-600
});

test('clampToBounds centers content that stays smaller than the viewport even zoomed in', () => {
  // A 100x50 element in a 400x300 viewport, still smaller than the viewport
  // even at MAX_SCALE (100*4=400, 50*4=200) - centered on the height axis,
  // filling the width axis, regardless of any requested pan.
  const clamped = clampToBounds({ scale: 4, tx: 999, ty: 999 }, { width: 400, height: 300 }, { width: 100, height: 50 }, { x: 0, y: 0 });
  assert.equal(clamped.tx, 0);
  assert.equal(clamped.ty, 50);
});

test('clampToBounds bounds tx/ty to the zoomed-past-the-edge margin in the other direction too', () => {
  const clamped = clampToBounds({ scale: 2, tx: -1000, ty: 1000 }, { width: 400, height: 300 }, { width: 400, height: 300 }, { x: 0, y: 0 });
  // content*scale = 800x600 against a 400x300 viewport with contentOrigin 0:
  // tx in [400-0-800, -0] = [-400, 0]; ty in [300-0-600, 0] = [-300, 0].
  assert.equal(clamped.tx, -400);
  assert.equal(clamped.ty, 0);
});

test('clampToBounds accounts for a nonzero contentOrigin (content already scrolled when the gesture began)', () => {
  // A 4000-tall list in an 800-tall viewport, scrolled 1000px down when the
  // pinch started: contentOrigin.y = -1000. At scale 1.5 the scaled list is
  // 6000 tall; the viewport window may sit anywhere within it, but never
  // reveal empty space above the list's top or below its bottom.
  const viewport = { width: 400, height: 800 };
  const content = { width: 400, height: 4000 };
  const origin = { x: 0, y: -1000 };
  const scale = 1.5;

  const atTop = clampToBounds({ scale, tx: 0, ty: 99999 }, viewport, content, origin);
  // ty clamped to its max: -origin.y = 1000 (list's natural top pinned to viewport's top).
  assert.equal(atTop.ty, 1000);

  const atBottom = clampToBounds({ scale, tx: 0, ty: -99999 }, viewport, content, origin);
  // ty clamped to its min: viewport.height - origin.y - content.height*scale
  //   = 800 - (-1000) - 6000 = -4200.
  assert.equal(atBottom.ty, -4200);
});

test('clampToBounds caps scale at MAX_SCALE and floors at 1 before clamping position', () => {
  const over = clampToBounds({ scale: 999, tx: 0, ty: 0 }, { width: 400, height: 300 }, { width: 400, height: 300 }, { x: 0, y: 0 });
  assert.equal(over.scale, MAX_SCALE);
});
