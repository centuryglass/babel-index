/**
 * THIS FILE IS THE TUNING SURFACE for everything decided by feel.
 *
 * The pyramid has its own (`packages/web/src/lib/pyramid.js`) and keeps it: tile
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
import { FLIGHT_MS, ZOOM_LIMITS } from '../web/src/lib/camera.js';
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
     * Where the camera returns: the "center" button, and the zoom a search flies
     * home to before rearranging. 220 px per cell shows a handful of rooms whole
     * - enough that the map reads as a wall of rooms rather than one image, and
     * enough that the reorder animation has cells to slide. Clamped into the
     * range above.
     *
     * There is deliberately no companion `initialZoom` here: the PAGE-LOAD view
     * is not a by-feel number but a derived one - `main.jsx` fits the center
     * room's bookshelf to the display (`fitZoom` in camera.js), which is too far
     * out on a phone and too far in on a wide monitor to state as one value. What
     * belongs in config is what nothing derives; this now derives, so it left.
     */
    defaultZoom: 220,

    /**
     * How long a camera flight takes - "center", and the fly home after a
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

    /**
     * How long a single keyboard nudge takes - one arrow press, a ctrl+arrow
     * jump, a PgUp/PgDn zoom step - in milliseconds. Deliberately its own
     * number rather than a reuse of `flightMs`: a keyboard move is a single
     * cell or a screenful, not a cross-map jump, and animating it at the same
     * pace as "fly home" reads as sluggish under repeated key presses. Short
     * enough that a held-down key still feels responsive; long enough to read
     * as a glide rather than a snap.
     *
     * Zero means arrive at once, the same `prefers-reduced-motion` escape hatch
     * `flightMs` has - and for the same reason, since `useMapCamera.js` routes
     * every keyboard move through `flyTo` with this as the duration override.
     */
    keyboardMoveMs: 140,
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
     * Seed for choosing between alternate generic tiles. Separate from
     * `slotSeed` on purpose: sharing one would correlate the choice of
     * generic tile with which cells are content slots, and the two patterns
     * would be visible in each other.
     */
    genericSeed: 1,
  },

  slide: {
    /**
     * How long a rearrangement takes, in milliseconds.
     *
     * The visible cost is the viewport's, not the corpus's - the planner slides
     * only lines that cross the on-camera rectangle, and everything else is an
     * invisible swap - so these numbers set the whole duration and the corpus
     * size does not enter into it. See `packages/web/src/lib/slide.js` for how a
     * plan is laid out in time, and `packages/map/illusion.js` for why the
     * lines of a wave are free to move at once.
     *
     * Lowering all five proportionally makes the same animation faster; the
     * ratios between them are what shape it.
     */

    /**
     * Per-run constant, so a one-cell slide is not instantaneous. This is what
     * a move costs before any distance is travelled.
     */
    base: 80,

    /**
     * Per cell of travel. A line moving as one piece reads at a speed a single
     * tile would not, which is why this is nearer 25ms than the 100ms a lone
     * sliding tile would want. It dominates a long ride: a column crossing a
     * ten-cell region is `base + 10 x perCell`.
     */
    perCell: 26,

    /**
     * The beat between two runs in the same lane, keeping them legible as
     * separate moves rather than one continuous churn.
     */
    gap: 20,

    /**
     * How far apart the lines of a wave set off.
     *
     * A wave's lines are independent - the planner stages a whole batch before
     * feeding any of it - so they need not queue. Starting them together would
     * read as the whole field scrolling, which is a pan rather than a
     * rearrangement; starting them a beat apart turns the conveyor into a sweep
     * that leaves from the center. This, not `perCell`, is what sets how long
     * the sweep takes to cross the screen.
     */
    stagger: 65,

    /**
     * How far apart the runs of a sequential lane set off. They still finish in
     * plan order - that is what keeps the plan honoured - but starting the next
     * before the last has landed turns a queue into a cascade. Shorter than
     * `stagger`, because these are incidental motion: mostly rotations freeing
     * a room the new arrangement wants but which has no copy off camera.
     */
    cascade: 45,
  },

  catalog: {
    /**
     * Rows per page - the unit BOTH paging modes slice by. Pagination shows one
     * page; infinite scroll keeps a window of them mounted and replaces the
     * rest with spacers. They are one primitive with a different window (see
     * `packages/web/src/lib/catalog.js`), so this number sets the granularity of
     * both and there is deliberately no second one for scrolling.
     */
    perPage: 20,

    /**
     * How many pages stay mounted either side of the one being read.
     *
     * The DOM budget in one number. A whole corpus of rows would be about
     * thirty nodes each; one either side is enough that a fast scroll never
     * outruns the mount, and small enough that the list stays a few hundred
     * nodes rather than a hundred thousand. Zero is what pagination passes, so
     * this is also the knob that makes the two modes the same code.
     */
    windowPages: 1,

    /**
     * How long the map folds into the list, and back, in milliseconds.
     *
     * By-feel, like the slide durations and for the same reason: nothing
     * derives from it and no test pins its value. Zero means swap at once, and
     * `prefers-reduced-motion` still wins over whatever is set here.
     */
    transitionMs: 380,

    /**
     * How the catalog advances for a reader who has never chosen - 'scroll' or
     * 'pages'.
     *
     * The DEFAULT, not the setting. A stored choice overrides it, which is the
     * ordinary relationship between config and a preference and is worth saying
     * out loud because every other value in this block is the live number.
     */
    paging: 'scroll',
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
     * The longest query the box will take, in characters.
     *
     * Not a guard against abuse - this is an offline demo - but against a
     * plausible accident: pasting a tag list into the search field. Scoring is
     * O(tokens x keywords) per room, so a two-thousand-token query against a
     * five-thousand-room corpus is tens of millions of substring tests on the
     * main thread, and the page simply stops. It also has to be BOUNDED for the
     * things that display a query to stay sane - the top bar names it in full,
     * and history titles a book with it.
     *
     * Large enough that no real query reaches it: a sentence-long natural
     * language search is well under 200 characters.
     */
    maxQueryLength: 256,

    /**
     * Precision the CLIP text tower loads at - one of transformers.js's
     * `dtype` options ('fp32', 'fp16', 'q8', 'q4', ...). 'fp32' is the model's
     * native precision and the accurate default; 'q8' quantises to a quarter
     * the memory (one byte per parameter instead of four) at some cost to
     * embedding accuracy, which is the tradeoff a memory-constrained host
     * (a cheap VPS) wants and a normal one does not. Server-side only - it
     * governs `packages/server/app.mjs`'s text tower, not the vision tower
     * `tools/embed/embed.mjs` runs offline, which stays fp32 since it runs
     * once per corpus rather than per request.
     */
    clipTextDtype: 'fp32',

    /**
     * How a search's certainty becomes map density - see the gradient section
     * of `packages/map/ordering.js`. `map.contentRatio` above is the baseline
     * these numbers lift the middle of the map away from.
     */
    density: {
      /**
       * Density offered to a rank the search is certain about. 1 packs perfect
       * matches into every cell they meet, so a handful of exact hits reads as
       * a solid block against the center - which is the whole effect. Lower it
       * to keep some wallpaper showing through even the surest cluster.
       */
      peak: 1,

      /**
       * Certainty under this clusters nothing at all. A query the corpus cannot
       * answer still ranks *something* first, and without a floor the faintest
       * hunch would pull it to the center and claim a find. Defaults to
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
      keyboardMoveMs: duration(
        camIn.keyboardMoveMs, DEFAULTS.camera.keyboardMoveMs, 'camera.keyboardMoveMs', notes
      ),
    },
    slide: slideTiming(asSection(src.slide, 'slide', notes), notes),
    catalog: catalog(asSection(src.catalog, 'catalog', notes), notes),
    map: {
      contentRatio: ratio(mapIn.contentRatio, DEFAULTS.map.contentRatio, 'map.contentRatio', notes),
      slotSeed: integer(mapIn.slotSeed, DEFAULTS.map.slotSeed, 'map.slotSeed', notes),
      genericSeed: integer(
        mapIn.genericSeed, DEFAULTS.map.genericSeed, 'map.genericSeed', notes
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
      maxQueryLength: atLeast(
        integer(searchIn.maxQueryLength, DEFAULTS.search.maxQueryLength, 'search.maxQueryLength', notes),
        1, 'search.maxQueryLength', notes
      ),
      clipTextDtype: clipTextDtype(searchIn.clipTextDtype, notes),
      density: density(densityIn, notes),
    },
    notes,
  };
}

/**
 * The catalog's block.
 *
 * `perPage` and `windowPages` are floored rather than rejected: a page of zero
 * rows is a list that renders nothing at all and a negative window is the same
 * bug spelled differently, and neither is worth failing a whole config over
 * when the honest reading is obvious. `windowPages` of 0 is legal and
 * meaningful - it is exactly what pagination passes.
 */
function catalog(src, notes) {
  const d = DEFAULTS.catalog;

  const perPage = atLeast(
    integer(src.perPage, d.perPage, 'catalog.perPage', notes), 1, 'catalog.perPage', notes
  );
  const windowPages = atLeast(
    integer(src.windowPages, d.windowPages, 'catalog.windowPages', notes),
    0, 'catalog.windowPages', notes
  );

  let paging = src.paging ?? d.paging;
  if (paging !== 'scroll' && paging !== 'pages') {
    notes.push(`catalog.paging should be 'scroll' or 'pages'; using ${d.paging}`);
    paging = d.paging;
  }

  return {
    perPage,
    windowPages,
    transitionMs: duration(src.transitionMs, d.transitionMs, 'catalog.transitionMs', notes),
    paging,
  };
}

/** Floor a value with a note, for the two counts above. */
function atLeast(n, min, path, notes) {
  if (n >= min) return n;
  notes.push(`${path} must be at least ${min}; using ${min}`);
  return min;
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

/**
 * The rearrangement animation's timings.
 *
 * Each is a duration in milliseconds and gets the same treatment as the flight
 * above, with one difference: `composed`. These five do not each describe a
 * whole animation, they add up to one - a run takes `base + perCell x cells`,
 * and `gap`, `stagger` and `cascade` are beats between things that are
 * themselves moving. So a value under one frame is ordinary here rather than
 * suspicious, and warning about it would be noise. The ceiling and the
 * not-negative rule still apply, and both still matter: a negative beat would
 * schedule a run to start before the one it follows, and the animation applies
 * its plan in completion order.
 */
function slideTiming(src, notes) {
  const d = DEFAULTS.slide;
  const out = {};
  for (const key of ['base', 'perCell', 'gap', 'stagger', 'cascade'])
    out[key] = duration(src[key], d[key], `slide.${key}`, notes, { composed: true });
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

function duration(value, fallback, path, notes, { composed = false } = {}) {
  const n = number(value, fallback, path, notes);
  if (n < 0) {
    notes.push(`${path} should not be negative; using ${fallback}`);
    return fallback;
  }
  if (n > DURATION_MAX_MS) {
    notes.push(`${path} ${n} is longer than ${DURATION_MAX_MS}ms; using ${DURATION_MAX_MS}`);
    return DURATION_MAX_MS;
  }
  // Only for a number that IS an animation's duration. One that merely
  // contributes to a longer one is legitimately sub-frame - a four millisecond
  // beat between two slides is a beat, not a flight nobody will see.
  if (!composed && n > 0 && n < ONE_FRAME_MS) {
    notes.push(`${path} ${n} is shorter than one frame, so nothing will animate - milliseconds, not seconds?`);
  }
  return n;
}

/**
 * The CLIP text tower's dtype - one of transformers.js's supported precisions.
 * Anything else is a typo, not a request for a precision that doesn't exist.
 */
const CLIP_TEXT_DTYPES = ['fp32', 'fp16', 'q8', 'q4', 'int8', 'uint8', 'q4f16', 'bnb4'];

function clipTextDtype(value, notes) {
  const d = DEFAULTS.search.clipTextDtype;
  if (value === undefined) return d;
  if (typeof value !== 'string' || !CLIP_TEXT_DTYPES.includes(value)) {
    notes.push(`search.clipTextDtype should be one of ${CLIP_TEXT_DTYPES.join(', ')}; using ${d}`);
    return d;
  }
  return value;
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
