/**
 * The center room's interactive book spines - the first piece of phase 5.
 *
 * Cell (0, 0) is the one room whose art we control, so it is the one room where
 * per-book hit-testing is meaningful (inpainting does not preserve shelf counts,
 * so no corpus room can be addressed book by book). Every book on the wall
 * (`BOOK_COUNT` of them) carries a composited title, and clicking a book runs
 * that title as a search. The book count and shelf count are a UI choice, sized
 * for legible search-history titles - see the trace itself, not a number
 * restated here that would only drift.
 *
 * Two roles share the wall:
 *
 *   - SEARCH HISTORY fills the wall as ONE continuous list, top left to bottom
 *     right, skipping any book an override has reserved. Every search projects
 *     onto the frontmost open slot, newest first, and clicking a book repeats
 *     its search. Shelves are small now that books are sized for legible
 *     titles, so a history confined to one shelf ran out of room fast; the
 *     whole wall is the queue instead.
 *   - Any book history has not yet reached shows a random corpus keyword, so
 *     the wall never carries a blank book while it fills in.
 *
 * This is the pure half, split out like `picking.js`: the part with a right
 * answer, assertable without a browser. It owns the book geometry, the title
 * assignment, the hit-test and the compositing; the hook decides WHEN a tap
 * happened and `main.jsx` owns the history state.
 *
 * The geometry comes from the SINGLE SOURCE - `tools/center-placement/lib/geometry.ts`,
 * the same pure module the tile trace is imported into. `layout({ width: 1,
 * height: 1 })` returns every rect as raw per-axis fractions (x, w against width;
 * y, h against height), which is exactly the space the map draws the center tile
 * in: `render.js` stretches the tile image width -> cellPx.x and height ->
 * cellPx.y independently, so a fraction scaled by each axis lands on the art it
 * was traced against.
 *
 * No DOM (the compositing takes a 2d context but reads nothing back).
 */
import { layout, type Rect } from '../../../../tools/center-placement/lib/geometry.ts';
import { prng, seedFrom } from '../../../../tools/center-placement/lib/prng.ts';
import { CELL_ASPECT, pxPerCell, worldToScreen, type Camera, type ViewportRect } from './camera.ts';
import type { DrawContext } from './render.ts';
import { SPINE_FONT_FAMILY } from './spineFont.ts';

const GEOMETRY = layout({ width: 1, height: 1 });

/**
 * The bookshelf's bounding box within the center cell, in cell fractions
 * (`{x, y, w, h}` against width and height). It is the union of every shelf's
 * books - the thing a reader comes to the center to read - and it sits LOW in
 * the tile, below the cornice and above the floor. The opening view frames
 * itself on this rect rather than on the cell so the shelf fills the display;
 * `main.jsx` fits and centers on it. Sourced from the one geometry module, so
 * it tracks any re-trace of the tile.
 */
export const CENTER_SHELF_RECT: Rect = GEOMETRY.opening;

/**
 * Where the live search field belongs on the center tile, in the same cell
 * fractions as `CENTER_SHELF_RECT`. Traced from the SVG's `search_box` rect.
 */
export const CENTER_SEARCH_RECT: Rect = GEOMETRY.searchBox;

/**
 * The open book painted into a shelf gap, traced as an exact SVG path rather
 * than a box - a bounding rect for this shape laps onto the spines either
 * side of it, which is the whole reason `import-shelf-svg.ts` walks the
 * traced `<path>` instead of reducing it to one. Every coordinate is a cell
 * fraction against `{x,y,w,h}` = `{width:1,height:1}`, i.e. this is exactly
 * what an SVG `viewBox="0 0 1 1"` with `preserveAspectRatio="none"` wants,
 * the same per-axis stretch every other rect on this tile gets. Null on a
 * trace that carries no `center_book`, in which case the hotspot never lights
 * up. Distinct from `BOOK_RECTS`: it is decorative art occupying a gap
 * between two runs (AGENTS.md's "open 'Index of Babel' book"), not one of the
 * lettered spines, so it carries its own hit-test rather than a slot id.
 */
export const CENTER_BOOK_PATH: string | null = GEOMETRY.centerBook?.d ?? null;

