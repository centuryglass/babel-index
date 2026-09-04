/**
 * Placement, rendering constants, and pure utility functions for the center
 * tile interface. This includes the following:
 *
 * - Help window button: The first book on the shelves
 * - Catalog mode button: The second book on the shelves
 * - Buttons for restoring previous searches, padded out with random keywords:
 *   Mapped to the remaining closed books on the shelves, except possibly the
 *   last
 * - Clear search history button: Mapped to the final book, only when search
 *   history is non-empty
 * - Artist statement: Mapped to the open book in the center of the room.
 * - Search bar: as a metal bar across the top of the room
 * - Sort by favorite/by global favorite count: Two buttons on a panel beneath
 *   the search bar.
 * - Shuffle button: As a panel with a d6 die icon beneath the favorite sort
 *   buttons.
 *
 * Cell (0, 0) in the map serves as title page, user interface, and anchor.
 * It contains a set of control elements mapped to features within the room
 * image. This file contains pure code managing how those elements are
 * displayed geometry, title assignment, hit-test, and compositing.
 *
 * All geometry within this file is defined in relation to the size of the
 * center cell, in cell fractions(`{x, y, w, h}` against width and height.
 * All geometry is imported from a single reference SVG by geometry.ts.
 * *NOTE*: Because dimensions are relative to the cell, width and height
 * values are not equivalent.
 *
 * Nullable elements will only be null if they were not present in the
 * reference SVG at last import time. Any null element will be excluded from
 * the interface.
 *
 * See also:
 * - ../hooks/useCenterShelf.ts: Controls the actual behaviors tied to the UI
 *   elements.
 * - tools/center-placement/lib/geometry.ts: The source of truth for all
 *   geometry, parsed trom a reference SVG.
 * - ../main.tsx: Manages search history state.
 *
 * No DOM (the compositing takes a 2d context but reads nothing back).
 */
import { layout, type Rect } from '../../../../tools/center-placement/lib/geometry.ts';
import { prng, seedFrom } from '../../../../tools/center-placement/lib/prng.ts';
import { CELL_ASPECT, pxPerCell, worldToScreen, type Camera, type ViewportRect } from './camera.ts';
import type { DrawContext } from './render.ts';
import { SPINE_FONT_FAMILY } from './spineFont.ts';
import { flattenPath, pointInPolygon } from './svgPath.ts';

const GEOMETRY = layout({ width: 1, height: 1 });

/**
 * The bookshelf's bounding box within the center cell; the union of
 * every shelf's books. Used along with search bar bounds by `main.jsx` to
 * frame the opening view.
 */
export const CENTER_SHELF_RECT: Rect = GEOMETRY.opening;

/**
 * Where the live search field belongs on the center tile, in the same cell
 * fractions as `CENTER_SHELF_RECT`. Traced from the SVG's `search_box` rect.
 */
export const CENTER_SEARCH_RECT: Rect = GEOMETRY.searchBox;

/**
 * Hit regions for the two sort-mode switches ("my favorites",
 * "most favorited") and the reorder ("shuffle") button.
 */
export const CENTER_SHUFFLE_RECT: Rect | null = GEOMETRY.shuffleButton;
export const CENTER_MINE_TOGGLE_RECT: Rect | null = GEOMETRY.mineToggle;
export const CENTER_COUNT_TOGGLE_RECT: Rect | null = GEOMETRY.countToggle;

/**
 * The open book painted into a shelf gap that opens the artist's statement
 * page. Unlike the other center tile elements, this item doesn't have a
 * simple rectangular shape, so it's traced as an exact SVG path rather
 * than a box. Coordinates are still relative to the cell, so it'll need to be
 * drawn with `viewBox="0 0 1 1"` and `preserveAspectRatio="none".
 * Distinct from `BOOK_RECTS`: despite being a book, it is mechanically
 * independent from the array of closed books that are treated as
 * interconnected.
 */
export const CENTER_BOOK_PATH: string | null = GEOMETRY.centerBook?.d ?? null;

/** Cubic Bezier sample count per curve segment - see `CENTER_BOOK_POLYGON`. */
const CURVE_SAMPLES = 12;

/**
 * `CENTER_BOOK_PATH` flattened into a polygon at module load, used by
 * `centerBookAtPoint` to test points. Cubic segments are sampled rather than
 * solved exactl because we don't need an exact curve just to render a
 * decent-looking path with reliable precision, and a fixed sample count keeps
 * this pure and assertable without a browser (no `Path2D`/`isPointInFill`,
 * which need a  live canvas).
 */
