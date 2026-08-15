import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, resolveConfig } from './config.mjs';
import { FLIGHT_MS, ZOOM_LIMITS } from '../web/src/camera.js';

/**
 * The limits are injected everywhere below rather than assumed, both because
 * that is how the module is meant to be used and because it keeps these tests
 * from re-pinning themselves to whatever `camera.js` currently says.
 *
 * Wide enough to contain the default opening zoom, so a test about zoom *range*
 * is not also a test about the opening zoom being pulled along with it. That
 * interaction is real and gets its own case below.
 */
const LIMITS = { min: 10, max: 1000 };

test('an empty overlay is exactly the defaults', () => {
  const c = resolveConfig({}, { zoomLimits: LIMITS });
  assert.deepEqual(c.notes, []);
  assert.equal(c.map.contentRatio, DEFAULTS.map.contentRatio);
  assert.deepEqual(c.search.weights, DEFAULTS.search.weights);
  // null means "no narrowing", which is what keeps the hard limits stated once.
  assert.equal(c.camera.minZoom, LIMITS.min);
  assert.equal(c.camera.maxZoom, LIMITS.max);
});

test('a missing overlay is the same as an empty one', () => {
  assert.deepEqual(resolveConfig(undefined, { zoomLimits: LIMITS }), resolveConfig({}, { zoomLimits: LIMITS }));
});

test('config narrows the zoom range', () => {
  const c = resolveConfig(
    { camera: { minZoom: 40, maxZoom: 80, defaultZoom: 60 } },
    { zoomLimits: LIMITS }
  );
  assert.deepEqual(c.notes, []);
  assert.equal(c.camera.minZoom, 40);
  assert.equal(c.camera.maxZoom, 80);
});

test('config cannot widen the zoom range, in either direction', () => {
  const c = resolveConfig({ camera: { minZoom: 1, maxZoom: 5000 } }, { zoomLimits: LIMITS });
  assert.equal(c.camera.minZoom, LIMITS.min);
  assert.equal(c.camera.maxZoom, LIMITS.max);
  assert.equal(c.notes.length, 2, 'both ends report');
  assert.match(c.notes.join('\n'), /minZoom/);
  assert.match(c.notes.join('\n'), /maxZoom/);
});

test('an inverted range falls back to the full one rather than locking the camera', () => {
  const c = resolveConfig({ camera: { minZoom: 900, maxZoom: 20 } }, { zoomLimits: LIMITS });
  assert.equal(c.camera.minZoom, LIMITS.min);
  assert.equal(c.camera.maxZoom, LIMITS.max);
  assert.match(c.notes.join('\n'), /above/);
});

test('defaultZoom is clamped into the configured range, not the hard one', () => {
  const c = resolveConfig(
    { camera: { minZoom: 400, maxZoom: 800, defaultZoom: 60 } },
    { zoomLimits: LIMITS }
  );
  assert.equal(c.camera.defaultZoom, 400);
  assert.match(c.notes.join('\n'), /defaultZoom/);
});

test('narrowing the range drags the opening zoom with it, and says so', () => {
  // Narrowing past the default is legal, but the opening zoom moving is not
  // something the reader asked for, so it is reported rather than silent.
  const c = resolveConfig({ camera: { maxZoom: 30 } }, { zoomLimits: ZOOM_LIMITS });
  assert.equal(c.camera.defaultZoom, 30);
  assert.match(c.notes.join('\n'), /defaultZoom/);
});

test('narrowing far enough to orphan a rung is allowed and silent', () => {
  // The whole point of the narrow-only rule: a config that can only tighten the
  // range can never invalidate what the ladder's reachability test asserted, so
  // leaving the finest levels unreachable needs no complaint. What it must not
  // do is quietly *widen* anything, which the tests above cover.
  const c = resolveConfig(
    { camera: { minZoom: 26, maxZoom: 30, defaultZoom: 28 } },
    { zoomLimits: ZOOM_LIMITS }
  );
  assert.deepEqual(c.notes, []);
  assert.equal(c.camera.maxZoom, 30);
});

test('nonsense values fall back and say so, rather than throwing', () => {
  const c = resolveConfig(
    {
      camera: { defaultZoom: 'big' },
      map: { contentRatio: 0, slotSeed: 2.7 },
      search: { weights: { keyword: -1 }, minTokenLength: 0 },
    },
    { zoomLimits: LIMITS }
  );
  assert.equal(c.camera.defaultZoom, DEFAULTS.camera.defaultZoom);
  assert.equal(c.map.contentRatio, DEFAULTS.map.contentRatio, 'a ratio of 0 is out of range');
  assert.equal(c.map.slotSeed, 3, 'a fractional seed is rounded');
  assert.equal(c.search.weights.keyword, DEFAULTS.search.weights.keyword);
  assert.equal(c.search.minTokenLength, 1, 'a token length below 1 matches everything');
  assert.ok(c.notes.length >= 5, `expected a note for each: ${c.notes.join(' | ')}`);
});

test('a section of the wrong type is ignored rather than fatal', () => {
  const c = resolveConfig({ map: 'nope', search: [] }, { zoomLimits: LIMITS });
  assert.equal(c.map.contentRatio, DEFAULTS.map.contentRatio);
  assert.equal(c.search.minTokenLength, DEFAULTS.search.minTokenLength);
  assert.equal(c.notes.length, 2);
});