/**
 * `CENTER_BOOK_PATH` flattened into a polygon, once at module load - the
 * shape `centerBookAtPoint` below tests a point against. Cubic segments are
 * sampled rather than solved exactly: a hover/hit test has no need for a
 * mathematically exact curve, only one fine enough that the boundary looks
 * right at screen resolution, and a fixed sample count keeps this pure and
 * assertable without a browser (no `Path2D`/`isPointInFill`, which need a
 * live canvas).
 */
/** Cubic Bezier sample count per curve segment - see `CENTER_BOOK_POLYGON`. */
const CURVE_SAMPLES = 12;

const CENTER_BOOK_POLYGON: { x: number; y: number }[] | null = CENTER_BOOK_PATH
  ? flattenPath(CENTER_BOOK_PATH)
  : null;

/**
 * Flatten an SVG path in the canonical absolute M/L/C/Z grammar
 * `import-shelf-svg.ts` emits into a polygon of `{x, y}` points.
 *
 * Only what that grammar ever contains - the same restriction the importer
 * itself enforces on import, so a path that reaches this function is already
 * known to be one of these four commands.
 */
function flattenPath(d: string): { x: number; y: number }[] {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  const points: { x: number; y: number }[] = [];
  let cx = 0;
  let cy = 0;
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'Z') continue;
    if (cmd === 'M' || cmd === 'L') {
      cx = Number(tokens[i++]);
      cy = Number(tokens[i++]);
      points.push({ x: cx, y: cy });
    } else if (cmd === 'C') {
      const x1 = Number(tokens[i++]);
      const y1 = Number(tokens[i++]);
      const x2 = Number(tokens[i++]);
      const y2 = Number(tokens[i++]);
      const ex = Number(tokens[i++]);
      const ey = Number(tokens[i++]);
      for (let s = 1; s <= CURVE_SAMPLES; s++) {
        const t = s / CURVE_SAMPLES;
        const mt = 1 - t;
        points.push({
          x: mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * ex,
          y: mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * ey,
        });
      }
      cx = ex;
      cy = ey;
    }
  }
  return points;
}

