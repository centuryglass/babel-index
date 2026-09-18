/**
 * The tuning surface: every number that has no right answer, only a preferred
 * one, each with the reasoning behind it.
 *
 * `DEFAULTS` is the whole set and the single statement of every default; the
 * `config.json` overlay `load.ts` reads is optional, partial, and never
 * committed (AGENTS.md, "Config and the pyramid"). No filesystem and no side
 * effects here - `load.ts` is the part that touches a disk.
 *
 * The overlay arrives as `unknown`: parsed JSON nothing has validated before it
 * gets here, so every reader below checks what it takes rather than trusting a
 * type.
 *
 * Zoom is the one place a hard limit sits outside this file:
 * `camera.minZoom`/`maxZoom` may narrow `camera.ts`'s `ZOOM_LIMITS` and never
 * widen it. A value beyond the hard range is clamped rather than refused, and a
 * narrowing that leaves the finest rung or two unreachable is legal and silent.
 * `ZOOM_LIMITS`'s own comment carries why the direction is one-way.
 *
 * ### Numbers deliberately kept out
 *
 * Other by-feel constants live where they are read, either because more than one
 * runtime needs them or because moving them means re-checking a derived
 * invariant that a `config.json` overlay cannot verify at load time:
 *
 *   - `packages/web/src/lib/pyramid.ts`: the tile ladder, per-level cache
 *     budgets, the prefetch ring and sheet packing (AGENTS.md, "Config and the
 *     pyramid"). Kept out because a budget below its own worst-case-visible cell
 *     count thrashes the cache within a single frame, and no range check here
 *     could see that.
 *   - `packages/web/src/lib/camera.ts`'s `ZOOM_LIMITS`/`MAX_ZOOM_FACTOR`: the
 *     hard zoom range, in code so config cannot widen it.
 *   - `packages/map/scoring.ts`'s `TAG_PARTIAL_SATURATION`/`STORY_FLOOR`: paired
 *     with `search.weights` in the inequalities
 *     `docs/search_rules.md` "Balancing signals against each other" states and
 *     `scoring.test.ts` checks. Moving one means re-deriving the others.
 *   - `packages/web/src/lib/center.ts`'s spine sizing (`SPINE_SIZE_SCALE`,
 *     `SPINE_HALO_SCALE`, `SPINE_HALO_FLOOR`) and opening fit
 *     (`OPENING_MARGIN`): the same kind of tuning as `center` below, not
 *     exposed here.
 *   - `packages/web/src/lib/favoriteBadge.ts`'s `MIN_FAVORITE_HIT_TOUCH`/
 *     `TOUCH_HIT_AREA_CAP`: the badge's touch-target floor and area cap.
 *   - `packages/web/src/components/CatalogView.tsx`'s `ROW_PAD`, `TEXT_MIN`,
 *     `STORY_RESERVED_PX` and neighbours: not movable here even though they look
 *     tunable. `spacerHeight` computes the catalog's scroll arithmetic from these
 *     exact numbers, so an override would desync the spacers from what actually
 *     renders and corrupt scroll position rather than just look different.
 *   - `packages/server/app.ts`'s `RATE_BURST`/`RATE_REFILL_MS`/
 *     `RATE_MAX_TRACKED`/`EMBED_CACHE_SIZE`: server-side rate-limit and cache
 *     tuning. This object rides to the browser on the manifest, which
 *     server-only knobs have no need to do.
 *   - `tools/upload`, `tools/embed`, `tools/perf-capture`, `tools/font-lab`:
 *     each has its own offline/dev-tool constants (concurrency, batch sizes,
 *     timeouts). They run outside the demo server, so nothing here reaches them.
 */
import {
  CURSOR_GRANULARITY_PX,
  FLIGHT_MS,
  GRANULARITY_HYSTERESIS,
  WHEEL_ZOOM_RATE,
  ZOOM_LIMITS,
  ZOOM_STEP_FACTOR,
} from '../web/src/lib/camera.ts';
import { CERTAINTY_FLOOR } from '../map/ordering.ts';
import { CLIP_CERTAINTY } from '../map/scoring.ts';

export interface ZoomLimits {
  min: number;
  max: number;
}

interface GestureConfig {
  longPressMs: number;
  pressSlopPx: number;
  doubleTapMs: number;
  doubleTapSlopPx: number;
  twoFingerTapMs: number;
  twoFingerTapGapMs: number;
  twoFingerTapSlopPx: number;
}

interface CameraDefaults {
  minZoom: number | null;
  maxZoom: number | null;
  minVisibleCells: number;
  flightMs: number;
  keyboardMoveMs: number;
  wheelZoomRate: number;
  zoomStepFactor: number;
  cursorGranularityPx: number;
  granularityHysteresis: number;
  gesture: GestureConfig;
}