test('an overlay changes only what it names', () => {
  const c = resolveConfig({ search: { weights: { clip: 0 } } }, { zoomLimits: LIMITS });
  assert.equal(c.search.weights.clip, 0, 'zero is a legitimate "ignore this signal"');
  assert.equal(c.search.weights.keyword, DEFAULTS.search.weights.keyword);
  assert.equal(c.search.weights.story, DEFAULTS.search.weights.story);
  assert.deepEqual(c.notes, []);
});

test('the default weights put an exact keyword match above anything CLIP can say', () => {
  // Every signal is normalised to [0, 1] before weighting, so the weights are
  // directly comparable and this is the property they are chosen to express.
  const { keyword, story, clip } = DEFAULTS.search.weights;
  assert.ok(keyword > story, 'keywords outrank story text');
  assert.ok(story > clip, 'story text outranks CLIP');
  assert.ok(keyword * 1 > clip * 1, 'a perfect keyword match beats a perfect CLIP score');
});

test('the shipped defaults are valid against the real limits', () => {
  const c = resolveConfig({}, { zoomLimits: ZOOM_LIMITS });
  assert.deepEqual(c.notes, [], 'defaults must not need correcting');
  assert.ok(c.camera.defaultZoom >= ZOOM_LIMITS.min && c.camera.defaultZoom <= ZOOM_LIMITS.max);
});

// --- the flight duration ---------------------------------------------------

test('the flight duration comes through, and the default is the source constant', () => {
  // Imported rather than restated, so `camera.js` and this file cannot end up
  // shipping two different 450s.
  assert.equal(DEFAULTS.camera.flightMs, FLIGHT_MS);
  const c = resolveConfig({ camera: { flightMs: 900 } }, { zoomLimits: LIMITS });
  assert.equal(c.camera.flightMs, 900);
  assert.deepEqual(c.notes, []);
});

test('zero is a flight duration, not an error', () => {
  // It means "arrive at once" - the same thing prefers-reduced-motion asks for
  // - so it is how a config turns the animation off. Rejecting it would leave
  // no way to say that, and it must not be corrected back to the default.
  const c = resolveConfig({ camera: { flightMs: 0 } }, { zoomLimits: LIMITS });
  assert.equal(c.camera.flightMs, 0);
  assert.deepEqual(c.notes, []);
});

test('a negative or absurd flight duration is corrected and reported', () => {
  const back = resolveConfig({ camera: { flightMs: -200 } }, { zoomLimits: LIMITS });
  assert.equal(back.camera.flightMs, DEFAULTS.camera.flightMs);
  assert.match(back.notes.join('\n'), /flightMs/);

  // Past a few seconds a camera move has stopped being a transition, so the
  // ceiling clamps rather than honouring it - and says which it did.
  const forever = resolveConfig({ camera: { flightMs: 60_000 } }, { zoomLimits: LIMITS });
  assert.ok(forever.camera.flightMs > 0 && forever.camera.flightMs < 60_000);
  assert.match(forever.notes.join('\n'), /longer than/);
});

test('a duration in seconds is honoured but flagged', () => {
  // 0.45 is what seconds look like typed into a milliseconds field. It is a
  // legitimate way to say "no animation", so it is not corrected - but left
  // silent it is a flight that never appears, which is the one failure mode a
  // tuning file really has.
  const c = resolveConfig({ camera: { flightMs: 0.45 } }, { zoomLimits: LIMITS });
  assert.equal(c.camera.flightMs, 0.45, 'not corrected');
  assert.match(c.notes.join('\n'), /shorter than one frame/);
  assert.match(c.notes.join('\n'), /seconds/);
});

// --- the search density gradient -------------------------------------------

test('the density block comes through, and a partial one keeps its neighbours', () => {
  const c = resolveConfig({ search: { density: { peak: 0.6 } } }, { zoomLimits: LIMITS });
  assert.deepEqual(c.notes, []);
  assert.equal(c.search.density.peak, 0.6);
  assert.equal(c.search.density.floor, DEFAULTS.search.density.floor);
  assert.equal(c.search.density.clipLow, DEFAULTS.search.density.clipLow);
});

test('an inverted cosine band is reported rather than silently disabling CLIP', () => {
  // The failure this note exists for: `clipHigh <= clipLow` would mean CLIP
  // never contributes certainty, which from the map looks exactly like a corpus
  // with no embeddings at all.
  const c = resolveConfig(
    { search: { density: { clipLow: 0.4, clipHigh: 0.2 } } },
    { zoomLimits: LIMITS }
  );
  assert.equal(c.search.density.clipLow, DEFAULTS.search.density.clipLow);
  assert.equal(c.search.density.clipHigh, DEFAULTS.search.density.clipHigh);
  assert.ok(c.notes.some((n) => n.includes('clipHigh')), c.notes.join('; '));
});

test('a nonsense peak or floor falls back and says so', () => {
  const c = resolveConfig(
    { search: { density: { peak: 1.5, floor: 'lots' } } },
    { zoomLimits: LIMITS }
  );
  assert.equal(c.search.density.peak, DEFAULTS.search.density.peak);
  assert.equal(c.search.density.floor, DEFAULTS.search.density.floor);
  assert.equal(c.notes.length, 2, c.notes.join('; '));
});

test('the default gradient bounds bracket a real CLIP cosine', () => {
  // Not a preference but a measurement, and the one number here most likely to
  // move: image-text cosines have to be able to land inside the band for the
  // gradient to grade anything at all.
  const { clipLow, clipHigh } = DEFAULTS.search.density;
  assert.ok(clipHigh > clipLow, `${clipLow}-${clipHigh}`);
  assert.ok(clipLow > 0 && clipHigh < 1, 'a cosine, not a normalised score');
});
