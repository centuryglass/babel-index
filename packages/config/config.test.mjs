import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, resolveConfig } from './config.mjs';
import { ZOOM_LIMITS } from '../web/src/camera.js';

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
