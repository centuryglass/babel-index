/**
 * THIS FILE IS THE TUNING SURFACE for everything decided by feel.
 *
 * The pyramid has its own (`packages/web/src/pyramid.js`) and keeps it: tile
 * size, the ladder, per-level budgets, the hysteresis band and the prefetch ring
 * are *derived and asserted*, not tuned - restating any of them here would be a
 * second statement of a fact that already has one. What lives here is the other
 * kind of number: the ones with no right answer, only a preferred one.
 *
 * `DEFAULTS` below is the surface. Every value carries the reasoning that
 * justifies it, the way `pyramid.js` does, because a number without its argument
 * is a number nobody dares change. A `config.json` beside the repo root can
 * override any subset of it - see `load.mjs` - but it is an overlay and is not
 * committed, so this object stays the single statement of every default.
 *
 * ### Zoom config narrows, and never widens
 *
 * `camera.js` states the hard zoom limits; this file can only tighten them.
 * That asymmetry is what keeps configuration from being able to break anything
 * derived: `pyramid.test.mjs` asserts every rung of the ladder is reachable
 * somewhere in the *widest* range, and no config can move that range outward, so
 * the assertion still covers every reachable state at runtime.
 *
 * A narrowed range can leave the finest rung or two unreachable, and that is
 * fine and deliberately not an error. The cost of a level nothing asks for is a
 * few inactive lines and some files in a bucket that are never requested - and
 * the alternative, letting a config edit orphan a rung the tests believed in,
 * is the failure this asymmetry exists to make impossible.
 *
 * No side effects and no filesystem: this is defaults plus validation, so it can
 * be exercised at any limits without a disk or a server. `load.mjs` is the part
 * that reads a file.
 */
import { FLIGHT_MS, ZOOM_LIMITS } from '../web/src/camera.js';
import { CERTAINTY_FLOOR } from '../map/ordering.js';
import { CLIP_CERTAINTY } from '../map/scoring.js';

export const DEFAULTS = {
  camera: {
    /**
     * The zoom range actually offered, as pixels per cell WIDTH.
     *
     * `null` means "as far as `camera.js` allows" - the honest spelling of "no
     * narrowing", and the reason this file does not restate 26 and 900. Set a
     * number to pull the range in; a number outside the hard limits is clamped
     * to them rather than honoured, because config narrows and never widens.
     */
    minZoom: null,
    maxZoom: null,

    /**
     * Where the camera opens. 220 px per cell shows a handful of rooms whole -
     * enough that the map reads as a wall of rooms rather than as one image or
     * as a mosaic of thumbnails. Clamped into the range above.
     */
    defaultZoom: 220,

    /**
     * How long a camera flight takes - "centre", and the fly home after a
     * search - in milliseconds.
     *
     * 450 is a starting point rather than a measurement, which is the same
     * argument that puts the search weights here: how long a transition should
     * take is a judgement about the map in front of you, and the only way to
     * settle it is to sit with it. The number itself is `FLIGHT_MS` in
     * `camera.js`, imported rather than restated, so the source default and the
     * documented one cannot drift.
     *
     * Zero is meaningful: it means arrive at once, which is what
     * `prefers-reduced-motion` asks for and how a config switches the animation
     * off. Reduced motion still wins over any value set here.
     */
    flightMs: FLIGHT_MS,
  },

  map: {
    /**
     * Fraction of cells that may hold a corpus room; the rest are copies of the
     * generic. 0.2 is the concept's "maybe 80% generic" - sparse enough that
     * finding a distinct room feels like finding something.
     */
    contentRatio: 0.2,

    /** Scatter seed for slot placement. Changing it reshuffles which cells are slots. */
    slotSeed: 1,

    /**
     * Seed for choosing between alternate generic rooms. Separate from
     * `slotSeed` on purpose: sharing one would correlate the choice of
     * wallpaper with which cells are content slots, and the two patterns would
     * be visible in each other.
     */
    genericVariantSeed: 1,
  },

  search: {
    /**
     * Relative priority of the three retrieval signals. Every signal is
     * normalised to [0, 1] before weighting - including CLIP, whose raw cosines
     * cluster far too tightly on a corpus of near-identical library walls to be
     * blended unnormalised - so these weights mean exactly what they look like
     * and can be read against each other directly.
     *
     * The ordering is the design's: an exact keyword match (1.0 x 1.0) outscores
     * anything CLIP can say (max 0.25), a whole-story match (0.5) sits between
     * them, and CLIP still decides the ranking of everything no text touched -
     * which is most of the corpus for most queries.
     *
     * These are a starting point, not a measurement. The real values want the
     * real corpus and real queries, which is the argument for them being here
     * rather than in source.
     */
    weights: {
      keyword: 1,
      story: 0.5,
      clip: 0.25,
    },

    /**
     * Query tokens shorter than this never match. Without a floor, `a` matches
     * most keywords in the corpus by substring and the partial-match score
     * stops meaning anything.
     */
    minTokenLength: 3,

    /**
     * How a search's certainty becomes map density - see the gradient section
     * of `packages/map/ordering.js`. `map.contentRatio` above is the baseline
     * these numbers lift the middle of the map away from.
     */
    density: {
      /**
       * Density offered to a rank the search is certain about. 1 packs perfect
       * matches into every cell they meet, so a handful of exact hits reads as
       * a solid block against the centre - which is the whole effect. Lower it
       * to keep some wallpaper showing through even the surest cluster.
       */
      peak: 1,

      /**
       * Certainty under this clusters nothing at all. A query the corpus cannot
       * answer still ranks *something* first, and without a floor the faintest
       * hunch would pull it to the centre and claim a find. Defaults to
       * `CERTAINTY_FLOOR`, which is where the reasoning is written down.
       */
      floor: CERTAINTY_FLOOR,

      /**
       * Raw cosines bounding CLIP's share of certainty: at `clipLow` it is
       * saying nothing, at `clipHigh` it is as sure as it gets. The one part of
       * the gradient that is a measurement rather than a preference, and it
       * wants the real corpus - see `CLIP_CERTAINTY` for where these come from.
       */
      clipLow: CLIP_CERTAINTY.low,
      clipHigh: CLIP_CERTAINTY.high,
    },
  },
};

