import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CELL_ASPECT,
  FLIGHT_MS,
  MAX_ZOOM,
  MIN_ZOOM,
  WHEEL_ZOOM_RATE,
  beginFlight,
  cameraAtCell,
  clampZoom,
  easeInOut,
  flightAt,
  glideStep,
  panByPixels,
  pxPerCell,
  screenToWorld,
  worldToScreen,
  zoomAt,
  zoomBy,
} from './camera.js';

const rect = { width: 1280, height: 720 };
const cam = { x: 3.25, y: -7.5, zoom: 220 };

/**
 * The same camera at cell shapes the corpus is not in. A cell is the world's
 * base unit and nothing may assume its width equals its height, so every
 * invariant below is checked at all of these rather than only the square one.
 */
const SHAPES = [
  { name: 'square', aspect: 1 },
  { name: '16:9', aspect: 720 / 1280 },
  { name: '3:4 tall', aspect: 1024 / 768 },
  { name: 'the configured tile', aspect: CELL_ASPECT },
];
const shaped = (aspect) => ({ ...cam, aspect });

test('screen and world coordinates round-trip, at every cell shape', () => {
  for (const { name, aspect } of SHAPES) {
    const c = shaped(aspect);
    for (const [px, py] of [[0, 0], [640, 360], [1279, 719], [-40, 900]]) {
      const w = screenToWorld(px, py, c, rect);
      const s = worldToScreen(w.x, w.y, c, rect);
      assert.ok(Math.abs(s.x - px) < 1e-9, `${name} x: ${s.x} != ${px}`);
      assert.ok(Math.abs(s.y - py) < 1e-9, `${name} y: ${s.y} != ${py}`);
    }
  }
});

test('the camera centre lands at the middle of the viewport', () => {
  for (const { name, aspect } of SHAPES) {
    const s = worldToScreen(cam.x, cam.y, shaped(aspect), rect);
    assert.deepEqual(s, { x: rect.width / 2, y: rect.height / 2 }, name);
  }
});

test('one cell is one zoom wide, and the aspect tall', () => {
  // zoom is pixels per cell WIDTH; the height follows from the tile's shape.
  // Asserting both axes against zoom would bake the square assumption back in.
  for (const { name, aspect } of SHAPES) {
    const c = shaped(aspect);
    const a = worldToScreen(0, 0, c, rect);
    const b = worldToScreen(1, 1, c, rect);
    assert.ok(Math.abs(b.x - a.x - cam.zoom) < 1e-9, `${name} width`);
    assert.ok(Math.abs(b.y - a.y - cam.zoom * aspect) < 1e-9, `${name} height`);
  }
});

test('a non-square cell is actually drawn non-square', () => {
  // The whole point of the change: a 16:9 cell must not come out square. If
  // pxPerCell ever ignores the aspect again, this is what says so.
  const wide = pxPerCell(shaped(720 / 1280));
  assert.ok(wide.y < wide.x, `16:9 cell came out ${wide.x}x${wide.y}`);
  assert.equal(wide.y, cam.zoom * (720 / 1280));

  const tall = pxPerCell(shaped(1024 / 768));
  assert.ok(tall.y > tall.x, `3:4 cell came out ${tall.x}x${tall.y}`);
});

test('a camera with no aspect falls back to the configured tile', () => {
  assert.deepEqual(pxPerCell(cam), { x: cam.zoom, y: cam.zoom * CELL_ASPECT });
});

test('zoom keeps the world point under the cursor fixed', () => {
  // The exact invariant that makes scroll-to-zoom feel right, and the easiest
  // one to break: whatever is under the pointer must not move as you zoom. It
  // has to hold on the short axis of a non-square cell too, which is where a
  // half-applied aspect would show up.
  for (const { name, aspect } of SHAPES) {
    const c = shaped(aspect);
    for (const [px, py] of [[0, 0], [100, 640], [640, 360], [1280, 720]]) {
      for (const deltaY of [-400, -120, -1, 1, 120, 400]) {
        const before = screenToWorld(px, py, c, rect);
        const next = zoomAt(c, px, py, deltaY, rect);
        const after = screenToWorld(px, py, next, rect);
        assert.ok(
          Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9,
          `${name} (${px},${py}) delta ${deltaY}: ` +
            `${JSON.stringify(before)} -> ${JSON.stringify(after)}`
        );
      }
    }
  }
});

