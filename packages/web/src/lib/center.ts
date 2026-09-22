/**
 * The center tile's interface, as pure code: the geometry of its controls, the
 * shelf's title assignment, the hit-tests, and how titles are composited onto
 * spines.
 *
 * Cell (0, 0) is title page, user interface, and anchor at once. What is mapped
 * onto the art:
 *
 * - the shelf's closed books: `BOOK_COUNT` slots, the first two and the last
 *   reserved for fixed functions (`overrides` in `useCenterShelf.ts`), the rest
 *   lettered by `assignTitles`
 * - the open book in a shelf gap: the artist's statement
 * - the search bar, drawn as a metal bar across the top of the room
 * - a panel beneath it: the favorite and global-count sort switches, and the
 *   shuffle button below those
 *
 * Every rect here is in cell fractions - `{x, y, w, h}` read against the cell's
 * own width and height - so a width and a height in one rect are not the same
 * distance: AGENTS.md's "The fractions are per-axis". They come from one trace,
 * `tools/center-placement/lib/geometry.ts`, and an element the reference SVG did
 * not carry at the last import is null: a null control is left out of the
 * interface rather than guessed at.
 *
 * See also:
 * - `useCenterShelf.ts`: the behaviors tied to these elements
 * - `../main.tsx`: search history state
 *
 * No DOM: the compositing takes a 2d context but reads nothing back.
 */
import { layout, type Rect } from '../../../../tools/center-placement/lib/geometry.ts';
import { prng, seedFrom } from '../../../map/prng.ts';
import { CELL_ASPECT, fitZoom, pxPerCell, worldToScreen, type Camera, type ViewportRect, type ZoomLimits } from './camera.ts';
import { BASE_TILE } from './pyramid.ts';
import type { DrawContext } from './render.ts';
import { SPINE_FONT_FAMILY } from './spineFont.ts';
import { flattenPath, pointInPolygon } from './svgPath.ts';
import { HOVER_GLOW_FILL, HOVER_GLOW_STROKE } from './cssVars.ts';

const GEOMETRY = layout({ width: 1, height: 1 });

/**
 * The bookshelf's bounding box within the center cell: the union of every
 * shelf's books. `main.tsx` frames the opening view on this and the search box,
 * together as `CENTER_OPENING_RECT`.
 */
export const CENTER_SHELF_RECT: Rect = GEOMETRY.opening;

/**
 * Where the live search field belongs on the center tile, in the same cell
 * fractions as `CENTER_SHELF_RECT`. Traced from the SVG's `search_box` rect.
 */
export const CENTER_SEARCH_RECT: Rect = GEOMETRY.searchBox;

/**
 * Hit regions for the two sort-mode switches ("my favorites", "most favorited")
 * and the reorder ("shuffle") button.
 */
export const CENTER_SHUFFLE_RECT: Rect | null = GEOMETRY.shuffleButton;
export const CENTER_MINE_TOGGLE_RECT: Rect | null = GEOMETRY.mineToggle;
export const CENTER_COUNT_TOGGLE_RECT: Rect | null = GEOMETRY.countToggle;

/**
 * The open book painted into a shelf gap, which opens the artist's statement.
 * Unlike the other controls it has no rectangular shape, so it is traced as an
 * exact SVG path; the coordinates are still cell fractions, so drawing it needs
 * `viewBox="0 0 1 1"` and `preserveAspectRatio="none"`. Distinct from
 * `BOOK_RECTS`: despite being a book, it is mechanically independent of the
 * closed books, which are treated as one interconnected wall.
 */
export const CENTER_BOOK_PATH: string | null = GEOMETRY.centerBook?.d ?? null;

/** Cubic Bezier samples per curve segment in `CENTER_BOOK_POLYGON`. */
const CURVE_SAMPLES = 12;

