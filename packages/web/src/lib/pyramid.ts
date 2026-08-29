/**
 * The resolution pyramid: which size of each room to draw, and how much to keep.
 *
 * THIS FILE IS THE TUNING SURFACE. Every number that decides what gets fetched,
 * what gets held and what gets thrown away is a constant at the top of this
 * file, with the arithmetic that justifies it written next to it. Nothing else
 * in the codebase should contain a pyramid number - `tiles.ts` reads the ladder
 * and the budgets, the render loop reads pickLevel() and PREFETCH. Tune here.
 *
 * The problem being solved: the map draws full-resolution images at every zoom,
 * so a zoomed-out screen of ~7500 cells wants ~22 GB of decoded bitmap. Picking
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
 * Nothing here assumes a tile size or a tile shape. BASE_TILE is the only place
 * either is stated; the ladder is expressed as divisors of it, and every pixel
 * count, byte count and level choice is derived. See "Changing the tile" below.
 *
 * No DOM, no imports: this is arithmetic and policy, tested as such.
 */

export interface Size {
  w: number;
  h: number;
}

export interface LevelSpec {
  level: number;
  divisor: number;
  budget: number;
}

export interface PrefetchConfig {
  margin: number;
  marginRatio: number;
  concurrency: number;
  warmCoarser: boolean;
}