/**
 * Merge an overlay over `DEFAULTS`, validating as it goes.
 *
 * Never throws and always returns something usable: a demo that will not start
 * because of a typo in a tuning file is worse than one that starts and says what
 * it ignored. Everything adjusted is reported in `notes`, which the server
 * prints at startup - silence about a value that did not take effect is the
 * failure mode worth avoiding here.
 *
 * @param {object} [raw] the overlay, typically parsed `config.json`
 * @param {object} [opts]
 * @param {{min: number, max: number}} [opts.zoomLimits] the hard range this
 *   config may narrow but not widen. Injected so the whole policy can be
 *   exercised at limits the app is not currently using.
 * @returns {{camera: object, map: object, search: object, notes: string[]}}
 */
export function resolveConfig(raw = {}, { zoomLimits = ZOOM_LIMITS } = {}) {
  const notes = [];
  const src = asSection(raw, '', notes);

  const camIn = asSection(src.camera, 'camera', notes);
  const mapIn = asSection(src.map, 'map', notes);
  const searchIn = asSection(src.search, 'search', notes);
  const weightsIn = asSection(searchIn.weights, 'search.weights', notes);
  const densityIn = asSection(searchIn.density, 'search.density', notes);

  // Resolve "no narrowing" to the hard limits, then intersect. Both directions
  // are clamped rather than refused: a config asking for more range than exists
  // is a request that cannot be granted, not a corrupt file.
  let minZoom = numberOrNull(camIn.minZoom, DEFAULTS.camera.minZoom, 'camera.minZoom', notes);
  let maxZoom = numberOrNull(camIn.maxZoom, DEFAULTS.camera.maxZoom, 'camera.maxZoom', notes);
  minZoom = minZoom ?? zoomLimits.min;
  maxZoom = maxZoom ?? zoomLimits.max;

  if (minZoom < zoomLimits.min) {
    notes.push(`camera.minZoom ${minZoom} widens the range; clamped to ${zoomLimits.min}`);
    minZoom = zoomLimits.min;
  }
  if (maxZoom > zoomLimits.max) {
    notes.push(`camera.maxZoom ${maxZoom} widens the range; clamped to ${zoomLimits.max}`);
    maxZoom = zoomLimits.max;
  }
  if (minZoom > maxZoom) {
    notes.push(
      `camera.minZoom ${minZoom} is above camera.maxZoom ${maxZoom}; ` +
        `using the full range ${zoomLimits.min}-${zoomLimits.max}`
    );
    minZoom = zoomLimits.min;
    maxZoom = zoomLimits.max;
  }

  let defaultZoom = number(camIn.defaultZoom, DEFAULTS.camera.defaultZoom, 'camera.defaultZoom', notes);
  if (defaultZoom < minZoom || defaultZoom > maxZoom) {
    const clamped = Math.min(maxZoom, Math.max(minZoom, defaultZoom));
    notes.push(`camera.defaultZoom ${defaultZoom} is outside ${minZoom}-${maxZoom}; using ${clamped}`);
    defaultZoom = clamped;
  }

  return {
    camera: {
      minZoom,
      maxZoom,
      defaultZoom,
      flightMs: duration(camIn.flightMs, DEFAULTS.camera.flightMs, 'camera.flightMs', notes),
    },
    map: {
      contentRatio: ratio(mapIn.contentRatio, DEFAULTS.map.contentRatio, 'map.contentRatio', notes),
      slotSeed: integer(mapIn.slotSeed, DEFAULTS.map.slotSeed, 'map.slotSeed', notes),
      genericVariantSeed: integer(
        mapIn.genericVariantSeed, DEFAULTS.map.genericVariantSeed, 'map.genericVariantSeed', notes
      ),
    },
    search: {
      weights: {
        keyword: weight(weightsIn.keyword, DEFAULTS.search.weights.keyword, 'search.weights.keyword', notes),
        story: weight(weightsIn.story, DEFAULTS.search.weights.story, 'search.weights.story', notes),
        clip: weight(weightsIn.clip, DEFAULTS.search.weights.clip, 'search.weights.clip', notes),
      },
      minTokenLength: tokenLength(
        searchIn.minTokenLength, DEFAULTS.search.minTokenLength, 'search.minTokenLength', notes
      ),
      density: density(densityIn, notes),
    },
    notes,
  };
}

