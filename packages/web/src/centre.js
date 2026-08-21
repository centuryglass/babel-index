/**
 * The centre room's interactive book spines - the first piece of phase 5.
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
 * The geometry comes from the SINGLE SOURCE - `tools/base-image/lib/geometry.js`,
 * the same pure module the tile trace is imported into. `layout({ width: 1,
 * height: 1 })` returns every rect as raw per-axis fractions (x, w against width;
 * y, h against height), which is exactly the space the map draws the centre tile
 * in: `render.js` stretches the tile image width -> cellPx.x and height ->
 * cellPx.y independently, so a fraction scaled by each axis lands on the art it
 * was traced against.
 *
 * No DOM (the compositing takes a 2d context but reads nothing back).
 */
import { layout } from '../../../tools/base-image/lib/geometry.js';
import { prng, seedFrom } from '../../../tools/base-image/lib/prng.js';
import { pxPerCell, worldToScreen } from './camera.js';

const GEOMETRY = layout({ width: 1, height: 1 });

/**
 * The bookshelf's bounding box within the centre cell, in cell fractions
 * (`{x, y, w, h}` against width and height). It is the union of every shelf's
 * books - the thing a reader comes to the centre to read - and it sits LOW in
 * the tile, below the cornice and above the floor. The opening view frames
 * itself on this rect rather than on the cell so the shelf fills the display;
 * `main.jsx` fits and centres on it. Sourced from the one geometry module, so
 * it tracks any re-trace of the tile.
 */
export const CENTRE_SHELF_RECT = GEOMETRY.opening;

/**
 * Where the live search field belongs on the centre tile, in the same cell
 * fractions as `CENTRE_SHELF_RECT`. Traced from the SVG's `search_box` rect.
 */
export const CENTRE_SEARCH_RECT = GEOMETRY.searchBox;

/**
 * The opening view's real framing target: the bounding-box union of the
 * bookshelf and the search box. The search box sits above the shelf, outside
 * `CENTRE_SHELF_RECT`, so fitting to the shelf alone risks leaving the live
 * field off the top edge depending on viewport aspect. `main.jsx` fits and
 * centres the opening camera on this rect instead.
 */