/**
 * `CENTER_BOOK_PATH` flattened into a polygon at module load, which is what
 * `centerBookAtPoint` tests points against. Cubic segments are sampled rather
 * than solved: a fixed sample count is precise enough to hit-test a silhouette,
 * and it keeps this pure and assertable without a browser, where `Path2D` and
 * `isPointInFill` would need a live canvas.
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
 * ids. `MapView.tsx` positions its DOM buttons from these, so the buttons and
 * the painted spines are the same wall.
 */
export const BOOK_RECTS: Rect[] = BOOKS;

/** How many searches the history queue can show at once - the whole wall. */
export const HISTORY_SLOT_COUNT = BOOK_COUNT;

/** One shelf's books, as a flat-index band - an entry in `ROWS`. */
interface Row {
  start: number;
  count: number;
}

/**
 * The wall's books grouped by shelf, as flat-index bands. This is what an up or
 * down arrow moves by, in `bookNeighbour`; `RUNS` is the grouping the hit-test
 * uses, because it has to be finer.
 */
const ROWS: Row[] = (() => {
  let flat = 0;
  return GEOMETRY.shelves.map((s) => {
    const row = { start: flat, count: s.books.length };
    flat += row.count;
    return row;
  });
})();

/** A contiguous group of books on one shelf - an entry in `RUNS`. */
interface Run {
  start: number;
  count: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * The wall's books grouped into runs, in cell fractions. A book more than one of
 * its own widths past the previous one starts a new run, so a shelf is not
 * necessarily one run: the art can break it, and the gap left for the open book
 * does.
 *
 * `bookAtPoint` walks these rather than `ROWS` so that a point in a gap wider
 * than a book resolves to nothing rather than to whichever book sits nearest -
 * AGENTS.md's "center.ts is the pure half".
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
// Art numbers, read where they are used. The spine title's font range is the
// exception, and lives in `config.center` as `spineMinPx`/`spineMaxPx`.

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
/** The hovered book's plate fill, in place of the usual stroked halo. */
const HOVER_BACKDROP = 'rgba(0,0,0,0.55)';

/**
 * The auto-fit range a spine title's font is sized within, per title:
 * `config.center`'s `spineMinPx`/`spineMaxPx`, threaded in as a parameter so
 * this file states no fallback of its own (AGENTS.md's "Consuming files state no
 * fallback defaults").
 */
export interface SpineFontLimits {
  /** floor: a long title shrinks toward this and no further, then is truncated with an ellipsis */
  minPx: number;
  /** ceiling, also capped by spine width: a short title grows to this */
  maxPx: number;
}
/** Spine-width fraction feeding the auto-fit ceiling, same knob as font-lab's `sizeScale`. */
const SPINE_SIZE_SCALE = 0.82;
/**
 * The halo's line width is this fraction of the font size, floored at
 * `SPINE_HALO_FLOOR`.
 */
const SPINE_HALO_SCALE = 0.1;
/** The floor under the halo's line width, so a small title still gets a visible halo. */
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
 * The center cell is one cell of an infinite map, so at most zooms it is nowhere
 * near the screen, while the search field and book buttons it carries are
 * mounted permanently and only shown while it is. `main.tsx`'s `centreOverlay`
 * is where that and the size gates combine.
 */
export function overlapsViewport(rect: Rect, width: number, height: number): boolean {
  return rect.x + rect.w > 0 && rect.x < width && rect.y + rect.h > 0 && rect.y < height;
}

/**
 * Whether a screen rect is entirely within the viewport, not merely overlapping
 * it - the stricter of `main.tsx`'s two viewport checks in `centreOverlay`, and
 * what `goToSearch` weighs before it focuses the search field.
 */
export function fullyInViewport(rect: Rect, width: number, height: number): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= width && rect.y + rect.h <= height;
}

/**
 * Whether the spines are wide enough on screen to carry a title. This is the
 * shelf's one zoom gate: `composeSpines` draws no titles below it and
 * `main.tsx`'s `centreOverlay` gives the books no tab stop either, so a reader
 * never tabs to a book nobody can see named.
 */