/** Even-odd ray-casting point-in-polygon test, pure and browser-free. */
function pointInPolygon(px: number, py: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The opening view's real framing target: the bounding-box union of the
 * bookshelf and the search box. The search box sits above the shelf, outside
 * `CENTER_SHELF_RECT`, so fitting to the shelf alone risks leaving the live
 * field off the top edge depending on viewport aspect. `main.jsx` fits and
 * centers the opening camera on this rect instead.
 */
export const CENTER_OPENING_RECT: Rect = (() => {
  const a = CENTER_SHELF_RECT;
  const b = CENTER_SEARCH_RECT;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
})();

/**
 * Every book on the tile, flat, shelf-major and left to right within a shelf -
 * top left to bottom right, the way a reader's eye moves. A book's index in
 * this array is its slot id everywhere below - in the assignment, the hit-test
 * and the overrides - so there is one address for a book, not a (shelf, index)
 * pair to keep in step.
 */
const BOOKS: Rect[] = GEOMETRY.shelves.flatMap((s) => s.books.map(({ x, y, w, h }) => ({ x, y, w, h })));

/** How many books the wall has in total. */
export const BOOK_COUNT = BOOKS.length;

/**
 * Every book's rect as raw cell fractions, in the same flat order as the slot
 * ids - what the DOM overlay lays its buttons out in.
 *
 * Exported rather than kept private because the buttons are positioned in
 * PERCENTAGES of the center cell's screen rect, not in pixels: one container
 * is written per frame and the forty children inside it then need no per-frame
 * work at all (accessibility-plan.md §3.3). `bookScreenRects` is the same
 * numbers already scaled, for the canvas, which has no percentages.
 *
 * That the fractions are per-axis is load-bearing here for the same reason it
 * is in `render.js`: `x`/`w` are against the cell's width and `y`/`h` against
 * its height, and one divisor for both axes would put the focus ring on the
 * wrong book.
 */
export const BOOK_RECTS: Rect[] = BOOKS;

/** How many searches the history queue can show at once - the whole wall. */
export const HISTORY_SLOT_COUNT = BOOK_COUNT;

/** One shelf's books, as a flat-index band - see `ROWS` below. */
interface Row {
  start: number;
  count: number;
}

/**
 * The wall's books grouped by SHELF, as flat-index bands.
 *
 * Rows, not runs: a shelf broken into more than one run by art is still one
 * row to a reader moving up and down it, and the gap between two runs is not
 * somewhere the keyboard should stop. Runs exist for the hit-test, where a
 * point really can land in the gap; rows exist for the arrow keys, which move
 * between books and never between the spaces around them.
 */
const ROWS: Row[] = (() => {
  let flat = 0;
  return GEOMETRY.shelves.map((s) => {
    const row = { start: flat, count: s.books.length };
    flat += row.count;
    return row;
  });
})();

/** A contiguous group of books on one shelf - see `RUNS` below. */
interface Run {
  start: number;
  count: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// Per-run bands, in fractions: a run is a CONTIGUOUS group of books on one
// shelf, and a shelf may hold more than one - the trace is free to leave a gap
// wider than a book for art occupying part of the shelf (the open "Index of
// Babel" book on the middle shelf, say), and that gap must not resolve to a
// phantom book. A gap no wider than a book is still just the thin margin
// between two spines, and
// the hit-test floors a point into the run's columns so a click there still
// resolves to a book - the same "addressed by a pitch" discipline
// `picking.js` uses for cells. Runs, not shelves, are what the hit-test walks.
const RUNS: Run[] = (() => {
  interface Building { start: number; books: Rect[]; x1: number }
  const runs: Building[] = [];
  let flat = 0;
  for (const s of GEOMETRY.shelves) {
    let run: Building | null = null;
    for (const b of s.books) {
      if (run && b.x - run.x1 > b.w) run = null;
      if (!run) {
        run = { start: flat, books: [], x1: 0 };
        runs.push(run);
      }
      run.books.push(b);
      run.x1 = b.x + b.w;
      flat++;
    }
  }
  return runs.map((run) => ({
    start: run.start,
    count: run.books.length,
    x0: run.books[0].x,
    x1: run.books[run.books.length - 1].x + run.books[run.books.length - 1].w,
    y0: Math.min(...run.books.map((b) => b.y)),
    y1: Math.max(...run.books.map((b) => b.y + b.h)),
  }));
})();

// --- rendering constants, by feel ------------------------------------------
// These are art numbers, like `PROVISIONAL` in geometry.js or the chrome
// thresholds in render.js - not config, because nothing derives from them and
// no test pins their value.

/** Below this on-screen spine width, a title is sub-pixel; do not draw it. */
const MIN_SPINE_PX = 5;
/** Below this on-screen height, the live search field is too small to use or read. */
const MIN_SEARCH_BOX_PX = 22;
/** Title colour - warm gilt, legible on the range of spine tones in the art. */
const INK = 'rgba(238,230,214,0.92)';
/** A dark halo so the gilt reads on a light spine as well as a dark one. */
const HALO = 'rgba(12,9,6,0.85)';
/** The hovered book's plate fill, standing in for the halo (see `composeSpines`). */
const HOVER_BACKDROP = 'rgba(0,0,0,0.55)';
/** The hovered book's glow - same gold as `.center-book.hover` (index.html), painted
 *  across the whole spine BEHIND the backdrop plate rather than as a DOM overlay: the
 *  DOM sits above the canvas in paint order, so a CSS glow there would wash out over
 *  the composited title instead of sitting behind it. */
const HOVER_GLOW_FILL = 'rgba(200,169,95,0.28)';
const HOVER_GLOW_STROKE = 'rgba(200,169,95,0.55)';

// The font-lab sweep's winning settings (tools/font-lab, `--cap 32 --min 12
// --halo-scale 0.1 --font roboto-slab`) - a per-title auto-fit between a
// floor and a ceiling (see `fitFontSize`) rather than one size derived from
// spine width alone. The floor and ceiling themselves are `config.center`'s
// `spineMinPx`/`spineMaxPx` (packages/config/config.ts), not constants here -
// they are exactly the kind of by-feel number that file exists to hold, and
// `composeSpines` takes them as a parameter rather than restating a fallback,
// per AGENTS.md's "consuming files state no fallback defaults".
/** The auto-fit range `composeSpines` sizes a title's font within - `config.center`. */
export interface SpineFontLimits {
  /** floor: a long title shrinks toward this and no further, then is truncated with an ellipsis */
  minPx: number;
  /** ceiling, also capped by spine width: a short title grows to this */
  maxPx: number;
}
/** Spine-width fraction feeding the auto-fit ceiling, same knob as font-lab's `sizeScale`. */
const SPINE_SIZE_SCALE = 0.82;
/** halo lineWidth = max(SPINE_HALO_FLOOR, fontPx * SPINE_HALO_SCALE). */
const SPINE_HALO_SCALE = 0.1;
const SPINE_HALO_FLOOR = 1.5;

/**
 * The center cell's on-screen rectangle, for a given camera.
 *
 * The cell is addressed by its lower corner and spans one unit, so it runs from
 * world (0, 0) to (1, 1); its screen position is `worldToScreen(0, 0)` and its
 * size is one cell in each axis.
 */
export function centerCellRect(cam: Camera, canvasRect: ViewportRect): Rect {
  const tl = worldToScreen(0, 0, cam, canvasRect);
  const per = pxPerCell(cam);
  return { x: tl.x, y: tl.y, w: per.x, h: per.y };
}

/**
 * Whether a screen rect overlaps the viewport at all.
 *
 * The center cell is one cell of an infinite map, so at most zooms it is
 * nowhere near the screen. Both overlays it carries - the live search field
 * and the book buttons - are mounted permanently and shown only while it is,
 * so this is the half of "usable" that is about WHERE the cell is rather than
 * how big it is.
 */
export function overlapsViewport(rect: Rect, width: number, height: number): boolean {
  return rect.x + rect.w > 0 && rect.x < width && rect.y + rect.h > 0 && rect.y < height;
}

/**
 * Whether a screen rect is ENTIRELY within the viewport, not merely
 * overlapping it. `goToSearch` (main.tsx) needs this rather than
 * `overlapsViewport`: a search box only partly on screen is not one a reader
 * can actually read or use, even though it is technically "on screen" by the
 * weaker check.
 */
export function fullyInViewport(rect: Rect, width: number, height: number): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= width && rect.y + rect.h <= height;
}

/**
 * Whether the spines are wide enough on screen to carry a title.
 *
 * One statement of the zoom gate, read by the compositing below AND by the DOM
 * overlay in `main.jsx`: the buttons exist exactly while the titles do, so a
 * reader tabbing into the shelf is reaching books they can also see named.
 */
export function areSpinesLegible(cellRect: Rect): boolean {
  return BOOKS.length > 0 && BOOKS[0].w * cellRect.w >= MIN_SPINE_PX;
}

/**
 * The book an arrow key moves to from `from`, or `from` itself at the wall's
 * edge.
 *
 * The wall is one flat queue, so left and right are just the next and previous
 * book across shelf ends - the same order the titles are assigned in and the
 * same order a reader's eye travels. Up and down move by SHELF, holding the
 * column, because that is what the geometry looks like.
 *
 * Books with no title are stepped over rather than landed on: an untitled book
 * is a blank spine with nothing to search for, and a focus ring on one would be
 * a stop that does nothing. (It only happens at all on a corpus with no
 * keywords, where `assignTitles` has nothing to letter the far end of the wall
 * with.) Pure, so the whole walk is assertable without a browser.
 *
 * `from` may be outside the wall on purpose: -1 with `dx: 1` is "the first
 * titled book", `BOOK_COUNT` with `dx: -1` is the last, which is what Home and
 * End want and saves them a second entry point.
 *
 * @param from flat slot id
 * @param dir one step, as the keyboard handler has it
 * @param slots `assignTitles` output
 */
export function bookNeighbour(
  from: number,
  { dx = 0, dy = 0 }: { dx?: number; dy?: number },
  slots: (Slot | null)[] | null
): number {
  const titled = (i: number) => i >= 0 && i < BOOK_COUNT && Boolean(slots?.[i]?.text);

  if (dx) {
    for (let i = from + Math.sign(dx); i >= 0 && i < BOOK_COUNT; i += Math.sign(dx))
      if (titled(i)) return i;
    return from;
  }
  if (!dy) return from;

  const r = ROWS.findIndex((row) => from < row.start + row.count);
  if (r < 0) return from;
  const col = from - ROWS[r].start;
  for (let n = r + Math.sign(dy); n >= 0 && n < ROWS.length; n += Math.sign(dy)) {
    const row = ROWS[n];
    // Aim at the same column, then take the nearest titled book on that shelf
    // either side of it - a shorter shelf, or one whose far end is untitled,
    // should still catch the press rather than pass it through to the next.
    const aim = row.start + Math.min(col, row.count - 1);
    for (let d = 0; d < row.count; d++) {
      if (aim + d < row.start + row.count && titled(aim + d)) return aim + d;
      if (aim - d >= row.start && titled(aim - d)) return aim - d;
    }
  }
  return from;
}

/** Every book rect in screen pixels, scaled onto a center-cell rect. */
export function bookScreenRects(cellRect: Rect): Rect[] {
  return BOOKS.map((b) => ({
    x: cellRect.x + b.x * cellRect.w,
    y: cellRect.y + b.y * cellRect.h,
    w: b.w * cellRect.w,
    h: b.h * cellRect.h,
  }));
}

/** The live search field's rect in screen pixels, scaled onto a center-cell rect. */
export function searchBoxScreenRect(cellRect: Rect): Rect {
  const b = CENTER_SEARCH_RECT;
  return {
    x: cellRect.x + b.x * cellRect.w,
    y: cellRect.y + b.y * cellRect.h,
    w: b.w * cellRect.w,
    h: b.h * cellRect.h,
  };
}

/**
 * Whether the live search field is large enough on screen to show and use.
 * Gated on height, the box's thin axis - the same idea as `MIN_SPINE_PX`, but
 * a wide short strip is limited by how tall it is on screen, not how wide.
 */
export function isSearchBoxUsable(cellRect: Rect): boolean {
  return searchBoxScreenRect(cellRect).h >= MIN_SEARCH_BOX_PX;
}

/**
 * The zoom below which the search field cannot be usable, whatever else the
 * camera is framed on - the floor `goToSearch` (main.jsx) applies on top of
 * `CENTER_OPENING_RECT`'s fit. That fit binds on whichever axis of the
 * shelf+box union would overflow first, which on a narrow/portrait viewport
 * is the width - the shelf is wide relative to the screen, so the landing
 * zoom is picked to keep IT on screen and can leave the box, gated on
 * height alone, under `MIN_SEARCH_BOX_PX` even though the union itself
 * "fits". This is the zoom the box alone needs, independent of the shelf.
 */
export function minZoomForSearchBox(aspect: number = CELL_ASPECT): number {
  return MIN_SEARCH_BOX_PX / (aspect * CENTER_SEARCH_RECT.h);
}

/**
 * Whether a screen point lands on the live, currently-usable search field -
 * the same "addressed by a pitch" hit-test `bookAtPoint` runs for a spine,
 * reused so a tap on the box and a tap on a book resolve through one path.
 * That path already only fires on a genuine tap (`onTap` loses to a pan, a
 * pinch, or a flight), which is what lets a click activate the field while a
 * gesture that merely crosses its screen rect keeps panning or zooming - no
 * separate arbitration needed here.
 */
export function searchBoxAtPoint(px: number, py: number, cellRect: Rect): boolean {
  if (!isSearchBoxUsable(cellRect)) return false;
  const b = searchBoxScreenRect(cellRect);
  return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
}

/**
 * Whether a screen point lands on the open book's SILHOUETTE, not merely its
 * bounding box - a box loose enough to cover the whole shape laps onto the
 * spines either side of it (the reason `CENTER_BOOK_PATH` traces the outline
 * at all). Converts to the same cell-local fraction space `CENTER_BOOK_PATH`
 * is already in, then runs the flattened polygon through `pointInPolygon`.
 */
export function centerBookAtPoint(px: number, py: number, cellRect: Rect): boolean {
  if (!CENTER_BOOK_POLYGON) return false;
  const localX = (px - cellRect.x) / cellRect.w;
  const localY = (py - cellRect.y) / cellRect.h;
  return pointInPolygon(localX, localY, CENTER_BOOK_POLYGON);
}

/**
 * Which book is under a screen point, or null.
 *
 * Finds the run whose row band holds the point AND whose columns hold it, then
 * floors into those columns, so a click in the gap between two spines resolves
 * to a book. A shelf with more than one run (art breaking up the run) is
 * exactly why this checks every run rather than stopping at the first whose row
 * matches - a point between two runs on the same shelf must fall through to
 * null, not snap into whichever run happened to be checked first.
 */
export function bookAtPoint(px: number, py: number, cellRect: Rect): number | null {
  for (const run of RUNS) {
    const y0 = cellRect.y + run.y0 * cellRect.h;
    const y1 = cellRect.y + run.y1 * cellRect.h;
    if (py < y0 || py >= y1) continue;
    const x0 = cellRect.x + run.x0 * cellRect.w;
    const x1 = cellRect.x + run.x1 * cellRect.w;
    if (px < x0 || px >= x1) continue;
    const local = Math.floor(((px - x0) / (x1 - x0)) * run.count);
    return run.start + Math.max(0, Math.min(run.count - 1, local));
  }
  return null;
}

/** What `assignTitles` fills every book on the wall with. */
export interface Slot {
  kind: 'override' | 'history' | 'tag' | 'empty';
  text: string;
  /** the history/tag book's search term */
  term?: string;
  /** the override book's action to dispatch */
  action?: string;
}

export interface AssignTitlesOpts {
  /** past searches, newest first */
  history?: string[];
  /** a stable random selection of corpus keywords - see `pickTags` */
  tags?: string[];
  /** reserved books with a distinct function, keyed by flat book id */
  overrides?: Record<number, { text: string; action: string }>;
}

/**
 * Lay out what each book on the wall shows.
 *
 * Three sources, in strict precedence:
 *
 *   1. OVERRIDES - reserved books with a distinct function (a future artist's
 *      statement, say). Keyed by flat book id, placed first, and never
 *      overwritten. This is the seam the concept asks for; it ships empty.
 *   2. HISTORY - past searches, newest first, into the wall's books in flat
 *      order (top left to bottom right), skipping any book an override has
 *      claimed. So the most recent search is the first open book on the wall.
 *   3. TAGS - a random selection of corpus keywords, filling every book history
 *      has not reached. Cycled if the pool is smaller than the wall, so every
 *      book carries a title rather than leaving blanks - repeats only show up
 *      on the tiny sample corpus.
 *
 * Pure and deterministic in its inputs. A `history`/`tag` book carries a `term`
 * to search; an `override` book carries an `action` to dispatch. Every slot is
 * filled - never left null - by construction: the tag loop below runs across
 * every remaining index.
 */
export function assignTitles({ history = [], tags = [], overrides = {} }: AssignTitlesOpts = {}): Slot[] {
  const slots: (Slot | null)[] = new Array(BOOK_COUNT).fill(null);

  for (const [key, value] of Object.entries(overrides)) {
    const i = Number(key);
    if (Number.isInteger(i) && i >= 0 && i < BOOK_COUNT)
      slots[i] = { kind: 'override', text: value.text, action: value.action };
  }

  let hi = 0;
  for (let i = 0; i < BOOK_COUNT && hi < history.length; i++) {
    if (slots[i]) continue;
    const term = history[hi++];
    slots[i] = { kind: 'history', text: term, term };
  }

  for (let i = 0, ti = 0; i < BOOK_COUNT; i++) {
    if (slots[i]) continue;
    if (tags.length) {
      const term = tags[ti++ % tags.length];
      slots[i] = { kind: 'tag', text: term, term };
    } else {
      slots[i] = { kind: 'empty', text: '' };
    }
  }

  return slots as Slot[];
}

/**
 * What one book's button is called, for a reader who cannot see the spine.
 *
 * The title alone is not enough: forty buttons named `art nouveau`, `brass`,
 * `spiral staircase` say nothing about what pressing one does, and the wall
 * mixes two things that do different things - a past search to repeat and a
 * keyword to try. The canvas draws the title alone because the shelf around it
 * already says it is a shelf; the accessible name has to carry both halves.
 *
 * Naming, so it lives beside `describeCell` in spirit and here in fact - pure,
 * and assertable without a browser.
 */
export function describeBook(slot: Slot | null | undefined): string {
  if (!slot?.text) return '';
  if (slot.kind === 'history') return `${slot.text} - repeat this search`;
  if (slot.kind === 'override') return slot.text;
  return `${slot.text} - search the library for this`;
}

/** The slice of a room's metadata `pickTags` actually reads - not the full `RoomMeta`. */
interface KeywordSource {
  keywords?: { text: string }[];
}

/**
 * A stable random selection of keyword texts from the corpus, enough to letter
 * the whole wall.
 *
 * "Random" but reproducible: seeded, so the wall does not reshuffle on every
 * render. Deduped, because the same keyword on many rooms is one tag. Bounded at
 * the book count; `assignTitles` cycles a shorter pool to fill the rest.
 */
export function pickTags(metadata: (KeywordSource | null)[] | null, seed = 1): string[] {
  if (!metadata) return [];
  const texts = new Set<string>();
  for (const entry of metadata)
    for (const k of entry?.keywords ?? []) if (k.text) texts.add(k.text);

  const pool = [...texts];
  const rand = prng(seedFrom(`tags:${seed}:${pool.length}`));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rand.int(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, BOOK_COUNT);
}

/**
 * The 2d-context surface `composeSpines` needs, beyond `render.ts`'s own
 * `DrawContext` - the text/path operations render.js's cell-blitting never
 * touches. Kept as its own interface rather than folded into `DrawContext`:
 * `render.test.mjs` deliberately never passes `centreSlots` (AGENTS.md), so
 * its recording fake never implements `save`/`rotate`/etc, and widening
 * `DrawContext` itself would force it to grow stubs it has no use for.
 * `render.ts`'s `draw()` casts its own `ctx` to this at the one call site,
 * which is sound because that `ctx` is always a real 2d context in practice.
 */
export interface SpineContext extends DrawContext {
  save(): void;
  restore(): void;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  lineJoin: CanvasLineJoin;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  // The hovered book's backdrop plate (see `composeSpines`) - a rounded rect
  // behind the title instead of a stroked halo, so the CSS hover glow behind
  // it (`.center-books button.hover`, index.html) never washes out the text.
  roundRect(x: number, y: number, w: number, h: number, r: number): void;
  fill(): void;
}

/**
 * Composite the titles onto the center tile's books.
 *
 * ZOOM-GATED: a spine narrower than MIN_SPINE_PX carries no legible text, so it
 * carries none at all rather than a smear of sub-pixels. This is the "faithful
 * zoom-in reward" - a title is only readable once the reader has zoomed into
 * the center, which the map now opens having done.
 *
 * Each title reads TOP-TO-BOTTOM down the spine, the way a shelved book is
 * printed, sized PER TITLE by `fitFontSize` so a short word ("biology") grows
 * to fill the spine while a long one ("the garden of forking paths") shrinks
 * toward `fontLimits.minPx` instead of being drawn at one size and truncated -
 * only a title that still does not fit at the floor gets the ellipsis.
 * `fontLimits` is `config.center`'s `spineMinPx`/`spineMaxPx`, threaded down
 * through `render.ts`'s `DrawOpts` rather than defaulted here - see that
 * config block's doc comment. Drawn over a dark halo so gilt reads on any
 * spine tone. Draws nothing for an `empty` book.
 *
 * `hoveredBook` (a flat slot id, or null) is the one book under the pointer -
 * see `useMapRenderer.ts`'s `pointermove` listener, which runs the same
 * `bookAtPoint` hit-test a click does. That book gets a gold glow across the
 * whole spine (`HOVER_GLOW_FILL`/`_STROKE`) AND a backdrop plate instead of
 * the halo outline - both painted here, on the canvas, rather than as a DOM
 * overlay: the DOM sits above the canvas in paint order, so a CSS glow would
 * wash out over the composited title instead of sitting behind it. The glow
 * is drawn first, so the plate sits on top of it and the title stays legible.
 *
 * An OVERRIDE book is underlined. It does something other than run a search,
 * and nothing about a title says so - "the catalog" reads exactly like a
 * keyword until it is pressed. Placeholder styling for the font/text pass; the
 * requirement it meets is only that the difference is visible.
 */
export function composeSpines(
  ctx: SpineContext,
  cellRect: Rect,
  slots: (Slot | null)[],
  hoveredBook: number | null,
  fontLimits: SpineFontLimits
): void {
  if (!areSpinesLegible(cellRect)) return;
  const rects = bookScreenRects(cellRect);
  const { minPx, maxPx } = fontLimits;

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < rects.length; i++) {
    const slot = slots[i];
    if (!slot || !slot.text) continue;
    const r = rects[i];
    const ceilingPx = Math.max(minPx, Math.min(maxPx, Math.floor(r.w * SPINE_SIZE_SCALE)));

    // The hover glow, painted BEFORE the rotated text/plate below so the
    // plate sits on top of it rather than the DOM overlay sitting on top of
    // everything - see HOVER_GLOW_FILL's comment. Covers the whole upright
    // spine rect, unrotated, the same rect the DOM button occupies.
    if (i === hoveredBook) {
      ctx.fillStyle = HOVER_GLOW_FILL;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.lineWidth = 1;
      ctx.strokeStyle = HOVER_GLOW_STROKE;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
    }

    ctx.save();
    // Turn so the text runs DOWN the spine, as titles are printed and as books
    // are shelved: origin at the spine's head, a quarter-turn clockwise so +x
    // now points down the book.
    ctx.translate(r.x + r.w / 2, r.y);
    ctx.rotate(Math.PI / 2);
    const inset = Math.min(4, r.h * 0.1);
    const available = r.h - inset * 2;
    const fontPx = fitFontSize(ctx, slot.text, available, minPx, ceilingPx);
    ctx.font = `${fontPx}px ${SPINE_FONT_FAMILY}`;
    const text = fitText(ctx, slot.text, available);

    if (i === hoveredBook) {
      const padX = Math.max(1.5, fontPx * 0.14);
      const padY = Math.max(1, fontPx * 0.16);
      const width = ctx.measureText(text).width;
      ctx.fillStyle = HOVER_BACKDROP;
      ctx.beginPath();
      ctx.roundRect(inset - padX, -fontPx / 2 - padY, width + padX * 2, fontPx + padY * 2, Math.min(3, fontPx * 0.28));
      ctx.fill();
    } else {
      ctx.lineWidth = Math.max(SPINE_HALO_FLOOR, fontPx * SPINE_HALO_SCALE);
      ctx.strokeStyle = HALO;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, inset, 0);
    }
    ctx.fillStyle = INK;
    ctx.fillText(text, inset, 0);

    // An override book does something other than search, and a reader has no
    // way to tell that from a title alone - "the catalog" reads exactly like a
    // keyword until you press it. Underlined, in the ink it is already drawn
    // in, because the rotation makes this the one decoration that survives
    // reading down a spine. A placeholder for the font/text pass; what matters
    // is that the distinction is visible at all.
    if (slot.kind === 'override') {
      const width = ctx.measureText(text).width;
      const drop = fontPx * 0.62;
      ctx.lineWidth = Math.max(1, fontPx / 11);
      ctx.strokeStyle = HALO;
      ctx.beginPath();
      ctx.moveTo(inset, drop);
      ctx.lineTo(inset + width, drop);
      ctx.stroke();
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(0.75, fontPx / 16);
      ctx.beginPath();
      ctx.moveTo(inset, drop);
      ctx.lineTo(inset + width, drop);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

/**
 * The largest integer font size in `[minPx, ceilingPx]` whose rendered width
 * still fits `maxWidth` - see `composeSpines`'s doc comment. Falls back to
 * `minPx` (paired with `fitText`'s ellipsis) when even that doesn't fit.
 * Ported from `tools/font-lab/render.ts`'s `fitFontSize`, the tool this sizing
 * was worked out in.
 */
function fitFontSize(
  ctx: Pick<SpineContext, 'font' | 'measureText'>,
  text: string,
  maxWidth: number,
  minPx: number,
  ceilingPx: number
): number {
  ctx.font = `${ceilingPx}px ${SPINE_FONT_FAMILY}`;
  if (ctx.measureText(text).width <= maxWidth) return ceilingPx;
  let lo = minPx;
  let hi = ceilingPx;
  let best = minPx;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    ctx.font = `${mid}px ${SPINE_FONT_FAMILY}`;
    if (ctx.measureText(text).width <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Shorten `text` with an ellipsis until it fits `maxWidth` at the current font. */
function fitText(ctx: Pick<SpineContext, 'measureText'>, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}
