/**
 * The resolution pyramid: which size of each room to draw, and how much to keep.
 *
 * THIS FILE IS THE TUNING SURFACE. Every number that decides what gets fetched,
 * what gets held and what gets thrown away is a constant at the top of this
 * file, with the arithmetic that justifies it written next to it. Nothing else
 * in the codebase should contain a pyramid number - `tiles.js` reads LEVELS and
 * the budgets, the render loop reads pickLevel() and PREFETCH. Tune here.
 *
 * The problem being solved: the map draws full-resolution images at every zoom,
 * so a zoomed-out screen of ~5700 cells wants ~23 GB of decoded bitmap. Picking
 * the level from zoom keeps decoded bytes per screen roughly constant however
 * far out the camera goes, which is what makes corpus size stop mattering for
 * rendering cost.
 *
 * Three rules, in the order they win when they conflict:
 *
 *   1. A cell never fails to display. Every lookup falls back through the other
 *      levels of the same room and then to the generic room, so the only way to
 *      draw nothing is for every level of every room to be missing.
 *   2. Cells load slightly before they are needed - a ring outside the viewport,
 *      and the next level out, warmed at lower priority than anything visible.
 *   3. Hold rather than refetch. Budgets below are generous on purpose and each
 *      level has its own, so zooming in cannot evict the coarse field that rule
 *      1 falls back on.
 *
 * No DOM, no imports: this is arithmetic and policy, tested as such.
 */

/**
 * The ladder, finest first. `size` is the pixel edge of the stored square tile;
 * level 0 is the source art (1024, what the corpus already is).
 *
 * `budget` is the maximum number of decoded images held at that level. It is a
 * ceiling, not a reservation - entries appear only as cells are visited.
 *
 * `bytes` below is size x size x 4 (decoded RGBA, what the browser actually
 * holds; the encoded JPEG is ~20x smaller and is not the constraint).
 *
 *   level  size  bytes/tile  budget  budget bytes  worst-case visible*
 *       0  1024        4 MB     240        960 MB                  24
 *       1   512        1 MB     400        400 MB                  77
 *       2   256      256 KB     900        225 MB                 273
 *       3   128       64 KB    1600        100 MB                 943
 *       4    64       16 KB    7000        112 MB                5700
 *                                        ~1.8 GB total
 *
 * *worst-case visible = cells on a 2560x1440 device-pixel viewport at the
 * zoom in that level's band which shows the most of them. Every budget is
 * comfortably above its own worst case, which is the point: a cache that
 * cannot hold one screen thrashes within a single frame.
 *
 * Note how far above its worst case level 0 is - 240 against 24. That is rule
 * 3 buying revisits, not screens: you can tour ten rooms up close and come
 * back to the first without a refetch. Lower CACHE_SCALE if 1.8 GB is more
 * than the machine can spare; the ratios between levels are the part worth
 * keeping.
 */
export const LEVELS = [
  { level: 0, size: 1024, budget: 240 },
  { level: 1, size: 512, budget: 400 },
  { level: 2, size: 256, budget: 900 },
  { level: 3, size: 128, budget: 1600 },
  { level: 4, size: 64, budget: 7000 },
];

/**
 * One dial over every budget, for machines that cannot spare 1.8 GB (or can
 * spare more). 0.5 halves every level; the ratios between levels are what
 * matters and they survive scaling.
 */
export const CACHE_SCALE = 1;

/** The coarsest level - the one rule 1 falls back on, and the one preloaded. */
export const FALLBACK_LEVEL = LEVELS[LEVELS.length - 1].level;

/**
 * How far past the exact boundary a zoom must go before the level switches.
 *
 * Without this, holding a zoom near a boundary flickers between two levels,
 * each switch a full screen of fetches. 0.15 means a level change needs the
 * demand to be 15% clear of the boundary, which is well outside the jitter of
 * a trackpad pinch and well inside a deliberate zoom.
 */
export const HYSTERESIS = 0.15;