interface MapConfig {
  contentRatio: number;
  slotSeed: number;
  genericSeed: number;
  distillFadeMs: number;
}

interface SlideConfig {
  base: number;
  perCell: number;
  gap: number;
  stagger: number;
  cascade: number;
  prepareTimeoutMs: number;
}

interface CatalogConfig {
  perPage: number;
  windowPages: number;
  transitionMs: number;
  paging: 'scroll' | 'pages';
}

interface CenterConfig {
  spineMinPx: number;
  spineMaxPx: number;
}

interface SearchWeights {
  tagExact: number;
  tagPartial: number;
  titleExact: number;
  titlePartial: number;
  story: number;
  storyLong: number;
  clip: number;
}

interface SearchDensity {
  peak: number;
  floor: number;
  clipCentre: number;
  clipHigh: number;
  clipLow: number;
}

interface SearchDefaults {
  weights: SearchWeights;
  minTokenLength: number;
  maxQueryLength: number;
  clipTextDtype: string;
  density: SearchDensity;
}

interface Defaults {
  camera: CameraDefaults;
  map: MapConfig;
  slide: SlideConfig;
  catalog: CatalogConfig;
  center: CenterConfig;
  search: SearchDefaults;
}

/** The resolved config `resolveConfig` returns - every value present and validated. */
export interface Config {
  camera: {
    minZoom: number;
    maxZoom: number;
    minVisibleCells: number;
    flightMs: number;
    keyboardMoveMs: number;
    wheelZoomRate: number;
    zoomStepFactor: number;
    cursorGranularityPx: number;
    granularityHysteresis: number;
    gesture: GestureConfig;
  };
  slide: SlideConfig;
  catalog: CatalogConfig;
  map: MapConfig;
  center: CenterConfig;
  search: SearchDefaults;
  notes: string[];
}

/** An overlay section once pulled out of the raw object - still unvalidated. */
type Section = Record<string, unknown>;