const CENTER_BOOK_POLYGON: { x: number; y: number }[] | null = CENTER_BOOK_PATH
  ? flattenPath(CENTER_BOOK_PATH, CURVE_SAMPLES)
  : null;

/**
 * The opening view's real framing target: the bounding-box union of the
 * bookshelf and the search box, so that core controls are all on-screen when
 * the page is opened.
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
 * top left to bottom right. A book's index in this array is its slot id
 * everywhere below - in the assignment, the hit-test and the overrides.
 */
const BOOKS: Rect[] = GEOMETRY.shelves.flatMap((s) => s.books.map(({ x, y, w, h }) => ({ x, y, w, h })));

/** How many books the wall has in total. */
export const BOOK_COUNT = BOOKS.length;

/**
 * Every book's rect as raw cell fractions, in the same flat order as the slot
 * ids - what the DOM overlay lays its buttons out in. Exported because 
 * MapView.tsx uses these to build the book element CSS, and sharing them
 * ensures the DOM and canvas book placements stay in sync.
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
 * The wall's books grouped by SHELF, as flat-index bands, for the sake of
 * arrow-key navigation. Distinct from runs, which track book clusters for
 * hit testing.
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

/**
 * Per-run bands, in fractions: a run is a CONTIGUOUS group of books on one
 * shelf, and a shelf may hold more than one. Used for hit tracking, so
 * accidentally clicking between a book and its neighbor rounds properly to
 * target what you actually intended to click. Distinct from rows because
 * rows may contain large gaps (e.g. the center artist's statement button's
 * place), and clicking within those gaps shouldn't be interpreted as
 * clicking the nearest book.
 */
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

// TODO: I'm not sure putting these here is the best approach. The point of
//       config is that all the tunable numbers are neatly organized in a
//       single spot, where they can be easily found and adjusted. Because these
//       constants weren't there, I didn't even know to find them here.

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

// TODO: see, this is what I mean by that previous point. Everything below
//       in this comment block is contrary to what it says above about
//       constant placement.
//
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
 * Whether the spines are wide enough on screen to carry a title. Book
 * controls are disabled when zoomed out too far to actually read titles.
 */
export function areSpinesLegible(cellRect: Rect): boolean {
  return BOOKS.length > 0 && BOOKS[0].w * cellRect.w >= MIN_SPINE_PX;
}

/**
 * Given a starting index `from` and an arrow key direction `dir`, find which
 * index should be focused next.
 *
 * The wall is one flat queue, so left and right are just the next and previous
 * book across shelf ends. Up and down move by SHELF, selecting based on which
 * books are visibly above or below the current index
 *
 * Books with no title are non-functional, so they are stepped over. In
 * practice, will basically never happen, as books are only left blank when
 * the search history is not long enough and there's no tags within the corpus
 * to assign to the remaining books.
 *
 * `from` may be outside the wall on purpose: -1 with `dx: 1` is "the first
 * titled book", `BOOK_COUNT` with `dx: -1` is the last.
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

/**
 * Any traced cell-fraction rect on this tile, scaled onto a center-cell
 * rect.
 */
function rectOnCell(rect: Rect, cellRect: Rect): Rect {
  return {
    x: cellRect.x + rect.x * cellRect.w,
    y: cellRect.y + rect.y * cellRect.h,
    w: rect.w * cellRect.w,
    h: rect.h * cellRect.h,
  };
}

/** The live search field's rect in screen pixels, scaled onto a center-cell rect. */
export function searchBoxScreenRect(cellRect: Rect): Rect {
  return rectOnCell(CENTER_SEARCH_RECT, cellRect);
}

/** Below this, on each axis, a control is too small to be a fair click/tap target. */
const MIN_CONTROL_PX = 16;

/**
 * Whether a traced control rect is both present in the trace and large
 * enough on screen to be worth hit-testing.
 */
function controlUsable(rect: Rect | null, cellRect: Rect): boolean {
  if (!rect) return false;
  const r = rectOnCell(rect, cellRect);
  return r.w >= MIN_CONTROL_PX && r.h >= MIN_CONTROL_PX;
}

/** The reorder ("shuffle") control's rect in screen pixels, or null if untraced. */
export function shuffleButtonScreenRect(cellRect: Rect): Rect | null {
  return CENTER_SHUFFLE_RECT && rectOnCell(CENTER_SHUFFLE_RECT, cellRect);
}