export const CENTRE_OPENING_RECT = (() => {
  const a = CENTRE_SHELF_RECT;
  const b = CENTRE_SEARCH_RECT;
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
const BOOKS = GEOMETRY.shelves.flatMap((s) => s.books.map(({ x, y, w, h }) => ({ x, y, w, h })));

/** How many books the wall has in total. */
export const BOOK_COUNT = BOOKS.length;

/**
 * Every book's rect as raw cell fractions, in the same flat order as the slot
 * ids - what the DOM overlay lays its buttons out in.
 *
 * Exported rather than kept private because the buttons are positioned in
 * PERCENTAGES of the centre cell's screen rect, not in pixels: one container
 * is written per frame and the forty children inside it then need no per-frame
 * work at all (accessibility-plan.md §3.3). `bookScreenRects` is the same
 * numbers already scaled, for the canvas, which has no percentages.
 *
 * That the fractions are per-axis is load-bearing here for the same reason it
 * is in `render.js`: `x`/`w` are against the cell's width and `y`/`h` against
 * its height, and one divisor for both axes would put the focus ring on the
 * wrong book.
 */
export const BOOK_RECTS = BOOKS;

/** How many searches the history queue can show at once - the whole wall. */
export const HISTORY_SLOT_COUNT = BOOK_COUNT;

/**
 * The wall's books grouped by SHELF, as flat-index bands.
 *
 * Rows, not runs: a shelf broken into more than one run by art is still one
 * row to a reader moving up and down it, and the gap between two runs is not
 * somewhere the keyboard should stop. Runs exist for the hit-test, where a
 * point really can land in the gap; rows exist for the arrow keys, which move
 * between books and never between the spaces around them.
 */
const ROWS = (() => {
  let flat = 0;
  return GEOMETRY.shelves.map((s) => {
    const row = { start: flat, count: s.books.length };
    flat += row.count;
    return row;
  });
})();

// Per-run bands, in fractions: a run is a CONTIGUOUS group of books on one
// shelf, and a shelf may hold more than one - the trace is free to leave a gap
// wider than a book for art occupying part of the shelf (the open "Index of
// Babel" book on the middle shelf, say), and that gap must not resolve to a
// phantom book. A gap no wider than a book is still just the thin margin
// between two spines, and
// the hit-test floors a point into the run's columns so a click there still
// resolves to a book - the same "addressed by a pitch" discipline
// `picking.js` uses for cells. Runs, not shelves, are what the hit-test walks.
const RUNS = (() => {
  const runs = [];
  let flat = 0;
  for (const s of GEOMETRY.shelves) {
    let run = null;
    for (const b of s.books) {
      if (run && b.x - run.x1 > b.w) run = null;
      if (!run) {
        run = { start: flat, books: [] };
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

/**
 * The centre cell's on-screen rectangle, for a given camera.
 *
 * The cell is addressed by its lower corner and spans one unit, so it runs from
 * world (0, 0) to (1, 1); its screen position is `worldToScreen(0, 0)` and its
 * size is one cell in each axis.
 *
 * @param {{x:number,y:number,zoom:number,aspect?:number}} cam
 * @param {{width:number,height:number}} canvasRect
 */
export function centreCellRect(cam, canvasRect) {
  const tl = worldToScreen(0, 0, cam, canvasRect);
  const per = pxPerCell(cam);
  return { x: tl.x, y: tl.y, w: per.x, h: per.y };
}

/**
 * Whether a screen rect overlaps the viewport at all.
 *
 * The centre cell is one cell of an infinite map, so at most zooms it is
 * nowhere near the screen. Both overlays it carries - the live search field
 * and the book buttons - are mounted permanently and shown only while it is,
 * so this is the half of "usable" that is about WHERE the cell is rather than
 * how big it is.
 */
export function overlapsViewport(rect, width, height) {
  return rect.x + rect.w > 0 && rect.x < width && rect.y + rect.h > 0 && rect.y < height;
}

/**
 * Whether the spines are wide enough on screen to carry a title.
 *
 * One statement of the zoom gate, read by the compositing below AND by the DOM
 * overlay in `main.jsx`: the buttons exist exactly while the titles do, so a
 * reader tabbing into the shelf is reaching books they can also see named.
 */
export function areSpinesLegible(cellRect) {
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
 * @param {number} from flat slot id
 * @param {{dx?: number, dy?: number}} dir one step, as the keyboard handler has it
 * @param {Array<{text?:string}|null>} slots `assignTitles` output
 */
export function bookNeighbour(from, { dx = 0, dy = 0 }, slots) {
  const titled = (i) => i >= 0 && i < BOOK_COUNT && Boolean(slots?.[i]?.text);

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

/** Every book rect in screen pixels, scaled onto a centre-cell rect. */
export function bookScreenRects(cellRect) {
  return BOOKS.map((b) => ({
    x: cellRect.x + b.x * cellRect.w,
    y: cellRect.y + b.y * cellRect.h,
    w: b.w * cellRect.w,
    h: b.h * cellRect.h,
  }));
}

/** The live search field's rect in screen pixels, scaled onto a centre-cell rect. */
export function searchBoxScreenRect(cellRect) {
  const b = CENTRE_SEARCH_RECT;
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
export function isSearchBoxUsable(cellRect) {
  return searchBoxScreenRect(cellRect).h >= MIN_SEARCH_BOX_PX;
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
export function searchBoxAtPoint(px, py, cellRect) {
  if (!isSearchBoxUsable(cellRect)) return false;
  const b = searchBoxScreenRect(cellRect);
  return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
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
export function bookAtPoint(px, py, cellRect) {
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
 * to search; an `override` book carries an `action` to dispatch.
 *
 * @param {{history?:string[], tags?:string[], overrides?:Record<number,{text:string,action:string}>}} opts
 * @returns {Array<{kind:string,text:string,term?:string,action?:string}|null>}
 */
export function assignTitles({ history = [], tags = [], overrides = {} } = {}) {
  const slots = new Array(BOOK_COUNT).fill(null);

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

  return slots;
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
export function describeBook(slot) {
  if (!slot?.text) return '';
  if (slot.kind === 'history') return `${slot.text} - repeat this search`;
  if (slot.kind === 'override') return slot.text;
  return `${slot.text} - search the library for this`;
}

/**
 * A stable random selection of keyword texts from the corpus, enough to letter
 * the whole wall.
 *
 * "Random" but reproducible: seeded, so the wall does not reshuffle on every
 * render. Deduped, because the same keyword on many rooms is one tag. Bounded at
 * the book count; `assignTitles` cycles a shorter pool to fill the rest.
 *
 * @param {Array<{keywords?:{text:string}[]}|null>|null} metadata indexed by room id
 * @param {number} seed
 */
export function pickTags(metadata, seed = 1) {
  if (!metadata) return [];
  const texts = new Set();
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
 * Composite the titles onto the centre tile's books.
 *
 * ZOOM-GATED: a spine narrower than MIN_SPINE_PX carries no legible text, so it
 * carries none at all rather than a smear of sub-pixels. This is the "faithful
 * zoom-in reward" - a title is only readable once the reader has zoomed into
 * the centre, which the map now opens having done.
 *
 * Each title reads TOP-TO-BOTTOM down the spine, the way a shelved book is
 * printed, truncated to the spine's length with an ellipsis, over a dark halo so
 * gilt reads on any spine tone. Draws nothing for an `empty` book.
 */
export function composeSpines(ctx, cellRect, slots) {
  if (!areSpinesLegible(cellRect)) return;
  const rects = bookScreenRects(cellRect);

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < rects.length; i++) {
    const slot = slots[i];
    if (!slot || !slot.text) continue;
    const r = rects[i];
    const fontPx = Math.max(6, Math.min(13, Math.floor(r.w * 0.82)));
    ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`;

    ctx.save();
    // Turn so the text runs DOWN the spine, as titles are printed and as books
    // are shelved: origin at the spine's head, a quarter-turn clockwise so +x
    // now points down the book.
    ctx.translate(r.x + r.w / 2, r.y);
    ctx.rotate(Math.PI / 2);
    const inset = Math.min(4, r.h * 0.1);
    const text = fitText(ctx, slot.text, r.h - inset * 2);

    ctx.lineWidth = Math.max(1.5, fontPx / 5);
    ctx.strokeStyle = HALO;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, inset, 0);
    ctx.fillStyle = INK;
    ctx.fillText(text, inset, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** Shorten `text` with an ellipsis until it fits `maxWidth` at the current font. */
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}
