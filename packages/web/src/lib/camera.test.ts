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
  cursorCell,
  easeInOut,
  flightAt,
  glideStep,
  glideToRest,
  panByCells,
  panByPixels,
  pickGranularity,
  pxPerCell,
  screenToWorld,
  worldToScreen,
  zoomAt,
  zoomBy,
} from './camera.ts';

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

test('the camera center lands at the middle of the viewport', () => {
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

test('glideToRest reaches the same place repeated glideStep calls would', () => {
  // A REALISTIC resistance function - full damp near the origin, easing to
  // nothing further out - unlike the constant-damp cases above. That easing is
  // exactly what makes real convergence fast: the pull shrinks as the camera
  // approaches the origin AND resistance climbs back toward 1 at the same
  // time, unlike the pathological constant-zero case those tests use.
  const resistanceAt = (x, y) => {
    const d = Math.hypot(x, y);
    if (d <= 5) return 1;
    return Math.max(0, 1 - (d - 5) / 12) ** 3;
  };
  const start = { x: 40, y: 0, zoom: 220 };

  let iterated = start;
  for (let i = 0; i < 5000; i++) iterated = glideStep(iterated, resistanceAt(iterated.x, iterated.y));

  const rested = glideToRest(start, resistanceAt);
  assert.ok(
    Math.abs(rested.x - iterated.x) < 1e-3 && Math.abs(rested.y - iterated.y) < 1e-3,
    `glideToRest landed at ${rested.x},${rested.y}, five thousand steps reached ${iterated.x},${iterated.y}`
  );
  assert.equal(rested.zoom, start.zoom);
});

test('glideToRest is a no-op, by identity, when already at rest', () => {
  // The render loop skips a redraw on an unchanged reference - a fresh object
  // with the same numbers would defeat that every frame.
  const cam = { x: 3, y: 3, zoom: 220 };
  assert.equal(glideToRest(cam, () => 1), cam);
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
  // short leaves the camera somewhere nobody asked for, and "center" is a
  // button whose whole promise is that it centers.
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
  // implementation and the wrong one: halfway through a flight from 26 to 2048
  // the zoom is their geometric mean (~231), not their arithmetic one (~1037).
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
  // The reason `beginFlight` takes the LIVE camera: pressing "center" twice, or
  // searching mid-flight, must not restart from the original position.
  const midway = at(0.4).cam;
  const second = flightAt(beginFlight(midway, far, 2000), 2000);
  assert.deepEqual(
    { x: second.cam.x, y: second.cam.y, zoom: second.cam.zoom },
    { x: midway.x, y: midway.y, zoom: midway.zoom }
  );
});

test('the cursor cell is the cell under the camera center', () => {
  // `cam.x`/`cam.y` are already world cells (the same convention
  // `cameraAtCell`'s `+ 0.5` states the other way round), so this is a floor
  // and nothing more - asserted so a future refactor cannot quietly swap in a
  // round or a different rounding direction.
  assert.deepEqual(cursorCell({ x: 3.9, y: -0.1, zoom: 220 }), { x: 3, y: -1 });
  assert.deepEqual(cursorCell({ x: 0, y: 0, zoom: 220 }), { x: 0, y: 0 });
});

test('the cursor tracks a fractional camera position exactly at cell boundaries', () => {
  // A camera sitting exactly on an integer is the edge case `Math.floor` gets
  // right and a naive round would not: cell N owns its own lower corner.
  assert.deepEqual(cursorCell({ x: 5, y: 5, zoom: 220 }), { x: 5, y: 5 });
  assert.deepEqual(cursorCell({ x: 4.999999, y: 5, zoom: 220 }), { x: 4, y: 5 });
});

test('granularity picks region only once a cell is too small to be a specific place', () => {
  assert.equal(pickGranularity(200), 'cell');
  assert.equal(pickGranularity(5), 'region');
});

test('granularity has hysteresis, like the pyramid level it copies the shape from', () => {
  // Held exactly at the ideal threshold with no prior state, pick fresh.
  const atThreshold = pickGranularity(24, null);
  assert.equal(atThreshold, 'cell');

  // Once 'cell' is current, a small dip just under the threshold must not
  // immediately flip to 'region' - that is the whole point of hysteresis.
  const stillCell = pickGranularity(20, 'cell');
  assert.equal(stillCell, 'cell', 'a small dip below threshold must not flicker');

  // But a real drop, well past the biased threshold, does flip.
  const dropsToRegion = pickGranularity(5, 'cell');
  assert.equal(dropsToRegion, 'region');

  // And the same holds coming back the other way.
  const stillRegion = pickGranularity(26, 'region');
  assert.equal(stillRegion, 'region', 'a small rise above threshold must not flicker');
  const risesToCell = pickGranularity(60, 'region');
  assert.equal(risesToCell, 'cell');
});

test('granularity never oscillates across a boundary held steady', () => {
  // A zoom sitting exactly on the raw threshold, sampled every frame: without
  // hysteresis this is the classic flicker case.
  let g = null;
  for (let i = 0; i < 20; i++) g = pickGranularity(24, g);
  assert.equal(g, 'cell');
});

test('a keyboard nudge is exactly one cell inside the content region', () => {
  // The cursor contract: one arrow press is one room. Damping must not touch
  // that in the case that matters, which is everywhere a reader normally is.
  const c = { x: 3.5, y: 3.5, zoom: 220 };
  const moved = panByCells(c, 1, 0, 1);
  assert.equal(moved.x, 4.5);
  assert.equal(moved.y, 3.5);
  // And a cell-centered camera stays cell-centered, so presses never drift the
  // grid alignment while inside.
  assert.equal(panByCells(moved, 0, -1, 1).y, 2.5);
});

test('a keyboard nudge has NO floor, unlike a pointer drag', () => {
  // The asymmetry is the point, and it is about the INPUT, not the map. A drag
  // is bounded by how far a hand travels, so `panByPixels` can afford a 0.12
  // floor that keeps the map from feeling frozen. A held arrow key repeats
  // about thirty times a second for as long as it is down, so the same floor
  // is a constant outward velocity that never stops - measured, it let a
  // six-second hold reach 31 cells past a boundary a mouse could barely push
  // 11 past.
  const c = { x: 40, y: 0, zoom: 220 };
  assert.equal(panByCells(c, 1, 0, 0).x, 40, 'at zero resistance a nudge must not move at all');

  // The pointer keeps its floor - asserted here so the two cannot be
  // "unified" back together by someone tidying up.
  const dragged = panByPixels(c, -220, 0, 0);
  assert.ok(dragged.x > c.x, 'a fully resisted drag must still creep');
});

test('a keyboard nudge scales smoothly between the two', () => {
  const c = { x: 10, y: 0, zoom: 220 };
  const half = panByCells(c, 1, 0, 0.5);
  assert.ok(Math.abs(half.x - 10.5) < 1e-9, `expected half a cell, got ${half.x - 10}`);
  // Monotone in the resistance, which is what makes pushing outward feel
  // progressively heavier rather than hitting a step.
  let previous = 0;
  for (const damp of [0, 0.25, 0.5, 0.75, 1]) {
    const gained = panByCells(c, 1, 0, damp).x - c.x;
    assert.ok(gained >= previous, `damp ${damp} moved less than the step below it`);
    previous = gained;
  }
});

test('the cell shape and limits survive a keyboard nudge', () => {
  const limits = { min: 50, max: 300 };
  const c = { x: 0, y: 0, zoom: 220, aspect: 720 / 1280, limits };
  const moved = panByCells(c, 1, 1, 1);
  assert.equal(moved.aspect, c.aspect);
  assert.equal(moved.limits, limits);
});

test('a keyboard nudge re-centers an off-grid camera, on BOTH axes', () => {
  // The bug this pins: a trip outside the region leaves the camera off the
  // grid (damped steps out there are fractional by design, and the glide
  // stops wherever it happens to cross back in). Adding a raw delta would
  // carry that offset forever - the cursor's own cell sitting visibly
  // off-center, part of it hanging off the screen edge, with no way to
  // correct it by arrowing.
  const off = { x: 7.0, y: 0.3, zoom: 220 };
  const moved = panByCells(off, -1, 0, 1);
  assert.equal(moved.x, 6.5, 'the axis moved along must land cell-centered');
  assert.equal(moved.y, 0.5, 'the OTHER axis must be re-centered too');
});

test('the offset does not survive repeated in-bounds presses', () => {
  // The symptom as reported: "continuing to move with arrow keys leaves you
  // stuck at that same offset". One press is enough to fix it, but assert
  // across several so a fix that merely reduces the offset each time - rather
  // than snapping - cannot pass.
  let c = { x: 7.0, y: 0.3, zoom: 220 };
  for (let i = 0; i < 4; i++) {
    c = panByCells(c, -1, 0, 1);
    assert.equal(c.x - Math.floor(c.x), 0.5, `x off-center after press ${i + 1}`);
    assert.equal(c.y - Math.floor(c.y), 0.5, `y off-center after press ${i + 1}`);
  }
  // ...and it is still exactly one cell per press, not a bigger jump each time.
  assert.equal(c.x, 3.5, 'four presses from cell 7 must land on cell 3');
});

test('re-centering happens only inside the region, never against the damping', () => {
  // Snapping outside would defeat the resistance entirely - it would round a
  // heavily damped fractional step back up to a whole cell.
  const outside = { x: 20.0, y: 0.3, zoom: 220 };
  const nudged = panByCells(outside, 1, 0, 0.1);
  assert.ok(Math.abs(nudged.x - 20.1) < 1e-9, `expected a damped 0.1, got ${nudged.x - 20}`);
  assert.equal(nudged.y, 0.3, 'the other axis must not snap while outside either');
});