export function areSpinesLegible(cellRect: Rect): boolean {
  return BOOKS.length > 0 && BOOKS[0].w * cellRect.w >= MIN_SPINE_PX;
}

/**
 * Which index an arrow key focuses next, from `from` and a direction `dir`.
 *
 * The wall is one flat queue, so left and right run across shelf ends. Up and
 * down move by shelf, aiming at the same column and taking the nearest titled
 * book either side of it.
 *
 * A book with no title is stepped over rather than landed on: it is a control
 * with nothing to say. `assignTitles` leaves one only where history has not
 * reached and the corpus has no tags left to cycle.
 *
 * `from` may sit outside the wall, which is how Home and End are expressed: -1
 * with `dx: 1` is the first titled book, `BOOK_COUNT` with `dx: -1` the last.
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
    // The aim is a starting point, not the answer: a shorter shelf, or one whose
    // far end is untitled, should still catch the press rather than pass it
    // through to the next shelf.
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
 * Gated on height alone, the box's thin axis, at the same kind of floor
 * `MIN_SPINE_PX` is for a spine.
 */
export function isSearchBoxUsable(cellRect: Rect): boolean {
  return searchBoxScreenRect(cellRect).h >= MIN_SEARCH_BOX_PX;
}

/**
 * The zoom below which the search field cannot be usable whatever else the
 * camera is framed on: where the box's own on-screen height reaches
 * `MIN_SEARCH_BOX_PX`, read independently of the shelf.
 */
export function minZoomForSearchBox(aspect: number = CELL_ASPECT): number {
  return MIN_SEARCH_BOX_PX / (aspect * CENTER_SEARCH_RECT.h);
}

/**
 * A hair under 1, so the opening view leaves breathing room around the
 * shelf+box union instead of jamming it to the viewport's edge.
 */
const OPENING_MARGIN = 0.94;

/**
 * The zoom the map opens at: `CENTER_OPENING_RECT` fit to the viewport, floored
 * at what the search box alone needs and capped at the tile's native width so a
 * load is never already upscaled. This is the page-load view of AGENTS.md's
 * "Two opening views", not the return-to-center one (`overviewZoom`).
 * `main.tsx`'s `goToSearch` flies here, so the search button never moves the
 * camera further than where the page opened.
 */
export function openingZoom(viewport: ViewportRect, limits?: ZoomLimits): number {
  return Math.min(
    BASE_TILE.w,
    Math.max(
      fitZoom({ ...viewport, target: CENTER_OPENING_RECT, limits, margin: OPENING_MARGIN }),
      minZoomForSearchBox()
    )
  );
}

/** Whether a screen point lands on the live, currently-usable search field. */
export function searchBoxAtPoint(px: number, py: number, cellRect: Rect): boolean {
  if (!isSearchBoxUsable(cellRect)) return false;
  const b = searchBoxScreenRect(cellRect);
  return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
}