/**
 * The density gradient's block.
 *
 * `peak` below `map.contentRatio` is not rejected here, because the layout
 * treats the baseline as a floor anyway - a gradient may add density, never
 * remove it - so the worst such a config can do is switch the effect off. An
 * inverted cosine band is worth a note: it would silently mean "CLIP never
 * contributes certainty", which looks exactly like a corpus with no blob.
 */
function density(src, notes) {
  const d = DEFAULTS.search.density;
  const out = {
    peak: ratio(src.peak, d.peak, 'search.density.peak', notes),
    floor: ratio(src.floor, d.floor, 'search.density.floor', notes),
    clipLow: number(src.clipLow, d.clipLow, 'search.density.clipLow', notes),
    clipHigh: number(src.clipHigh, d.clipHigh, 'search.density.clipHigh', notes),
  };
  if (!(out.clipHigh > out.clipLow)) {
    notes.push(
      `search.density.clipHigh ${out.clipHigh} is not above clipLow ${out.clipLow}; ` +
        `using ${d.clipLow}-${d.clipHigh}`
    );
    out.clipLow = d.clipLow;
    out.clipHigh = d.clipHigh;
  }
  return out;
}

/** A section of the overlay, or an empty one. Anything else is reported and ignored. */
function asSection(value, path, notes) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    notes.push(`${path || 'config'} should be an object; ignoring it`);
    return {};
  }
  return value;
}

/** A finite number, or the fallback with a note. */
function number(value, fallback, path, notes) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    notes.push(`${path} should be a finite number; using ${fallback}`);
    return fallback;
  }
  return value;
}

/** Like `number`, but `null` is meaningful rather than an error. */
function numberOrNull(value, fallback, path, notes) {
  if (value === null) return null;
  return number(value, fallback, path, notes);
}

function integer(value, fallback, path, notes) {
  const n = number(value, fallback, path, notes);
  if (!Number.isInteger(n)) {
    notes.push(`${path} should be a whole number; using ${Math.round(n)}`);
    return Math.round(n);
  }
  return n;
}

/** A fraction in (0, 1], matching what `createLayout()` will accept. */
function ratio(value, fallback, path, notes) {
  const n = number(value, fallback, path, notes);
  if (!(n > 0 && n <= 1)) {
    notes.push(`${path} should be in (0, 1]; using ${fallback}`);
    return fallback;
  }
  return n;
}

/** At least one character, since a zero-length token matches everything. */
function tokenLength(value, fallback, path, notes) {
  const n = integer(value, fallback, path, notes);
  if (n < 1) {
    notes.push(`${path} must be at least 1; using 1`);
    return 1;
  }
  return n;
}

/**
 * An animation duration in milliseconds.
 *
 * Zero is legitimate and stays - it means "arrive at once", the same thing
 * `prefers-reduced-motion` asks for, so it is how a config switches an
 * animation off rather than an error. Negative is not a slower flight or a
 * reversed one; it is a typo.
 *
 * The ceiling is a judgement rather than a limit of anything: past a few
 * seconds a camera move has stopped being a transition and become a wait, and a
 * value that far out is much likelier to be a units mistake than a taste.
 *
 * The sub-frame note is the one worth having. `0.45` is what seconds look like
 * typed into a milliseconds field, and it is not rejected - it is a perfectly
 * good way to say "no animation" - but it would otherwise be a flight that
 * silently never appears, which is exactly the failure mode a tuning file has.
 */
const DURATION_MAX_MS = 5000;
const ONE_FRAME_MS = 1000 / 60;

function duration(value, fallback, path, notes) {
  const n = number(value, fallback, path, notes);
  if (n < 0) {
    notes.push(`${path} should not be negative; using ${fallback}`);
    return fallback;
  }
  if (n > DURATION_MAX_MS) {
    notes.push(`${path} ${n} is longer than ${DURATION_MAX_MS}ms; using ${DURATION_MAX_MS}`);
    return DURATION_MAX_MS;
  }
  if (n > 0 && n < ONE_FRAME_MS) {
    notes.push(`${path} ${n} is shorter than one frame, so nothing will animate - milliseconds, not seconds?`);
  }
  return n;
}

/** A search weight: any non-negative number. Zero is a legitimate "ignore this signal". */
function weight(value, fallback, path, notes) {
  const n = number(value, fallback, path, notes);
  if (n < 0) {
    notes.push(`${path} should not be negative; using ${fallback}`);
    return fallback;
  }
  return n;
}