export interface SheetsConfig {
  fromLevel: number;
  roomsPerSheet: number;
  cols: number;
  rows: number;
  cacheBudget: number;
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A demand can be a plain width, or a {w, h} rect when the drawn cell's shape differs from the tile's. */
export type Demand = number | Size;

/**
 * The source tile the pipeline writes at level 0 - the base render's pixel
 * dimensions, and the ONLY statement of tile size or aspect in the codebase's
 * runtime path.
 *
 * ### Changing the tile
 *
 * Edit this one object. Sizes, decoded-byte costs, level selection and the
 * ladder's reachability all derive from it, and `npm test` re-checks the
 * derived facts against the new shape:
 *
 *   - that every level is still reachable within the camera's zoom clamp (a
 *     much taller tile needs a rung added or dropped),
 *   - that every budget still holds a worst-case screen at the new aspect,
 *     since a shorter tile fits more rows and so puts more cells on a screen.
 *
 * Non-square is not merely tolerated, it is what the tile currently is: 4:3.
 * The aspect is threaded through the whole map from here - `camera.js` derives
 * CELL_ASPECT from this object and applies it in `pxPerCell()`, and
 * `packages/map` takes it to measure distance in cell widths. Change the shape
 * and the world changes shape with it, which is the point.
 *
 * The trace that produced `tools/center-placement/lib/measured.ts` records the
 * shape it was made at, and `geometry.test.mjs` asserts it against this
 * object - so this and the `viewBox` of `shelf_geometry.svg` cannot drift apart
 * silently.
 */
export const BASE_TILE: Size = { w: 1024, h: 768 };

/**
 * The ladder, finest first.
 *
 * `divisor` is what BASE_TILE is divided by, so the ladder is a statement about
 * ratios and survives any change to the tile. Level 0 is the source art.
 *
 * `budget` is the maximum number of entries held at that level. For a
 * per-file level (below `SHEETS.fromLevel`) that is still literally "decoded
 * images held" - it is a ceiling, not a reservation; entries appear only as
 * cells are visited. For a sheet-packed level it counts cheap per-room
 * pointers `{sheetUrl, rect}` instead (see tiles.ts) - the actual decoded
 * bytes for those levels are bounded separately by `SHEETS.cacheBudget`,
 * shared across every sheet-packed level, since one decoded sheet image now
 * serves hundreds of rooms. The table below states real decoded-byte cost
 * only for levels 0-1; treat its rows for 2-4 as "budget bytes" no longer
 * meaning real memory.
 *
 * At the current BASE_TILE of 1024x768 that works out as (bytes/tile being
 * w x h x 4, decoded RGBA - what the browser actually holds; the encoded JPEG
 * is ~20x smaller and is not the constraint):
 *
 *   level      size  bytes/tile  budget  budget bytes  worst-case visible*
 *       0  1024x768        3 MB     480      1,440 MB                  30
 *       1   512x384      768 KB     800        600 MB                  99
 *       2   256x192      192 KB    1800        338 MB†                336
 *       3    128x96       48 KB    3200        150 MB†                1271
 *       4     64x48       12 KB   16400        192 MB†                7500
 *                                          ~1.7 GB nominal, ~2.5 GB real*
 *
 * *worst-case visible = cells on a 2560x1440 device-pixel viewport at the
 * zoom in that level's band which shows the most of them. Every budget is
 * comfortably above its own worst case, which is the point: a cache that
 * cannot hold one screen thrashes within a single frame. That column moves
 * with BASE_TILE's aspect, which is why the test recomputes it rather than
 * trusting this comment - treat the table as illustrative, the test as true.
 * Going 4:3 is what last moved it: a shorter tile fits more rows on the same
 * screen, so the coarsest level's worst case rose past its old 7000 budget.
 *
 * †Not real bytes - see above. Real bytes for levels 2-4 come from
 * `SHEETS.cacheBudget` sheets instead, at their own (much larger) per-image
 * size; "~2.5 GB real" adds a 2048-room corpus's full complement of sheets
 * (SHEETS's own docblock) on top of levels 0-1's real cost, which is the
 * actual ceiling to budget a machine against, not the nominal table total.
 *
 * Note how far above its worst case level 0 is - 480 against 30. That is rule
 * 3 buying revisits, not screens: you can tour many rooms up close and come
 * back to the first without a refetch. Lower CACHE_SCALE if the total is more
 * than the machine can spare; the ratios between levels are the part worth
 * keeping. Levels 0-1 were doubled (240->480, 400->800) once sheets took
 * levels 2-4's real byte cost off this budget's plate, freeing room to hold
 * more revisits of the levels that are still one file per room.
 */
export const LEVELS: LevelSpec[] = [
  { level: 0, divisor: 1, budget: 480 },
  { level: 1, divisor: 2, budget: 800 },
  { level: 2, divisor: 4, budget: 1800 },
  { level: 3, divisor: 8, budget: 3200 },
  { level: 4, divisor: 16, budget: 16400 },
];

/**
 * One dial over every budget, for machines that cannot spare the total above
 * (or can spare more). 0.5 halves every level; the ratios between levels are
 * what matters and they survive scaling.
 */
export const CACHE_SCALE = 1;

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
 * `margin` is the FLOOR on how many cells beyond the viewport edge to warm, so
 * a pan always has somewhere to go even at the tightest zoom. Two cells is
 * roughly a third of a second of a brisk drag at the zooms where cells are
 * large, and cheap at the zooms where they are not.
 *
 * `marginRatio` is what actually governs the ring at anything but the closest
 * zoom - see `marginFor()`. A fixed cell count is a shrinking fraction of the
 * screen the further the camera zooms out (the same 2 cells is 20% of a
 * 10-cell-wide screen but 0.1% of an 2000-cell-wide one), which is backwards:
 * a fast pan at a coarse zoom crosses many more cells per gesture, exactly
 * where warming further ahead is closest to free, because those levels are
 * sheet-packed (see SHEETS) - most of a wider ring resolves to a sheet
 * already resident rather than a new request.
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
export const PREFETCH: PrefetchConfig = {
  margin: 2,
  marginRatio: 0.15,
  concurrency: 4,
  warmCoarser: true,
};

/**
 * Which coarse levels get packed into shared fixed-grid tilesheets, and how.
 *
 * A zoomed-out scroll session requests distinct tiles at these levels the
 * fastest - level 4's worst-case-visible is ~7500 cells on one screen - so
 * these are what turn a scroll into thousands of never-before-seen URLs and
 * trip Cloudflare's per-IP rate limit even for one real visitor (see
 * infra/README.md and docs/design-history.md). Packing `roomsPerSheet` rooms
 * into one grid image cuts that to one request per sheet, letting the edge
 * cache actually warm instead of perpetually seeing cold URLs.
 *
 * Levels below `fromLevel` stay one file per room: fewer of them are ever
 * visible at once (level 0's worst case is 30), and every room a sheet
 * contains re-uploads as a unit whenever any one of them changes (see
 * tools/upload/lib.ts) - the fewer rooms per sheet, the smaller that blast
 * radius, so leaving the request-cheap levels unpacked costs nothing and
 * avoids paying that tradeoff where it isn't needed.
 *
 * `cols * rows` must equal `roomsPerSheet` - `packages/pipeline/sheets.ts`
 * and `packages/server/scan.ts` both assert this rather than deriving one
 * from the other, so a bad edit fails loudly instead of packing a partial
 * grid.
 */
export const SHEETS: SheetsConfig = {
  fromLevel: 2,
  roomsPerSheet: 256,
  cols: 16,
  rows: 16,
  /**
   * Decoded sheet images held at once, across every sheet-packed level
   * combined (`tiles.ts`'s `sheetImages`, a budget on top of - not instead
   * of - the per-level room-pointer budgets in `LEVELS`). A corpus of N
   * rooms has `ceil(N / roomsPerSheet)` sheets per sheet-packed level, so
   * once this is at least (sheet-packed levels) x (sheets per level), the
   * whole coarse end of the pyramid fits in memory at once and a full scroll
   * of the map costs zero further sheet requests, ever, however far the
   * corpus grows past that point. 64 comfortably covers a 2048-room corpus
   * (24 sheets total across levels 2-4); raise it for a much larger one.
   */
  cacheBudget: 64,
};

export interface PyramidOpts {
  base?: Size;
  levels?: LevelSpec[];
  cacheScale?: number;
  hysteresis?: number;
}

export interface Pyramid {
  base: Size;
  levels: LevelSpec[];
  /** The coarsest level - what rule 1 falls back on, and what is preloaded. */
  fallbackLevel: number;
  finestLevel: number;
  sizeOf: (level: number) => Size | null;
  bytesOf: (level: number) => number;
  budgetOf: (level: number) => number;
  budgetBytes: (level: number) => number;
  totalBudgetBytes: () => number;
  demandWidth: (drawn: Demand) => number;
  idealLevel: (drawn: Demand) => number;
  pickLevel: (drawn: Demand, current?: number | null) => number;
  bestAvailable: (isReady: (level: number) => boolean, want: number) => number | null;
  warmLevels: (level: number) => number[];
}

/**
 * Build a pyramid over a tile shape and a ladder.
 *
 * A factory rather than bare functions so the whole policy can be exercised at
 * a different tile size or aspect without editing the constants above - which
 * is how the tests prove none of this is pinned to one size or one aspect, and
 * how an experiment can try a shape before it is adopted.
 */
export function createPyramid({
  base = BASE_TILE,
  levels = LEVELS,
  cacheScale = CACHE_SCALE,
  hysteresis = HYSTERESIS,
}: PyramidOpts = {}): Pyramid {
  const byLevel = new Map(levels.map((l) => [l.level, l]));
  const coarsest = levels[levels.length - 1];
  const finest = levels[0];

  /** The stored pixel dimensions of a level. Rounded, so a divisor need not divide evenly. */
  const sizeOf = (level: number): Size | null => {
    const entry = byLevel.get(level);
    if (!entry) return null;
    return {
      w: Math.max(1, Math.round(base.w / entry.divisor)),
      h: Math.max(1, Math.round(base.h / entry.divisor)),
    };
  };

  /** Decoded RGBA bytes one tile of this level costs. */
  const bytesOf = (level: number): number => {
    const size = sizeOf(level);
    return size ? size.w * size.h * 4 : 0;
  };

  /** The budget for a level, after cacheScale. Always at least 1. */
  const budgetOf = (level: number): number => {
    const entry = byLevel.get(level);
    return entry ? Math.max(1, Math.round(entry.budget * cacheScale)) : 0;
  };

  /** What a full level costs, and what a full pyramid costs. Derived, never written down. */
  const budgetBytes = (level: number): number => budgetOf(level) * bytesOf(level);
  const totalBudgetBytes = (): number => levels.reduce((sum, l) => sum + budgetBytes(l.level), 0);

  /**
   * Demand, normalised to level-0 width-equivalent device pixels.
   *
   * Selection needs one number, but a drawn cell has two dimensions and they
   * need not share the tile's aspect (a square cell holding a wide tile, say).
   * Scaling the height demand by the tile's aspect puts both axes on the width
   * ladder, and taking the larger means a tile is never chosen that
   * under-resolves the axis that needed more.
   */
  const demandWidth = (drawn: Demand): number =>
    typeof drawn === 'number' ? drawn : Math.max(drawn.w, drawn.h * (base.w / base.h));

  /**
   * The level that would be chosen with no regard for what is already on
   * screen: the smallest tile that is not smaller than the demand, so a tile is
   * never upscaled while a big enough one exists.
   *
   * Demand is in DEVICE pixels - `zoom * devicePixelRatio` - because that is
   * what the tile actually covers. Picking on CSS pixels ships half-resolution
   * art to every retina display.
   */
  const idealLevel = (drawn: Demand): number => {
    const need = demandWidth(drawn);
    for (let i = levels.length - 1; i > 0; i--) {
      const size = sizeOf(levels[i].level);
      if (size && need <= size.w) return levels[i].level;
    }
    return finest.level;
  };

  /**
   * The level to draw, given what is being drawn now.
   *
   * Identical to idealLevel() on the first call and whenever the zoom has moved
   * decisively; near a boundary it holds the current level until the demand is
   * `hysteresis` clear of it. A big jump still lands on the true ideal rather
   * than creeping one level per frame.
   */
  const pickLevel = (drawn: Demand, current: number | null = null): number => {
    const ideal = idealLevel(drawn);
    if (current == null || current === ideal) return ideal;

    // Lower level number = finer. Moving finer must clear the boundary upward,
    // moving coarser must clear it downward; testing the biased demand
    // expresses both without a special case.
    const need = demandWidth(drawn);
    const biased = ideal < current ? need / (1 + hysteresis) : need * (1 + hysteresis);
    return idealLevel(biased) === current ? current : ideal;
  };

  /**
   * Rule 1: the best level actually available for a room, given the one wanted.
   *
   * Coarser first, because a coarse tile is cheap, is usually already resident
   * from the zoomed-out view, and upscales to something soft but correct. Finer
   * only after that - it is memory already spent, so drawing it beats drawing
   * nothing, but it is the expensive way to be right.
   *
   * Returns null only when the room has no level at all.
   */
  const bestAvailable = (isReady: (level: number) => boolean, want: number): number | null => {
    if (isReady(want)) return want;
    for (const { level } of levels) if (level > want && isReady(level)) return level;
    for (let i = levels.length - 1; i >= 0; i--) {
      const { level } = levels[i];
      if (level < want && isReady(level)) return level;
    }
    return null;
  };

  /**
   * Rule 2: the levels to warm for cells visible right now, in priority order
   * after the visible level itself. Empty when there is nothing coarser.
   */
  const warmLevels = (level: number): number[] => {
    if (!PREFETCH.warmCoarser) return [];
    const coarser = levels.find((l) => l.level === level + 1);
    return coarser ? [coarser.level] : [];
  };

  return {
    base,
    levels,
    fallbackLevel: coarsest.level,
    finestLevel: finest.level,
    sizeOf,
    bytesOf,
    budgetOf,
    budgetBytes,
    totalBudgetBytes,
    demandWidth,
    idealLevel,
    pickLevel,
    bestAvailable,
    warmLevels,
  };
}

/** The pyramid the app runs on, built from the constants above. */
export const PYRAMID: Pyramid = createPyramid();

export const {
  fallbackLevel: FALLBACK_LEVEL,
  sizeOf,
  bytesOf,
  budgetOf,
  budgetBytes,
  totalBudgetBytes,
  demandWidth,
  idealLevel,
  pickLevel,
  bestAvailable,
  warmLevels,
} = PYRAMID;

/**
 * How wide a ring to warm around a given viewport: the larger of the flat
 * floor (`PREFETCH.margin`) and a fraction (`PREFETCH.marginRatio`) of the
 * viewport's own cell span - so the ring grows with how far out the camera
 * is, not just a fixed cell count. See `PREFETCH`'s docblock for why.
 */
export function marginFor(
  { x0, y0, x1, y1 }: Bounds,
  { margin, marginRatio }: Pick<PrefetchConfig, 'margin' | 'marginRatio'> = PREFETCH
): number {
  const span = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  return Math.max(margin, Math.round(span * marginRatio));
}

/**
 * Rule 2: the cell rectangle to load, viewport plus margin.
 *
 * The renderer draws `bounds` and loads `prefetchBounds(bounds)`, with
 * everything outside `bounds` queued behind everything inside it. Cells, not
 * pixels, so this is independent of the tile's size and shape. `margin`
 * defaults to `marginFor(bounds)` rather than a flat constant - see its
 * docblock.
 */
export function prefetchBounds(
  { x0, y0, x1, y1 }: Bounds,
  margin: number = marginFor({ x0, y0, x1, y1 })
): Bounds {
  return { x0: x0 - margin, y0: y0 - margin, x1: x1 + margin, y1: y1 + margin };
}