export const DEFAULTS: Defaults = {
  /**
   * Where `camera.ts` already states a constant, this block imports it rather
   * than restating it, so the value the code uses and the value documented here
   * cannot end up different (AGENTS.md, "Consuming files state no fallback
   * defaults").
   */
  camera: {
    /**
     * The zoom range offered, as pixels per cell width.
     *
     * `null` means that end's hard limit, which is how this file says "no
     * narrowing" without restating `ZOOM_LIMITS`'s numbers.
     */
    minZoom: 50,
    maxZoom: null,

    /**
     * How many whole rows and columns stay visible wherever the camera parks at
     * an overview. `overviewZoom` (`camera.ts`) picks the largest zoom that
     * still fits an n x n square of cells on the viewport's binding axis, so the
     * map reads as a wall of rooms rather than one image and the reorder
     * animation has cells to slide across.
     *
     * A cell count rather than a pixels-per-cell number because which axis
     * binds varies - width on a phone, height on a wide monitor - and cells mean
     * the same thing on either. AGENTS.md's "Two opening views" is what this
     * value belongs to; the page-load view is fitted to the display instead.
     */
    minVisibleCells: 5,

    /**
     * How long a camera flight takes, in milliseconds: the "center" button, and
     * the fly home after a search. The default is `FLIGHT_MS` in `camera.ts`,
     * and it is a starting point rather than a measurement.
     */
    flightMs: FLIGHT_MS,

    /**
     * How long a single keyboard move takes - one arrow press, a ctrl+arrow
     * jump, a PgUp/PgDn zoom step. Its own number because a keyboard move is one
     * cell or a screenful, not a cross-map jump: at `flightMs`'s pace, repeated
     * presses read as sluggish. Short enough that a held key stays responsive,
     * long enough to read as a glide rather than a snap.
     *
     * `useMapCursor.ts` passes it as the duration override on the
     * `flyTo`/`nudgeBy` calls every keypress makes (both from `useMapCamera.ts`).
     */
    keyboardMoveMs: 140,

    /**
     * How much of a wheel delta becomes zoom - exponential, so a notch is a
     * fixed ratio rather than a fixed pixel count. `WHEEL_ZOOM_RATE` in
     * `camera.ts`.
     */
    wheelZoomRate: WHEEL_ZOOM_RATE,

    /**
     * How much one discrete zoom step scales the camera - PageUp/PageDown and a
     * two-finger tap. `ZOOM_STEP_FACTOR` in `camera.ts`.
     */
    zoomStepFactor: ZOOM_STEP_FACTOR,

    /**
     * Below this many device pixels per cell width, the keyboard cursor names a
     * region rather than a single cell. `CURSOR_GRANULARITY_PX` in `camera.ts`.
     */
    cursorGranularityPx: CURSOR_GRANULARITY_PX,

    /**
     * How far past `cursorGranularityPx` a zoom must move before the announced
     * granularity flips, so holding a zoom near the boundary does not flicker
     * between naming a cell and naming a region. `GRANULARITY_HYSTERESIS` in
     * `camera.ts`.
     */
    granularityHysteresis: GRANULARITY_HYSTERESIS,

    /**
     * Press/tap gesture thresholds for the map's pointer handling
     * (`useMapCamera.ts`): timing windows and pixel slop for telling a long
     * press from a drag, a double tap from two unrelated taps, and a two-finger
     * tap from a pinch. Nothing derives from these, and no test pins their
     * values - only the logic that compares against them.
     */
    gesture: {
      /** How long a press must be held before it opens the metadata overlay. */
      longPressMs: 500,

      /**
       * How far a press or a one-finger tap may wander and still count as a
       * press/tap rather than a drag.
       */
      pressSlopPx: 8,

      /** How soon a second tap must land to read as a double tap. */
      doubleTapMs: 300,

      /**
       * How close a second tap must land to the first. Wider than
       * `pressSlopPx` because a second tap lands wherever the same finger
       * comes back down, not wherever the first one drifted to.
       */
      doubleTapSlopPx: 40,

      /**
       * How long a two-finger tap (zoom out one step) may take from touchdown
       * to its first liftoff before it reads as a hold instead.
       */
      twoFingerTapMs: 400,

      /**
       * How long a gap the two liftoffs of a two-finger tap may have: the second
       * must lift within this of the first.
       */
      twoFingerTapGapMs: 250,

      /**
       * How far the span or midpoint between two fingers may drift and still
       * count as a tap rather than the start of a pinch.
       */
      twoFingerTapSlopPx: 12,
    },
  },

  map: {
    /**
     * Fraction of cells that may hold a corpus room; the rest are copies of the
     * generic. Low enough that finding a distinct room feels like finding
     * something. A search's density gradient lifts the middle of the map away
     * from this baseline - see `search.density`.
     */
    contentRatio: 0.25,

    /** Scatter seed for slot placement. Changing it reshuffles which cells are slots. */
    slotSeed: 1,

    /**
     * Seed for choosing between alternate generic tiles. Its own number because
     * sharing `slotSeed` would correlate which generic tile a cell shows with
     * whether that cell is a content slot, and the two patterns would be visible
     * in each other.
     */
    genericSeed: 1,

    /**
     * How long distill mode's generic crossfade takes in each direction, in
     * milliseconds - the phase that runs before the slide when hiding generic
     * rooms, and after it when bringing them back. `useDistillMode.ts` drives it.
     */
    distillFadeMs: 320,
  },

  slide: {
    /**
     * How long a rearrangement takes, in milliseconds.
     *
     * Duration is the viewport's, not the corpus's (AGENTS.md, "The reorder
     * animation"): the planner slides only the lines that cross the on-camera
     * rectangle and everything else is an invisible swap, so these numbers set
     * the whole animation whatever the corpus size. `packages/web/src/lib/slide.ts`
     * is how a plan is laid out in time, and `packages/map/illusion.ts` is why a
     * wave's lines are free to move at once.
     *
     * Lowering all five proportionally makes the same animation faster; the
     * ratios between them are what shape it.
     */

    /**
     * Per-run constant, so a one-cell slide is not instantaneous: what a move
     * costs before any distance is travelled.
     */
    base: 80,

    /**
     * Per cell of travel, so it dominates a long ride - a column crossing a
     * ten-cell region is `base + 10 x perCell`. Far below what a lone sliding
     * tile would want, because a line moving as one piece reads at a speed a
     * single tile does not.
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
     * A wave's lines are independent, so they need not queue - `illusion.ts`
     * stages a whole batch before feeding any of it. Starting them together
     * reads as the whole field scrolling, which is a pan rather than a
     * rearrangement; a beat apart turns the conveyor into a sweep that leaves
     * from the center. This, not `perCell`, sets how long the sweep takes to
     * cross the screen.
     */
    stagger: 65,

    /**
     * How far apart the runs of a sequential lane set off. They still finish in
     * plan order, which is what keeps the plan honoured, but starting the next
     * before the last has landed turns a queue into a cascade. Shorter than
     * `stagger`, because this is incidental motion: mostly rotations freeing a
     * room the new arrangement wants and which has no copy off camera.
     */
    cascade: 45,

    /**
     * How long `prepareRearrangement` (`useRearrangement.ts`) waits for the
     * plan's tiles to fetch and decode before animating with whatever is ready.
     * Proceeding on the timeout is a fallback, not a failure.
     *
     * Sized against the cold-cache waits `docs/performance-research.md`'s
     * "Measured findings" records: about a second on desktop Chrome and Android
     * Chrome, with a longer tail on Android Firefox. A wait before anything moves
     * reads as loading; the same time spent stuttering mid-slide does not.
     *
     * Two consequences of being a wait rather than a beat: `duration()`'s
     * sub-frame warning applies here (this is the one slide timing not passed
     * `composed`), and this value sits at `DURATION_MAX_MS`, so an overlay can
     * only shorten it.
     */
    prepareTimeoutMs: 5000,
  },

  catalog: {
    /**
     * Rows per page - the unit both paging modes slice by, so this one number
     * sets the granularity of pagination and of infinite scroll alike
     * (AGENTS.md, "Pagination and infinite scroll are one primitive with a
     * different window"; `packages/web/src/lib/catalog.ts`'s `pageOf`).
     */
    perPage: 20,

    /**
     * How many pages stay mounted either side of the one being read - the DOM
     * budget in one number. One either side is enough that a fast scroll never
     * outruns the mount, and the mounted set stays a window rather than the
     * whole corpus of rows.
     *
     * Zero is what pagination passes, which is the knob that makes the two modes
     * one code path. `windowFor` (`catalog.ts`) widens it when a screenful spans
     * more pages than this mounts, so a tall display cannot scroll into a spacer.
     */
    windowPages: 1,

    /**
     * How long the map folds into the list, and back, in milliseconds. Nothing
     * derives from it and no test pins its value; `useModeTransition.ts` honours
     * `prefers-reduced-motion` over it.
     */
    transitionMs: 380,

    /**
     * How the catalog advances for a reader who has never chosen: 'scroll' or
     * 'pages'. A default rather than the live setting - a choice the reader has
     * made is stored under `persist.ts`'s `KEYS.paging` and wins over this.
     */
    paging: 'scroll',
  },

  center: {
    /**
     * The range `composeSpines` (`packages/web/src/lib/center.ts`) auto-fits a
     * spine title's font within, in px. A short title grows toward `spineMaxPx`
     * and a long one shrinks toward `spineMinPx` before it is truncated with an
     * ellipsis, so both are bounds rather than sizes - most titles land between
     * them. `tools/font-lab`'s sweep (`--cap 32 --min 12`, Roboto Slab) is where
     * these started. The zoom-legibility gate is a different thing and stays a
     * rendering constant: `MIN_SPINE_PX`.
     */
    spineMinPx: 10,
    spineMaxPx: 30,
  },

  search: {
    /**
     * The seven constants `docs/search_rules.md` "Balancing signals against each
     * other" names `E`, `P`, `T`, `Pt`, `S`, `L`, `C`: one exact tag, the
     * saturating partial-tag budget, one exact title match, the partial-title
     * budget, a short story match, the saturating long-story bonus, and CLIP.
     * Every non-CLIP signal is already an absolute ratio or count; CLIP is
     * min-maxed across the corpus for that query before its weight applies, and
     * `packages/map/scoring.ts`'s header is why a raw cosine cannot be weighted
     * directly.
     *
     * Each is chosen so the inequality its own rule states -
     * `docs/search_rules.md`'s "Tag matching", "Title matching" and "Story
     * matching" assertions - holds with margin rather than at the boundary.
     * `scoring.test.ts` asserts those inequalities against these numbers, so a
     * re-tune that breaks one fails a test instead of quietly changing the
     * ranking.
     */
    weights: {
      tagExact: 5,
      tagPartial: 0.45,
      titleExact: 5.5,
      titlePartial: 0.2,
      story: 0.4,
      storyLong: 2,
      clip: 1,
    },

    /**
     * Query tokens shorter than this never match. Without a floor, `a` matches
     * most keywords in the corpus by substring and the partial-match score stops
     * meaning anything.
     */
    minTokenLength: 3,

    /**
     * The longest query the box will take, in characters.
     *
     * A guard against a plausible accident rather than an attack: pasting a tag
     * list into the search field. Scoring is O(tokens x keywords) per room, so a
     * two-thousand-token query against a five-thousand-room corpus is tens of
     * millions of substring tests on the main thread, and the page simply stops.
     *
     * A bound is also what lets everything that displays a query stay sane - the
     * top bar names one in full, and history titles a book with it. Set well
     * above any real query: a sentence-long natural language search is a fraction
     * of this.
     */
    maxQueryLength: 256,

    /**
     * Precision the CLIP text tower loads at - one of `CLIP_TEXT_DTYPES`. 'fp32'
     * is the model's native precision; 'q8' quantises to a quarter the memory (one
     * byte per parameter instead of four) at some cost to embedding accuracy, the
     * tradeoff a memory-constrained host wants and a normal one does not.
     *
     * Server-side only: it governs `packages/server/app.ts`'s text tower, not the
     * vision tower `tools/embed/embed.ts` runs offline, which stays fp32 because it
     * runs once per corpus rather than per request.
     */
    clipTextDtype: 'fp32',

    /**
     * How a search's certainty becomes map density - see the gradient section of
     * `packages/map/ordering.ts`. `map.contentRatio` is the baseline these numbers
     * lift the middle of the map away from.
     */
    density: {
      /**
       * Density offered to a rank the search is certain about. 1 packs perfect
       * matches into every cell they meet, so a handful of exact hits reads as a
       * solid block against the center. Lower it to keep some wallpaper showing
       * through even the surest cluster.
       */
      peak: 1,

      /**
       * Certainty under this clusters nothing at all. `CERTAINTY_FLOOR`
       * (`packages/map/ordering.ts`) is where the reasoning is written down.
       */
      floor: CERTAINTY_FLOOR,

      /**
       * The three anchors of CLIP's signed certainty curve: `clipCentre` is the
       * no-opinion point (0), `clipHigh` a genuine match's typical confidence
       * (+1), `clipLow` a genuinely irrelevant query's (-1). The one part of the
       * gradient that is a measurement rather than a preference - `CLIP_CERTAINTY`
       * (`packages/map/scoring.ts`) is where they were measured.
       */
      clipCentre: CLIP_CERTAINTY.centre,
      clipHigh: CLIP_CERTAINTY.high,
      clipLow: CLIP_CERTAINTY.low,
    },
  },
};