test('the cell shape survives every camera operation', () => {
  // Each of these builds a new camera object. One that drops `aspect` would
  // silently snap the world back to square mid-gesture.
  const c = shaped(720 / 1280);
  assert.equal(zoomAt(c, 640, 360, -120, rect).aspect, c.aspect, 'zoomAt');
  assert.equal(panByPixels(c, 40, 40, 1).aspect, c.aspect, 'panByPixels');
  assert.equal(glideStep({ ...c, x: 90, y: 90 }, 0).aspect, c.aspect, 'glideStep');
  assert.equal(cameraAtCell(c, 3, 4, 300).aspect, c.aspect, 'cameraAtCell');
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

test('zoomBy keeps the world point under the anchor fixed', () => {
  // The invariant a pinch depends on: whatever is between your fingers stays
  // between your fingers. Same property the wheel has, asserted on the shared
  // implementation rather than only through the wheel's delta.
  for (const factor of [0.4, 0.95, 1, 1.05, 3]) {
    const anchor = { px: 320, py: 610 };
    const before = screenToWorld(anchor.px, anchor.py, cam, rect);
    const next = zoomBy(cam, anchor.px, anchor.py, factor, rect);
    const after = screenToWorld(anchor.px, anchor.py, next, rect);
    assert.ok(Math.abs(after.x - before.x) < 1e-9, `factor ${factor}: x drifted`);
    assert.ok(Math.abs(after.y - before.y) < 1e-9, `factor ${factor}: y drifted`);
    assert.ok(Math.abs(next.zoom - cam.zoom * factor) < 1e-9, `factor ${factor}: wrong zoom`);
  }
});

test('zoomBy holds the anchor even when the zoom clamps', () => {
  // The pinch equivalent of the wheel's clamp case: a hard squeeze past the
  // limit must stop scaling without also sliding the map.
  const floored = { ...cam, zoom: MIN_ZOOM };
  const before = screenToWorld(200, 500, floored, rect);
  const next = zoomBy(floored, 200, 500, 0.01, rect);
  assert.equal(next.zoom, MIN_ZOOM, 'zoom should have clamped');
  const after = screenToWorld(200, 500, next, rect);
  assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
  assert.ok(Math.abs(next.x - floored.x) < 1e-9 && Math.abs(next.y - floored.y) < 1e-9);
});

test('a factor of 1 is exactly a no-op', () => {
  // Two fingers that hold their distance while sliding must contribute zoom of
  // nothing at all, or a pinch-pan creeps.
  const next = zoomBy(cam, 400, 300, 1, rect);
  assert.deepEqual({ x: next.x, y: next.y, zoom: next.zoom }, { x: cam.x, y: cam.y, zoom: cam.zoom });
});

test('the wheel is zoomBy with an exponential factor', () => {
  // One implementation, two gestures: if these drift apart, the wheel and the
  // pinch stop agreeing about what the fixed point is.
  const deltaY = -240;
  assert.deepEqual(
    zoomAt(cam, 500, 400, deltaY, rect),
    zoomBy(cam, 500, 400, Math.exp(-deltaY * WHEEL_ZOOM_RATE), rect)
  );
});

test('zoomBy carries the cell shape and the configured limits', () => {
  const limits = { min: 100, max: 300 };
  const c = { ...cam, zoom: 200, aspect: 720 / 1280, limits };
  const next = zoomBy(c, 100, 100, 4, rect);
  assert.equal(next.aspect, c.aspect, 'aspect survived');
  assert.equal(next.limits, limits, 'limits survived');
  assert.equal(next.zoom, 300, 'clamped to the configured ceiling');
});

test('a camera carrying narrowed limits is clamped to them, not to the hard ones', () => {
  // Configuration narrows the range by riding on the camera. If any operation
  // reached for the module-scope limits instead, the config would look applied
  // - the slider would sit in the right place - and the wheel would still take
  // you straight past it.
  const limits = { min: 100, max: 300 };
  const narrowed = { ...cam, zoom: 200, limits };

  assert.equal(zoomAt(narrowed, 640, 360, 5000, rect).zoom, 100, 'zoomAt honours the floor');
  assert.equal(zoomAt(narrowed, 640, 360, -5000, rect).zoom, 300, 'zoomAt honours the ceiling');
  assert.equal(cameraAtCell(narrowed, 0, 0, MAX_ZOOM).zoom, 300, 'flyTo honours the ceiling');
  assert.equal(clampZoom(1e6, limits), 300);
  assert.equal(clampZoom(1, limits), 100);
});

test('the configured limits survive every camera operation', () => {
  // Same failure as losing `aspect`: a rebuilt camera drops the field and the
  // range silently reverts mid-gesture.
  const limits = { min: 100, max: 300 };
  const c = { ...cam, zoom: 200, limits };
  assert.equal(zoomAt(c, 640, 360, -120, rect).limits, limits, 'zoomAt');
  assert.equal(panByPixels(c, 40, 40, 1).limits, limits, 'panByPixels');
  assert.equal(glideStep({ ...c, x: 90, y: 90 }, 0).limits, limits, 'glideStep');
  assert.equal(cameraAtCell(c, 3, 4, 250).limits, limits, 'cameraAtCell');
});

test('a camera with no limits gets the hard ones', () => {
  assert.equal(zoomAt(cam, 640, 360, 5000, rect).zoom, MIN_ZOOM);
  assert.equal(zoomAt(cam, 640, 360, -5000, rect).zoom, MAX_ZOOM);
});

test('zooming in then back out by the same delta returns to the start', () => {
  const inn = zoomAt(cam, 300, 300, -140, rect);
  const out = zoomAt(inn, 300, 300, 140, rect);
  assert.ok(Math.abs(out.zoom - cam.zoom) < 1e-9);
  assert.ok(Math.abs(out.x - cam.x) < 1e-9 && Math.abs(out.y - cam.y) < 1e-9);
});

test('dragging moves the world with the pointer, one for one, when unresisted', () => {
  // damp = 1 means "inside the content region": the map should track the
  // finger exactly. 220 pixels at zoom 220 is one cell across; down the short
  // axis of a wide cell the same pixels are MORE cells, which is what tracking
  // the finger means when the cell is not square.
  for (const { name, aspect } of SHAPES) {
    const c = shaped(aspect);
    const next = panByPixels(c, 220, -440, 1);
    assert.ok(Math.abs(next.x - (c.x - 1)) < 1e-9, `${name} x`);
    assert.ok(Math.abs(next.y - (c.y + 440 / (220 * aspect))) < 1e-9, `${name} y`);
    assert.equal(next.zoom, c.zoom);
  }
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

// --- flights ---------------------------------------------------------------

const far = { x: 40, y: -25, zoom: MIN_ZOOM };
const home = { x: 0.5, y: 0.5, zoom: MAX_ZOOM };
const at = (t, from = far, to = home) =>
  flightAt(beginFlight(from, to, 1000), 1000 + t * FLIGHT_MS);

test('a flight starts where it started and lands exactly on its target', () => {
  assert.deepEqual(at(0).cam, { ...home, ...far }, 'the first frame must not jump');
  assert.equal(at(0).done, false);

  // Identity, not "within an epsilon of": a flight that lands a rounding error
  // short leaves the camera somewhere nobody asked for, and "centre" is a
  // button whose whole promise is that it centres.
  assert.equal(at(1).cam, home, 'landing must return the target itself');
  assert.equal(at(1).done, true);
  assert.equal(at(3).done, true, 'an overshot clock stays landed');
});

test('a flight before its start time has not moved', () => {
  // rAF timestamps are taken from the same clock as `performance.now()`, but a
  // frame issued in the same millisecond can still read fractionally early.
  assert.deepEqual(at(-0.2).cam, { ...home, ...far });
});

test('zoom interpolates geometrically, position linearly', () => {
  // The assertion that fails against a linear zoom ramp, which is the obvious
  // implementation and the wrong one: halfway through a flight from 26 to 900
  // the zoom is their geometric mean (~153), not their arithmetic one (463).
  // A linear ramp puts nearly the whole flight up at the top of the range, so
  // it reads as a snap followed by a crawl.
  const mid = at(0.5).cam;
  assert.ok(
    Math.abs(mid.zoom - Math.sqrt(MIN_ZOOM * MAX_ZOOM)) < 1e-9,
    `midpoint zoom ${mid.zoom}, expected the geometric mean ${Math.sqrt(MIN_ZOOM * MAX_ZOOM)}`
  );
  assert.ok(Math.abs(mid.x - (far.x + home.x) / 2) < 1e-9, `midpoint x ${mid.x}`);
  assert.ok(Math.abs(mid.y - (far.y + home.y) / 2) < 1e-9, `midpoint y ${mid.y}`);
});

test('the ease is slow at both ends and monotonic throughout', () => {
  // Zero velocity on arrival is what stops the flight ending in a jerk; the
  // same at the start is what keeps an interrupted flight from snapping.
  assert.ok(easeInOut(0.1) < 0.05, `${easeInOut(0.1)} is not a slow start`);
  assert.ok(easeInOut(0.9) > 0.95, `${easeInOut(0.9)} is not a slow finish`);
  assert.equal(easeInOut(0.5), 0.5, 'the midpoint should be the midpoint');

  let last = -Infinity;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const e = easeInOut(Math.min(1, t));
    assert.ok(e >= last, `the ease went backwards at t=${t}`);
    last = e;
  }
});

test('progress is monotonic in both position and zoom', () => {
  let prev = at(0).cam;
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const now = at(Math.min(1, t)).cam;
    assert.ok(now.x <= prev.x, `x went backwards at t=${t}`);
    assert.ok(now.y >= prev.y, `y went backwards at t=${t}`);
    assert.ok(now.zoom >= prev.zoom, `zoom went backwards at t=${t}`);
    prev = now;
  }
});

test('a flight carries the cell shape and the configured limits', () => {
  // Same failure as everywhere else in this file: a camera rebuilt from
  // {x, y, zoom} loses the shape and the range mid-flight, and the map snaps
  // back to square while still looking configured.
  const limits = { min: 100, max: 300 };
  const from = { ...far, zoom: 120, aspect: 720 / 1280, limits };
  const to = cameraAtCell(from, 0, 0, 1e6);
  assert.equal(to.zoom, 300, 'the target clamps to the configured ceiling');

  for (const t of [0, 0.25, 0.5, 1]) {
    const { cam: c } = at(t, from, to);
    assert.equal(c.aspect, from.aspect, `aspect at t=${t}`);
    assert.equal(c.limits, limits, `limits at t=${t}`);
    assert.ok(c.zoom <= 300 + 1e-9, `zoom left the configured range at t=${t}: ${c.zoom}`);
  }
});

test('a flight of no duration arrives at once', () => {
  // How a caller honouring `prefers-reduced-motion` asks for the old teleport,
  // rather than a second code path that could drift from this one.
  const { cam: c, done } = flightAt(beginFlight(far, home, 1000, 0), 1000);
  assert.equal(c, home);
  assert.equal(done, true);
});

test('a flight interrupted by another picks up from where it had got to', () => {
  // The reason `beginFlight` takes the LIVE camera: pressing "centre" twice, or
  // searching mid-flight, must not restart from the original position.
  const midway = at(0.4).cam;
  const second = flightAt(beginFlight(midway, far, 2000), 2000);
  assert.deepEqual(
    { x: second.cam.x, y: second.cam.y, zoom: second.cam.zoom },
    { x: midway.x, y: midway.y, zoom: midway.zoom }
  );
});