/**
 * Whether a screen point lands inside the open center book: the one element with
 * no box shape, so it is hit-tested against `CENTER_BOOK_POLYGON`. The point is
 * converted into the same cell fractions that path is written in.
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
 * A run's row band and its column band must both hold the point; within those
 * columns the position is floored into one of `run.count` slots, so a click in
 * the gap between two spines still resolves to a book. A gap wider than a book
 * belongs to no run at all - see `RUNS`.
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
 *   1. overrides - reserved books with a fixed function, such as opening the
 *      help dialog, keyed by flat book id. Placed first, and never overwritten.
 *   2. history - past searches, newest first, into the wall's books in flat
 *      order (top left to bottom right), skipping any book an override claimed.
 *      The most recent search is therefore the first unreserved book.
 *   3. tags - the keyword pool, filling every book history has not reached,
 *      cycled when the pool is smaller than the wall so no book is left blank.
 *
 * Deterministic in its inputs. A `history` or `tag` slot carries a `term` to
 * search; an `override` slot carries an `action` to dispatch. Every book gets a
 * slot: with no tags to cycle it is `kind: 'empty'` with no text, which is the
 * only way a book ends up untitled, and `bookNeighbour` steps over those.
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
 * The accessible name for a book's button.
 *
 * The title alone is not enough: a wall of buttons named `art nouveau`,
 * `brass`, `spiral staircase` says nothing about what pressing one does, and the
 * wall mixes two kinds that do different things - a past search to repeat, and a
 * keyword to try. The canvas paints the title alone, because the shelf around it
 * already reads as a shelf; the name has to carry both halves.
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
 * Seeded from the `seed` argument and the pool's size, so the wall does not
 * reshuffle on every render but does reshuffle when the corpus's keyword set
 * changes. Deduped, because the same keyword on many rooms is one tag. Bounded at
 * `BOOK_COUNT`; `assignTitles` cycles a shorter pool to fill the rest.
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
 * The 2d-context surface `composeSpines` needs beyond `render.ts`'s
 * `DrawContext`: the text and path operations a cell blit never touches. Only
 * this file reads the extra members, and a real context satisfies the shape
 * structurally - `DrawContext`'s doc covers why these widened interfaces need no
 * adapter at the two cast sites, `render.ts` and `gl/spineTexture.ts`.
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
  // The hovered book's backdrop plate: `HOVER_BACKDROP` filled under the title
  // in place of the stroked halo.
  roundRect(x: number, y: number, w: number, h: number, r: number): void;
  fill(): void;
}

/**
 * Composite the titles onto the center tile's books.
 *
 * Gated on `areSpinesLegible`, so a spine too narrow to carry readable text gets
 * none rather than a smear of sub-pixels. An `empty` book gets nothing.
 *
 * Each title reads top to bottom down the spine, the way a shelved book is
 * printed, and is sized per title by `fitFontSize`: a short word grows to fill
 * the spine, a long one shrinks toward the floor, and only a title that still
 * does not fit there is truncated with an ellipsis. `fontLimits` is
 * `config.center`'s range - see `SpineFontLimits`.
 *
 * `hoveredBook` (a flat slot id, or null) is the book under the pointer, from
 * the same `bookAtPoint` hit-test a click uses - see `useMapRenderer.ts`'s
 * `onMove`. It gets the glow documented on `HOVER_GLOW_FILL` first, then the
 * backdrop plate in place of the halo outline, so the plate sits on top of the
 * glow and the title stays legible.
 *
 * An override book is underlined. It does something other than run a search, and
 * a title alone does not say which: "the catalog" reads like a keyword until it
 * is pressed.
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
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < rects.length; i++) {
    const slot = slots[i];
    if (!slot || !slot.text) continue;
    const r = rects[i];
    const ceilingPx = Math.max(minPx, Math.min(maxPx, Math.floor(r.w * SPINE_SIZE_SCALE)));

    // The glow covers the whole upright spine rect, unrotated - the same rect the
    // DOM button occupies - and is painted before the rotated text so the plate
    // lands on top of it.
    if (i === hoveredBook) {
      ctx.fillStyle = HOVER_GLOW_FILL;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.lineWidth = 1;
      ctx.strokeStyle = HOVER_GLOW_STROKE;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
    }

    ctx.save();
    // Rotate so the text runs down the spine.
    ctx.translate(r.x + r.w / 2, r.y);
    ctx.rotate(Math.PI / 2);
    const inset = Math.min(4, r.h * 0.1);
    const available = r.h - inset * 2;
    const mid = r.h / 2;
    const { fontPx, text } = fitSpineText(ctx, slot.text, available, minPx, ceilingPx);
    ctx.font = `${fontPx}px ${SPINE_FONT_FAMILY}`;

    if (i === hoveredBook) {
      const padX = Math.max(1.5, fontPx * 0.14);
      const padY = Math.max(1, fontPx * 0.16);
      const width = ctx.measureText(text).width;
      ctx.fillStyle = HOVER_BACKDROP;
      ctx.beginPath();
      ctx.roundRect(mid - width / 2 - padX, -fontPx / 2 - padY, width + padX * 2, fontPx + padY * 2, Math.min(3, fontPx * 0.28));
      ctx.fill();
    } else {
      ctx.lineWidth = Math.max(SPINE_HALO_FLOOR, fontPx * SPINE_HALO_SCALE);
      ctx.strokeStyle = HALO;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, mid, 0);
    }
    ctx.fillStyle = INK;
    ctx.fillText(text, mid, 0);

    // The override's underline: two strokes, halo then gilt, so it reads on any
    // spine tone like the title does.
    if (slot.kind === 'override') {
      const width = ctx.measureText(text).width;
      const drop = fontPx * 0.62;
      ctx.lineWidth = Math.max(1, fontPx / 11);
      ctx.strokeStyle = HALO;
      ctx.beginPath();
      ctx.moveTo(mid - width / 2, drop);
      ctx.lineTo(mid + width / 2, drop);
      ctx.stroke();
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(0.75, fontPx / 16);
      ctx.beginPath();
      ctx.moveTo(mid - width / 2, drop);
      ctx.lineTo(mid + width / 2, drop);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

/** A spine title's fitted size and, once truncated, its final text. */
interface SpineFit {
  fontPx: number;
  text: string;
}