/**
 * Merge an overlay over `DEFAULTS`, validating as it goes. Never throws: a bad
 * value falls back and every adjustment is reported in `notes`, which the server
 * prints at startup (AGENTS.md, "Config and the pyramid").
 *
 * @param raw the overlay, typically parsed `config.json`
 * @param opts.zoomLimits the hard range this config may narrow but not widen.
 *   Injected so the whole policy can be exercised at limits the app is not
 *   currently using.
 */
export function resolveConfig(raw: unknown = {}, { zoomLimits = ZOOM_LIMITS }: { zoomLimits?: ZoomLimits } = {}): Config {
  const notes: string[] = [];
  const src = asSection(raw, '', notes);

  const camIn = asSection(src.camera, 'camera', notes);
  const mapIn = asSection(src.map, 'map', notes);
  const searchIn = asSection(src.search, 'search', notes);
  const weightsIn = asSection(searchIn.weights, 'search.weights', notes);
  const densityIn = asSection(searchIn.density, 'search.density', notes);

  // Resolve "no narrowing" to the hard limits, then intersect. Both directions
  // are clamped rather than refused: a config asking for more range than exists
  // is a request that cannot be granted, not a corrupt file.
  const minZoom = numberOrNull(camIn.minZoom, DEFAULTS.camera.minZoom, 'camera.minZoom', notes);
  const maxZoom = numberOrNull(camIn.maxZoom, DEFAULTS.camera.maxZoom, 'camera.maxZoom', notes);
  let minZoomResolved = minZoom ?? zoomLimits.min;
  let maxZoomResolved = maxZoom ?? zoomLimits.max;

  if (minZoomResolved < zoomLimits.min) {
    notes.push(`camera.minZoom ${minZoomResolved} widens the range; clamped to ${zoomLimits.min}`);
    minZoomResolved = zoomLimits.min;
  }
  if (maxZoomResolved > zoomLimits.max) {
    notes.push(`camera.maxZoom ${maxZoomResolved} widens the range; clamped to ${zoomLimits.max}`);
    maxZoomResolved = zoomLimits.max;
  }
  if (minZoomResolved > maxZoomResolved) {
    notes.push(
      `camera.minZoom ${minZoomResolved} is above camera.maxZoom ${maxZoomResolved}; ` +
        `using the full range ${zoomLimits.min}-${zoomLimits.max}`
    );
    minZoomResolved = zoomLimits.min;
    maxZoomResolved = zoomLimits.max;
  }

  const minVisibleCells = atLeast(
    integer(camIn.minVisibleCells, DEFAULTS.camera.minVisibleCells, 'camera.minVisibleCells', notes),
    1,
    'camera.minVisibleCells',
    notes
  );

  return {
    camera: {
      minZoom: minZoomResolved,
      maxZoom: maxZoomResolved,
      minVisibleCells,
      flightMs: duration(camIn.flightMs, DEFAULTS.camera.flightMs, 'camera.flightMs', notes),
      keyboardMoveMs: duration(
        camIn.keyboardMoveMs, DEFAULTS.camera.keyboardMoveMs, 'camera.keyboardMoveMs', notes
      ),
      wheelZoomRate: nonNegative(camIn.wheelZoomRate, DEFAULTS.camera.wheelZoomRate, 'camera.wheelZoomRate', notes),
      zoomStepFactor: nonNegative(
        camIn.zoomStepFactor, DEFAULTS.camera.zoomStepFactor, 'camera.zoomStepFactor', notes
      ),
      cursorGranularityPx: atLeast(
        integer(
          camIn.cursorGranularityPx, DEFAULTS.camera.cursorGranularityPx, 'camera.cursorGranularityPx', notes
        ),
        1, 'camera.cursorGranularityPx', notes
      ),
      granularityHysteresis: nonNegative(
        camIn.granularityHysteresis, DEFAULTS.camera.granularityHysteresis, 'camera.granularityHysteresis', notes
      ),
      gesture: gesture(asSection(camIn.gesture, 'camera.gesture', notes), notes),
    },
    slide: slideTiming(asSection(src.slide, 'slide', notes), notes),
    catalog: catalog(asSection(src.catalog, 'catalog', notes), notes),
    center: center(asSection(src.center, 'center', notes), notes),
    map: {
      contentRatio: ratio(mapIn.contentRatio, DEFAULTS.map.contentRatio, 'map.contentRatio', notes),
      slotSeed: integer(mapIn.slotSeed, DEFAULTS.map.slotSeed, 'map.slotSeed', notes),
      genericSeed: integer(
        mapIn.genericSeed, DEFAULTS.map.genericSeed, 'map.genericSeed', notes
      ),
      distillFadeMs: duration(
        mapIn.distillFadeMs, DEFAULTS.map.distillFadeMs, 'map.distillFadeMs', notes
      ),
    },
    search: {
      weights: {
        tagExact: nonNegative(weightsIn.tagExact, DEFAULTS.search.weights.tagExact, 'search.weights.tagExact', notes),
        tagPartial: nonNegative(
          weightsIn.tagPartial, DEFAULTS.search.weights.tagPartial, 'search.weights.tagPartial', notes
        ),
        titleExact: nonNegative(
          weightsIn.titleExact, DEFAULTS.search.weights.titleExact, 'search.weights.titleExact', notes
        ),
        titlePartial: nonNegative(
          weightsIn.titlePartial, DEFAULTS.search.weights.titlePartial, 'search.weights.titlePartial', notes
        ),
        story: nonNegative(weightsIn.story, DEFAULTS.search.weights.story, 'search.weights.story', notes),
        storyLong: nonNegative(
          weightsIn.storyLong, DEFAULTS.search.weights.storyLong, 'search.weights.storyLong', notes
        ),
        clip: nonNegative(weightsIn.clip, DEFAULTS.search.weights.clip, 'search.weights.clip', notes),
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
 * rows renders nothing at all, a negative window is the same bug spelled
 * differently, and what the writer meant is obvious in both cases. A
 * `windowPages` of 0 is legal and meaningful - what pagination passes.
 */
function catalog(src: Section, notes: string[]): CatalogConfig {
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
    paging: paging as 'scroll' | 'pages',
  };
}

/**
 * The center shelf's auto-fit font range.
 *
 * Both floored at 1px, the way `catalog()` floors its counts. An inverted range
 * is refused outright: `fitFontSize` (`center.ts`) binary-searches between the
 * two, so a floor above the ceiling leaves every title no size that satisfies
 * both, and the pair falls back together the way camera's inverted zoom range
 * does.
 */
function center(src: Section, notes: string[]): CenterConfig {
  const d = DEFAULTS.center;
  const spineMinPx = atLeast(
    integer(src.spineMinPx, d.spineMinPx, 'center.spineMinPx', notes), 1, 'center.spineMinPx', notes
  );
  const spineMaxPx = atLeast(
    integer(src.spineMaxPx, d.spineMaxPx, 'center.spineMaxPx', notes), 1, 'center.spineMaxPx', notes
  );
  if (spineMinPx > spineMaxPx) {
    notes.push(
      `center.spineMinPx ${spineMinPx} is above center.spineMaxPx ${spineMaxPx}; ` +
        `using ${d.spineMinPx}/${d.spineMaxPx}`
    );
    return { spineMinPx: d.spineMinPx, spineMaxPx: d.spineMaxPx };
  }
  return { spineMinPx, spineMaxPx };
}

/**
 * The map's press/tap gesture thresholds - `camera.gesture` in the overlay.
 *
 * Each `*Ms` field is a duration and goes through `duration()`; each `*Px` field
 * is floored at 1 the way `catalog()`'s counts are, since a slop of zero or less
 * is not a meaningful "off" for a gesture, just a mis-typed number.
 */
function gesture(src: Section, notes: string[]): GestureConfig {
  const d = DEFAULTS.camera.gesture;
  const path = (key: keyof GestureConfig) => `camera.gesture.${key}`;
  const px = (key: keyof GestureConfig): number =>
    atLeast(integer(src[key], d[key], path(key), notes), 1, path(key), notes);
  const ms = (key: keyof GestureConfig): number => duration(src[key], d[key], path(key), notes);

  return {
    longPressMs: ms('longPressMs'),
    pressSlopPx: px('pressSlopPx'),
    doubleTapMs: ms('doubleTapMs'),
    doubleTapSlopPx: px('doubleTapSlopPx'),
    twoFingerTapMs: ms('twoFingerTapMs'),
    twoFingerTapGapMs: ms('twoFingerTapGapMs'),
    twoFingerTapSlopPx: px('twoFingerTapSlopPx'),
  };
}

/** Floor a value, with a note when it had to move. */
function atLeast(n: number, min: number, path: string, notes: string[]): number {
  if (n >= min) return n;
  notes.push(`${path} must be at least ${min}; using ${min}`);
  return min;
}

/**
 * The density gradient's block.
 *
 * A `peak` below `map.contentRatio` is not rejected here because the layout
 * treats the baseline as a floor anyway - a gradient may add density, never
 * remove it - so the worst such a config can do is switch the effect off. An
 * inverted cosine band gets a note and falls back: `clipHigh <= clipLow` means
 * CLIP contributes no certainty at all, which from the map looks like a corpus
 * with no embeddings blob.
 */
function density(src: Section, notes: string[]): SearchDensity {
  const d = DEFAULTS.search.density;
  const out = {
    peak: ratio(src.peak, d.peak, 'search.density.peak', notes),
    floor: ratio(src.floor, d.floor, 'search.density.floor', notes),
    clipCentre: number(src.clipCentre, d.clipCentre, 'search.density.clipCentre', notes),
    clipHigh: number(src.clipHigh, d.clipHigh, 'search.density.clipHigh', notes),
    clipLow: number(src.clipLow, d.clipLow, 'search.density.clipLow', notes),
  };
  if (!(out.clipHigh > out.clipCentre && out.clipCentre > out.clipLow)) {
    notes.push(
      `search.density.clipHigh ${out.clipHigh} / clipCentre ${out.clipCentre} / clipLow ${out.clipLow} ` +
        `are not in high > centre > low order; using ${d.clipHigh}/${d.clipCentre}/${d.clipLow}`
    );
    out.clipCentre = d.clipCentre;
    out.clipHigh = d.clipHigh;
    out.clipLow = d.clipLow;
  }
  return out;
}

/**
 * The rearrangement animation's timings.
 *
 * Each is a duration in milliseconds and gets the same treatment as the flight,
 * with one difference: the five beats are passed `composed`. They do not each
 * describe a whole animation, they add up to one - a run takes
 * `base + perCell x cells`, and `gap`, `stagger` and `cascade` are beats between
 * things that are themselves moving - so a value under one frame is ordinary
 * here and warning about it would be noise. The ceiling and the not-negative
 * rule still apply, and both still matter: a negative beat schedules a run to
 * start before the one it follows, and the animation applies its plan in
 * completion order.
 */
function slideTiming(src: Section, notes: string[]): SlideConfig {
  const d = DEFAULTS.slide;
  const out = {} as SlideConfig;
  for (const key of ['base', 'perCell', 'gap', 'stagger', 'cascade'] as const)
    out[key] = duration(src[key], d[key], `slide.${key}`, notes, { composed: true });
  // The one slide timing that is not composed: see
  // DEFAULTS.slide.prepareTimeoutMs.
  out.prepareTimeoutMs = duration(src.prepareTimeoutMs, d.prepareTimeoutMs, 'slide.prepareTimeoutMs', notes);
  return out;
}

/** A section of the overlay, or an empty one. Anything else is reported and ignored. */
function asSection(value: unknown, path: string, notes: string[]): Section {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    notes.push(`${path || 'config'} should be an object; ignoring it`);
    return {};
  }
  return value as Section;
}

/** A finite number, or the fallback with a note. */
function number(value: unknown, fallback: number, path: string, notes: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    notes.push(`${path} should be a finite number; using ${fallback}`);
    return fallback;
  }
  return value;
}

/** Like `number`, but `null` is meaningful rather than an error. */
function numberOrNull(value: unknown, fallback: number | null, path: string, notes: string[]): number | null {
  if (value === null) return null;
  return number(value, fallback, path, notes);
}

function integer(value: unknown, fallback: number, path: string, notes: string[]): number {
  const n = number(value, fallback, path, notes);
  if (!Number.isInteger(n)) {
    notes.push(`${path} should be a whole number; using ${Math.round(n)}`);
    return Math.round(n);
  }
  return n;
}

/** A fraction in (0, 1], matching what `createLayout()` will accept. */
function ratio(value: unknown, fallback: number, path: string, notes: string[]): number {
  const n = number(value, fallback, path, notes);
  if (!(n > 0 && n <= 1)) {
    notes.push(`${path} should be in (0, 1]; using ${fallback}`);
    return fallback;
  }
  return n;
}

/** At least one character, since a zero-length token matches everything. */
function tokenLength(value: unknown, fallback: number, path: string, notes: string[]): number {
  const n = integer(value, fallback, path, notes);
  if (n < 1) {
    notes.push(`${path} must be at least 1; using 1`);
    return 1;
  }
  return n;
}

/** Ceiling for any duration this config accepts, in milliseconds. */
const DURATION_MAX_MS = 5000;
/** One 60Hz frame. A whole animation shorter than this will not be seen. */
const ONE_FRAME_MS = 1000 / 60;

/**
 * An animation duration in milliseconds.
 *
 * Zero is legitimate and stays: it means arrive at once, which is how a config
 * turns an animation off. Negative is not a slower flight or a reversed one, it
 * is a typo. `prefers-reduced-motion` wins over any value here - every consumer
 * of a duration checks `useMapCamera.ts`'s `prefersReducedMotion` first.
 *
 * The ceiling is a judgement rather than a limit of anything: past a few seconds
 * a camera move has stopped being a transition and become a wait, so a value
 * that far out is likelier a units mistake than a taste.
 *
 * A positive sub-frame value is honoured and flagged. `0.45` is what seconds look
 * like typed into a milliseconds field - a valid way to say "no animation", but
 * otherwise a flight that silently never appears, which is the failure mode a
 * tuning file has. `composed` opts a value out of that note: a four millisecond
 * beat between two slides is a beat, not a flight nobody will see.
 */
function duration(
  value: unknown, fallback: number, path: string, notes: string[], { composed = false }: { composed?: boolean } = {}
): number {
  const n = number(value, fallback, path, notes);
  if (n < 0) {
    notes.push(`${path} should not be negative; using ${fallback}`);
    return fallback;
  }
  if (n > DURATION_MAX_MS) {
    notes.push(`${path} ${n} is longer than ${DURATION_MAX_MS}ms; using ${DURATION_MAX_MS}`);
    return DURATION_MAX_MS;
  }
  if (!composed && n > 0 && n < ONE_FRAME_MS) {
    notes.push(`${path} ${n} is shorter than one frame, so nothing will animate - milliseconds, not seconds?`);
  }
  return n;
}

/**
 * The precisions `search.clipTextDtype` accepts: transformers.js's `dtype`
 * options. Anything else is a typo, not a request for a precision that does not
 * exist.
 */
const CLIP_TEXT_DTYPES = ['fp32', 'fp16', 'q8', 'q4', 'int8', 'uint8', 'q4f16', 'bnb4'];

function clipTextDtype(value: unknown, notes: string[]): string {
  const d = DEFAULTS.search.clipTextDtype;
  if (value === undefined) return d;
  if (typeof value !== 'string' || !CLIP_TEXT_DTYPES.includes(value)) {
    notes.push(`search.clipTextDtype should be one of ${CLIP_TEXT_DTYPES.join(', ')}; using ${d}`);
    return d;
  }
  return value;
}

/**
 * Any non-negative number - a search weight (zero is a legitimate "ignore
 * this signal"), or a camera rate/factor (zero is a legitimate "this input
 * does nothing", the same reasoning `duration()` gives zero).
 */
function nonNegative(value: unknown, fallback: number, path: string, notes: string[]): number {
  const n = number(value, fallback, path, notes);
  if (n < 0) {
    notes.push(`${path} should not be negative; using ${fallback}`);
    return fallback;
  }
  return n;
}