/** The "sort by my favorites" switch's rect in screen pixels, or null if untraced. */
export function mineToggleScreenRect(cellRect: Rect): Rect | null {
  return CENTER_MINE_TOGGLE_RECT && rectOnCell(CENTER_MINE_TOGGLE_RECT, cellRect);
}

/** The "sort by most favorited" switch's rect in screen pixels, or null if untraced. */
export function countToggleScreenRect(cellRect: Rect): Rect | null {
  return CENTER_COUNT_TOGGLE_RECT && rectOnCell(CENTER_COUNT_TOGGLE_RECT, cellRect);
}

/** Whether a screen point lands on the reorder ("shuffle") control. */
export function shuffleButtonAtPoint(px: number, py: number, cellRect: Rect): boolean {
  if (!controlUsable(CENTER_SHUFFLE_RECT, cellRect)) return false;
  return pointInRect(px, py, rectOnCell(CENTER_SHUFFLE_RECT as Rect, cellRect));
}

/** Whether a screen point lands on the "sort by my favorites" switch. */
export function mineToggleAtPoint(px: number, py: number, cellRect: Rect): boolean {
  if (!controlUsable(CENTER_MINE_TOGGLE_RECT, cellRect)) return false;
  return pointInRect(px, py, rectOnCell(CENTER_MINE_TOGGLE_RECT as Rect, cellRect));
}

/** Whether a screen point lands on the "sort by most favorited" switch. */
export function countToggleAtPoint(px: number, py: number, cellRect: Rect): boolean {
  if (!controlUsable(CENTER_COUNT_TOGGLE_RECT, cellRect)) return false;
  return pointInRect(px, py, rectOnCell(CENTER_COUNT_TOGGLE_RECT as Rect, cellRect));
}

function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

/**
 * Whether the live search field is large enough on screen to show and use.
 * Gated on height, the box's thin axis: the same idea as `MIN_SPINE_PX`
 */
export function isSearchBoxUsable(cellRect: Rect): boolean {
  return searchBoxScreenRect(cellRect).h >= MIN_SEARCH_BOX_PX;
}

/**
 * The zoom below which the search field cannot be usable, whatever else the
 * camera is framed on. This is the zoom the box alone needs, independent of the shelf.
 */
export function minZoomForSearchBox(aspect: number = CELL_ASPECT): number {
  return MIN_SEARCH_BOX_PX / (aspect * CENTER_SEARCH_RECT.h);
}

/**
 * Whether a screen point lands on the live, currently-usable search field.
 */
export function searchBoxAtPoint(px: number, py: number, cellRect: Rect): boolean {
  if (!isSearchBoxUsable(cellRect)) return false;
  const b = searchBoxScreenRect(cellRect);
  return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
}

/**
 * Whether a screen point lands within the open center book's bounds: the one
 * element with a shape that doesn't cleanly map to a simple bounding box.
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
 * to a book.
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
 *   1. OVERRIDES - reserved books with a distinct function, e.g. opening a
 *      help dialog). Keyed by flat book id, placed first, and never
 *      overwritten.
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
 * filled if possible: slots will only remain null in the unusual case where a
 * corpus contains zero tags.
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
 * Get screen reader text for any book's button is called.
 *
 * The title alone is not enough: forty buttons named `art nouveau`, `brass`,
 * `spiral staircase` say nothing about what pressing one does, and the wall
 * mixes two things that do different things - a past search to repeat and a
 * keyword to try. The canvas draws the title alone because the shelf around it
 * already says it is a shelf; the accessible name has to carry both halves.
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
 * touches. Kept as its own interface rather than folded into `DrawContext`
 * because the added properties are never used outside of this file and its
 * tests. Except in unit tests, this will always be used for real HTML
 * canvas 2D contexts.
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
 * renders none at all rather than a smear of sub-pixels. We start zoomed-in,
 * so users can figure out that they need to be zoomed to use these controls.
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
 * keyword until it is pressed.
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
    // plate sits on top of it. Covers the whole upright
    // spine rect, unrotated, the same rect the DOM button occupies.
    if (i === hoveredBook) {
      ctx.fillStyle = HOVER_GLOW_FILL;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.lineWidth = 1;
      ctx.strokeStyle = HOVER_GLOW_STROKE;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
    }

    ctx.save();
    // Turn so the text runs DOWN the spine.
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

    // Ensure override books have a unique appearance:
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
