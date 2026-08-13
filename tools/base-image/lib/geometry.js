import { STORY } from './story.js';
import { MEASURED, SHELF_COUNT, BOOKS_PER_SHELF } from './measured.js';

/**
 * Layout of one tile.
 *
 * A tile is ONE SHELVED WALL of a gallery, seen in shallow one-point
 * perspective - not a whole room. Four tiles are the shelved sides of one
 * gallery.
 *
 *   one tile = 5 shelves x 32 books = 160 books
 *   4 tiles  = one gallery          = 640 books
 *
 * TWO CLASSES OF NUMBER LIVE HERE, and the difference matters:
 *
 *   MEASURED - the opening, the case uprights, all five shelf boards, all 160
 *   book rectangles and the lamp come from measured.js, traced off the Blender
 *   render in Inkscape and imported by import-shelf-svg.mjs. These are exact.
 *
 *   PROVISIONAL - the side returns, the ceiling strip and the cornice were not
 *   traced, so they are still eyeballed fractions. They only affect the
 *   placeholder's looks, never hit-testing, so they can stay approximate until
 *   there is a reason for them not to be.
 *
 * TILING needs no machinery: every variant is inpainted from the same base with
 * an edge-clear mask, so the frame is shared by construction.
 */

/** Not traced; affects the placeholder's appearance only. */
const PROVISIONAL = {
  sideReturn: 0.085,
  ceiling: 0.055,
  lampGlow: 4.2, // glow radius, as a multiple of the measured globe radius
};

const round = (n) => Math.round(n * 1e4) / 1e4;

/**
 * The tile's shape, from the trace itself.
 *
 * `height` defaults to this rather than to `width`. It used to default to a
 * square, which is silent and wrong the moment the tile is not one: every
 * measured rect gets stretched onto art it no longer matches, and each rect is
 * individually still inside the tile, so nothing complains. Defaulting to the
 * traced aspect means a caller that gives only a width gets the shape the
 * numbers were measured at, which is the only shape they mean anything at.
 *
 * The trace and `BASE_TILE` are two statements of one fact and geometry.test.mjs
 * asserts they agree, so this is the tile's aspect however you reach it.
 */
export const TILE_ASPECT = MEASURED.tile.aspect;

/**
 * @param {{width?: number, height?: number}} opts
 * @returns {object} every rectangle the renderer and the web app need
 */
export function layout({ width = 1024, height = Math.round(width * TILE_ASPECT) } = {}) {
  const W = width;
  const H = height;
  // Rects carry no aspect of their own - the importer normalised x against the
  // traced width and y against the traced height separately - so each axis
  // scales by its own edge and a tile of any shape comes out right.
  const r = ([x, y, w, h]) => ({ x: round(x * W), y: round(y * H), w: round(w * W), h: round(h * H) });

  const opening = r(MEASURED.opening);
  const uprights = MEASURED.uprights.map(r);

  // THE LAMP IS A CIRCLE AND STAYS ONE. It is the one thing here deliberately
  // not stretched with the tile: a single scalar radius scaled by WIDTH on both
  // axes, never an rx/ry pair. A globe that turned into an ellipse because the
  // wall got wider would read as a mistake rather than as a wider wall.
  //
  // The importer normalises its radius against width alone, so this round-trips
  // the traced circle exactly as long as the trace and the tile agree on aspect
  // - which they must, and which geometry.test.mjs asserts.
  const lamp = {
    cx: round(MEASURED.lamp.cx * W),
    cy: round(MEASURED.lamp.cy * H),
    r: round(MEASURED.lamp.r * W),
    glow: round(MEASURED.lamp.r * W * PROVISIONAL.lampGlow),
  };

  const shelves = MEASURED.shelves.map((s, index) => {
    const board = r(s.board);
    const books = s.books.map((b, i) => ({ index: i, ...r(b) }));
    return {
      index,
      board,
      books,
      /** The clear space a book stands in, for hit-testing a whole slot. */
      rect: {
        x: opening.x,
        y: books.length ? Math.min(...books.map((b) => b.y)) : board.y,
        w: opening.w,
        h: books.length ? round(board.y - Math.min(...books.map((b) => b.y))) : 0,
      },
    };
  });

  const caseFrame = uprights.length
    ? {
        x: uprights[0].x,
        y: uprights[0].y,
        w: round(uprights[uprights.length - 1].x + uprights[uprights.length - 1].w - uprights[0].x),
        h: uprights[0].h,
      }
    : opening;

  const sideReturn = round(W * PROVISIONAL.sideReturn);
  const ceilingH = round(H * PROVISIONAL.ceiling);
  const floorLine = round(caseFrame.y + caseFrame.h);

  return {
    width: W,
    height: H,
    measured: true,
    opening,
    uprights,
    caseFrame,
    shelves,
    lamp,
    floorLine,
    sideReturn,
    // Provisional frame elements.
    sideReturns: [
      {
        side: 'left',
        outer: { x: 0, top: 0, bottom: H },
        inner: { x: sideReturn, top: ceilingH, bottom: floorLine },
      },
      {
        side: 'right',
        outer: { x: W, top: 0, bottom: H },
        inner: { x: round(W - sideReturn), top: ceilingH, bottom: floorLine },
      },
    ],
    ceiling: { x: 0, y: 0, w: W, h: ceilingH },
    cornice: {
      x: sideReturn,
      y: ceilingH,
      w: round(W - 2 * sideReturn),
      h: round(caseFrame.y - ceilingH),
    },
    floor: { x: 0, y: floorLine, w: W, h: round(H - floorLine) },
  };
}

/**
 * The measured tile disagrees with the story only where the story is silent.
 * Fail loudly if a re-trace ever breaks a number the story does state.
 */
export function checkAgainstStory() {
  const problems = [];
  if (SHELF_COUNT !== STORY.shelvesPerSide)
    problems.push(`traced ${SHELF_COUNT} shelves, story says ${STORY.shelvesPerSide}`);
  if (BOOKS_PER_SHELF !== STORY.booksPerShelf)
    problems.push(`traced ${BOOKS_PER_SHELF} books per shelf, story says ${STORY.booksPerShelf}`);
  return problems;
}

export { PROVISIONAL as PROVISIONAL_FRACTIONS };