/**
 * Rule 2, in numbers.
 *
 * `margin` is how many cells beyond the viewport edge to warm, so a pan has
 * somewhere to go. Two cells is roughly a third of a second of a brisk drag at
 * the zooms where cells are large, and cheap at the zooms where they are not.
 *
 * `concurrency` caps in-flight prefetches. Browsers allow ~6 connections per
 * host; leaving headroom is deliberate, because a prefetch that queues ahead of
 * a visible tile has made rule 1 worse to serve rule 2.
 *
 * `warmCoarser` warms the next level out for visible cells. The asymmetry is
 * intentional: zooming IN needs few tiles and the coarse one already on screen
 * upscales acceptably in the meantime, while zooming OUT needs four times as
 * many tiles at once and has nothing to show until they arrive.
 */
export const PREFETCH = {
  margin: 2,
  concurrency: 4,
  warmCoarser: true,
};

/** Level 0's tiles are the source art; `size` is what the pipeline writes. */
export const sizeOf = (level) => LEVELS.find((l) => l.level === level)?.size ?? null;

/** The budget for a level, after CACHE_SCALE. Always at least 1. */
export const budgetOf = (level) => {
  const entry = LEVELS.find((l) => l.level === level);
  return entry ? Math.max(1, Math.round(entry.budget * CACHE_SCALE)) : 0;
};

/**
 * The level that would be chosen with no regard for what is already on screen:
 * the smallest tile that is not smaller than the demand, so a tile is never
 * upscaled while a big enough one exists.
 *
 * Demand is in DEVICE pixels - `zoom * devicePixelRatio` - because that is what
 * the tile actually covers. Picking on CSS pixels ships half-resolution art to
 * every retina display.
 *
 * @param {number} devicePxPerTile
 * @returns {number} a level in LEVELS
 */
export function idealLevel(devicePxPerTile) {
  for (let i = LEVELS.length - 1; i > 0; i--)
    if (devicePxPerTile <= LEVELS[i].size) return LEVELS[i].level;
  return LEVELS[0].level;
}

/**
 * The level to draw, given what is being drawn now.
 *
 * Identical to idealLevel() on the first call and whenever the zoom has moved
 * decisively; near a boundary it holds the current level until the demand is
 * HYSTERESIS clear of it. A big jump still lands on the true ideal rather than
 * creeping one level per frame.
 *
 * @param {number} devicePxPerTile  zoom x devicePixelRatio
 * @param {number|null} current     the level being drawn, or null on first paint
 */
export function pickLevel(devicePxPerTile, current = null) {
  const ideal = idealLevel(devicePxPerTile);
  if (current == null || current === ideal) return ideal;

  // Lower level number = finer. Moving finer must clear the boundary upward,
  // moving coarser must clear it downward; testing the biased demand expresses
  // both without a special case.
  const biased =
    ideal < current ? devicePxPerTile / (1 + HYSTERESIS) : devicePxPerTile * (1 + HYSTERESIS);
  return idealLevel(biased) === current ? current : ideal;
}

/**
 * Rule 1: the best level actually available for a room, given the one wanted.
 *
 * Coarser first, because a coarse tile is cheap, is usually already resident
 * from the zoomed-out view, and upscales to something soft but correct. Finer
 * only after that - it is memory already spent, so drawing it beats drawing
 * nothing, but it is the expensive way to be right.
 *
 * @param {(level: number) => boolean} isReady
 * @param {number} want
 * @returns {number|null} null only when the room has no level at all
 */
export function bestAvailable(isReady, want) {
  if (isReady(want)) return want;
  for (const { level } of LEVELS) if (level > want && isReady(level)) return level;
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    const { level } = LEVELS[i];
    if (level < want && isReady(level)) return level;
  }
  return null;
}

/**
 * Rule 2: the levels to warm for cells that are visible right now, in priority
 * order after the visible level itself. Empty when there is nothing coarser.
 */
export function warmLevels(level) {
  if (!PREFETCH.warmCoarser) return [];
  const coarser = LEVELS.find((l) => l.level === level + 1);
  return coarser ? [coarser.level] : [];
}

/**
 * Rule 2: the cell rectangle to load, viewport plus margin.
 *
 * The renderer draws `bounds` and loads `prefetchBounds(bounds)`, with
 * everything outside `bounds` queued behind everything inside it.
 *
 * @param {{x0: number, y0: number, x1: number, y1: number}} bounds inclusive
 */
export function prefetchBounds({ x0, y0, x1, y1 }, margin = PREFETCH.margin) {
  return { x0: x0 - margin, y0: y0 - margin, x1: x1 + margin, y1: y1 + margin };
}
