import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  cameraAtCell,
  clampZoom,
  glideStep,
  panByPixels,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from './camera.js';

const rect = { width: 1280, height: 720 };
const cam = { x: 3.25, y: -7.5, zoom: 220 };

test('screen and world coordinates round-trip', () => {
  for (const [px, py] of [[0, 0], [640, 360], [1279, 719], [-40, 900]]) {
    const w = screenToWorld(px, py, cam, rect);
    const s = worldToScreen(w.x, w.y, cam, rect);
    assert.ok(Math.abs(s.x - px) < 1e-9, `x: ${s.x} != ${px}`);
    assert.ok(Math.abs(s.y - py) < 1e-9, `y: ${s.y} != ${py}`);
  }
});

test('the camera centre lands at the middle of the viewport', () => {
  const s = worldToScreen(cam.x, cam.y, cam, rect);
  assert.deepEqual(s, { x: rect.width / 2, y: rect.height / 2 });
});

test('one world unit is one zoom of pixels', () => {
  const a = worldToScreen(0, 0, cam, rect);
  const b = worldToScreen(1, 1, cam, rect);
  assert.equal(b.x - a.x, cam.zoom);
  assert.equal(b.y - a.y, cam.zoom);
});

test('zoom keeps the world point under the cursor fixed', () => {
  // The exact invariant that makes scroll-to-zoom feel right, and the easiest
  // one to break: whatever is under the pointer must not move as you zoom.
  for (const [px, py] of [[0, 0], [100, 640], [640, 360], [1280, 720]]) {
    for (const deltaY of [-400, -120, -1, 1, 120, 400]) {
      const before = screenToWorld(px, py, cam, rect);
      const next = zoomAt(cam, px, py, deltaY, rect);
      const after = screenToWorld(px, py, next, rect);
      assert.ok(
        Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9,
        `(${px},${py}) delta ${deltaY}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`
      );
    }
  }
});

test('the fixed point holds when the zoom clamps', () => {
  // Recentring against the *requested* zoom rather than the clamped one would
  // drift here, and only here - at the ends of the range.
  for (const start of [{ ...cam, zoom: MIN_ZOOM }, { ...cam, zoom: MAX_ZOOM }]) {
    const deltaY = start.zoom === MIN_ZOOM ? 5000 : -5000;
    const before = screenToWorld(200, 500, start, rect);
    const next = zoomAt(start, 200, 500, deltaY, rect);
    assert.equal(next.zoom, start.zoom, 'zoom should have clamped');
    const after = screenToWorld(200, 500, next, rect);
    assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
    // A clamped zoom is a no-op, so the camera must not creep either.
    assert.ok(Math.abs(next.x - start.x) < 1e-9 && Math.abs(next.y - start.y) < 1e-9);
  }
});

test('scrolling up zooms in, down zooms out, and both stay in range', () => {
  assert.ok(zoomAt(cam, 640, 360, -120, rect).zoom > cam.zoom);
  assert.ok(zoomAt(cam, 640, 360, 120, rect).zoom < cam.zoom);
  assert.equal(clampZoom(-5), MIN_ZOOM);
  assert.equal(clampZoom(1e6), MAX_ZOOM);
  assert.equal(clampZoom(220), 220);
});

test('zooming in then back out by the same delta returns to the start', () => {
  const inn = zoomAt(cam, 300, 300, -140, rect);
  const out = zoomAt(inn, 300, 300, 140, rect);
  assert.ok(Math.abs(out.zoom - cam.zoom) < 1e-9);
  assert.ok(Math.abs(out.x - cam.x) < 1e-9 && Math.abs(out.y - cam.y) < 1e-9);
});

test('dragging moves the world with the pointer, one for one, when unresisted', () => {
  // damp = 1 means "inside the content region": the map should track the
  // finger exactly, so 220 pixels at zoom 220 is one tile.
  const next = panByPixels(cam, 220, -440, 1);
  assert.ok(Math.abs(next.x - (cam.x - 1)) < 1e-9);
  assert.ok(Math.abs(next.y - (cam.y + 2)) < 1e-9);
  assert.equal(next.zoom, cam.zoom);
});

test('resistance damps the drag without ever stopping it', () => {
  const full = panByPixels(cam, 100, 0, 1).x;
  const some = panByPixels(cam, 100, 0, 0.5).x;
  const none = panByPixels(cam, 100, 0, 0).x;
  // All three move left; each successive one moves less.
  assert.ok(full < some && some < none && none < cam.x, `${full} ${some} ${none}`);
  assert.ok(cam.x - none > 0, 'a fully resisted drag must still creep, not freeze');
});

test('the glide pulls toward the origin only outside the region', () => {
  const outside = { x: 40, y: -30, zoom: 220 };
  const stepped = glideStep(outside, 0.2);
  assert.ok(Math.hypot(stepped.x, stepped.y) < Math.hypot(outside.x, outside.y));
  // It must not overshoot past the origin, however weak the resistance.
  assert.ok(Math.sign(stepped.x) === Math.sign(outside.x));
  assert.ok(Math.sign(stepped.y) === Math.sign(outside.y));
  assert.equal(stepped.zoom, outside.zoom);

  // Inside the region the camera is returned untouched, so the render loop can
  // skip a redraw by identity.
  assert.equal(glideStep(outside, 1), outside);
});

test('repeated glide steps converge on the origin', () => {
  let c = { x: 60, y: 60, zoom: 220 };
  for (let i = 0; i < 4000; i++) c = glideStep(c, 0);
  assert.ok(Math.hypot(c.x, c.y) < 1, `still at ${c.x}, ${c.y}`);
});

test('flying to a cell aims at its middle and keeps zoom unless asked', () => {
  assert.deepEqual(cameraAtCell(cam, 0, 0), { x: 0.5, y: 0.5, zoom: 220 });
  assert.deepEqual(cameraAtCell(cam, -4, 9, 300), { x: -3.5, y: 9.5, zoom: 300 });
  assert.equal(cameraAtCell(cam, 0, 0, 1e6).zoom, MAX_ZOOM);
});
