/**
 * The centre room's interactive book spines - the first piece of phase 5.
 *
 * Cell (0, 0) is the one room whose art we control, so it is the one room where
 * per-book hit-testing is meaningful (inpainting does not preserve shelf counts,
 * so no corpus room can be addressed book by book). Every book on all five
 * shelves - 160 of them - carries a composited title, and clicking a book runs
 * that title as a search.
 *
 * Two roles share the wall:
 *
 *   - SEARCH HISTORY lives on the one `historySpines` shelf (shelf 1). Every
 *     search projects onto its frontmost book, newest first, and clicking a book
 *     repeats its search.
 *   - Every OTHER book shows a random corpus keyword. Confining history to one
 *     shelf keeps it legible as history while the rest of the wall becomes a
 *     browsable index - a much larger pool of keywords to stumble on, and a wall
 *     with text on every book rather than one lettered shelf among five blank.
 *
 * This is the pure half, split out like `picking.js`: the part with a right
 * answer, assertable without a browser. It owns the book geometry, the title
 * assignment, the hit-test and the compositing; the hook decides WHEN a tap
 * happened and `main.jsx` owns the history state.
 *
 * The geometry comes from the SINGLE SOURCE - `tools/base-image/lib/geometry.js`,
 * the same pure module the manifest is generated from. `layout({ width: 1,
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

/**
 * Which shelf the history lives on. Ties to `uiAnchors.historySpines` in the
 * generated `tile-geometry.json` (`{ shelf: 1, books: 'all' }`); there is no
 * shared JS constant for the anchors, and the manifest is generated from this
 * same lib, so this restates the one number rather than importing it.
 */
export const HISTORY_SHELF = 1;

const GEOMETRY = layout({ width: 1, height: 1 });

/**
 * Every book on the tile, flat and shelf-major, as `{shelf, x, y, w, h}`
 * fractions. A book's index in this array is its slot id everywhere below - in
 * the assignment, the hit-test and the overrides - so there is one address for a
 * book, not a (shelf, index) pair to keep in step.
 */
const BOOKS = GEOMETRY.shelves.flatMap((s) =>
  s.books.map(({ x, y, w, h }) => ({ shelf: s.index, x, y, w, h }))
);

/** How many books the wall has in total (5 x 32 = 160). */
export const BOOK_COUNT = BOOKS.length;

/** The flat slot ids that fall on the history shelf, in shelf order. */
const HISTORY_SLOTS = BOOKS.reduce((acc, b, i) => {
  if (b.shelf === HISTORY_SHELF) acc.push(i);
  return acc;
}, []);

/** How many searches the history shelf can show at once. */
export const HISTORY_SLOT_COUNT = HISTORY_SLOTS.length;

// Per-shelf band, in fractions: the rectangle each shelf's books occupy as a
// whole, plus the flat index its first book sits at. The hit-test floors a point
// into that shelf's columns rather than testing each spine, so a click in the
// thin gap between two spines resolves to a book - the same "addressed by a
// pitch" discipline `picking.js` uses for cells.
const SHELF_BANDS = (() => {
  let start = 0;
  return GEOMETRY.shelves.map((s) => {
    const bks = s.books;
    const band = {
      start,
      count: bks.length,
      x0: bks[0].x,
      x1: bks[bks.length - 1].x + bks[bks.length - 1].w,
      y0: Math.min(...bks.map((b) => b.y)),
      y1: Math.max(...bks.map((b) => b.y + b.h)),
    };
    start += bks.length;
    return band;
  });
})();

// --- rendering constants, by feel ------------------------------------------
// These are art numbers, like `PROVISIONAL` in geometry.js or the chrome
// thresholds in render.js - not config, because nothing derives from them and
// no test pins their value.

/** Below this on-screen spine width, a title is sub-pixel; do not draw it. */
const MIN_SPINE_PX = 5;
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

/** All 160 book rects in screen pixels, scaled onto a centre-cell rect. */
export function bookScreenRects(cellRect) {
  return BOOKS.map((b) => ({
    x: cellRect.x + b.x * cellRect.w,
    y: cellRect.y + b.y * cellRect.h,
    w: b.w * cellRect.w,
    h: b.h * cellRect.h,
  }));
}

/**
 * Which book is under a screen point, or null.
 *
 * Finds the shelf whose row band holds the point, then floors into that shelf's
 * columns, so a click in the gap between two spines resolves to a book. Returns
 * null when the point is on no shelf's books.
 */
export function bookAtPoint(px, py, cellRect) {
  for (const band of SHELF_BANDS) {
    const y0 = cellRect.y + band.y0 * cellRect.h;
    const y1 = cellRect.y + band.y1 * cellRect.h;
    if (py < y0 || py >= y1) continue;
    const x0 = cellRect.x + band.x0 * cellRect.w;
    const x1 = cellRect.x + band.x1 * cellRect.w;
    if (px < x0 || px >= x1) return null;
    const local = Math.floor(((px - x0) / (x1 - x0)) * band.count);
    return band.start + Math.max(0, Math.min(band.count - 1, local));
  }
  return null;
}

/**
 * Lay out what each of the 160 books shows.
 *
 * Three sources, in strict precedence:
 *
 *   1. OVERRIDES - reserved books with a distinct function (a future artist's
 *      statement, say). Keyed by flat book id, placed first, and never
 *      overwritten. This is the seam the concept asks for; it ships empty.
 *   2. HISTORY - past searches, newest first, into the history shelf's books
 *      only. So the most recent search is the frontmost book of that shelf, and
 *      the rest of the wall is free for keywords.
 *   3. TAGS - a random selection of corpus keywords, filling every other book
 *      (and any history-shelf book history has not reached). Cycled if the pool
 *      is smaller than the wall, so every book carries a title rather than
 *      leaving blanks - repeats only show up on the tiny sample corpus.
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
  for (const i of HISTORY_SLOTS) {
    if (hi >= history.length) break;
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
 * zoom-in reward" - the wall holds Borges' 160 books, so a title is only
 * readable once the reader has zoomed into the centre, which the map now opens
 * having done.
 *
 * Each title reads TOP-TO-BOTTOM down the spine, the way a shelved book is
 * printed, truncated to the spine's length with an ellipsis, over a dark halo so
 * gilt reads on any spine tone. Draws nothing for an `empty` book.
 */
export function composeSpines(ctx, cellRect, slots) {
  const rects = bookScreenRects(cellRect);
  if (rects.length === 0 || rects[0].w < MIN_SPINE_PX) return;

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