/**
 * `composeSpines`'s per-spine cache: a title's fitted font size and truncated
 * text depend only on the text and the fit inputs below, not on which frame is
 * being drawn, so a camera move that keeps every spine at the same rounded
 * scale reuses the previous `measureText` search instead of repeating it.
 * `clearSpineFitCache` drops it once `loadSpineFont` swaps the real webfont in
 * for the Georgia fallback, since that changes the metrics `measureText`
 * would return for the same text.
 */
const spineFitCache = new Map<string, SpineFit>();

/** Quantizes `available` to 4 device px, coarse enough that a fitted size rarely moves between buckets. */
const fitBucket = (n: number): number => Math.round(n / 4) * 4;

/**
 * Cached `fitFontSize` + `fitText` for one spine title. `ctx.font` is left set
 * to whatever the last measurement used - the caller always reassigns it
 * from the returned `fontPx` before drawing, cache hit or not.
 */
function fitSpineText(
  ctx: Pick<SpineContext, 'font' | 'measureText'>,
  text: string,
  available: number,
  minPx: number,
  ceilingPx: number
): SpineFit {
  const key = `${text}\u0000${fitBucket(available)}\u0000${minPx}\u0000${ceilingPx}`;
  const cached = spineFitCache.get(key);
  if (cached) return cached;
  const fontPx = fitFontSize(ctx, text, available, minPx, ceilingPx);
  ctx.font = `${fontPx}px ${SPINE_FONT_FAMILY}`;
  const fitted: SpineFit = { fontPx, text: fitText(ctx, text, available) };
  spineFitCache.set(key, fitted);
  return fitted;
}

/**
 * Drops every memoized spine fit. Call once the webfont in `spineFont.ts`
 * finishes loading and swaps in for the Georgia fallback `composeSpines` used
 * until then - the same text can fit a different font size once its real
 * metrics are available, and a stale cache entry would leave it sized for
 * Georgia until something else evicts it.
 */
export function clearSpineFitCache(): void {
  spineFitCache.clear();
}

/**
 * The largest integer font size in `[minPx, ceilingPx]` whose rendered width
 * still fits `maxWidth`. At `minPx` it stops shrinking and `fitText` truncates
 * with an ellipsis instead. Same search as `tools/font-lab/render.ts`'s
 * `fitFontSize`, whose sweep is where `config.center`'s range came from.
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
