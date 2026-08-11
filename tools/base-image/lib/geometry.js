import { STORY } from './story.js';

/**
 * Layout of one tile.
 *
 * A tile is ONE SHELVED WALL of a gallery, seen in shallow one-point
 * perspective - not a whole room. Faithful 3D reconstructions of the Library
 * already exist and this is not one; the tile is a repeating unit that happens
 * to be built to Borges' numbers.
 *
 *   one tile = one shelved side = 5 shelves x 32 books = 160 books
 *   four tiles = the shelved sides of one gallery = 640 books
 *
 * TILING
 * ------
 * Tiling needs no special machinery. Every variant is inpainted from the same
 * base render with a mask that stays clear of the edges, so the frame - the
 * side returns, the ceiling strip, the floor - is common to every room by
 * construction. Adjacent tiles meet on identical pixels because they are
 * literally the same pixels.
 *
 * These proportions are measured off the Blender base render and are
 * PROVISIONAL: they are a stand-in until the base render (or the .blend) is in
 * the repo, at which point the shelf and slot rectangles should be derived from
 * it rather than eyeballed. Nothing but the centre room needs them to be exact
 * - see docs/implementation-plan.md.
 */

/** Layout fractions of the tile edge. Provisional; see above. */
const F = {
  sideReturn: 0.085, // dark wall returning toward the viewer, left and right
  ceiling: 0.055, // ceiling strip above the cornice
  corniceBottom: 0.205, // underside of the entablature; top of the case
  caseLeft: 0.16,
  caseRight: 0.84,
  floorLine: 0.88, // where the case meets the floor
  frame: 0.018, // case frame thickness
  board: 1 / 9, // shelf board thickness, as a fraction of shelf height
  lampY: 0.161,
  lampR: 0.048,
};

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * @param {{width?: number, height?: number}} opts
 * @returns {object} every rectangle the renderer and the web app need
 */
export function layout({ width = 1024, height = width } = {}) {
  const W = width;
  const H = height;
  const px = (f, axis = W) => round(f * axis);

  const sideReturn = px(F.sideReturn);
  const ceilingH = px(F.ceiling, H);
  const caseTop = px(F.corniceBottom, H);
  const floorLine = px(F.floorLine, H);
  const caseL = px(F.caseLeft);
  const caseR = px(F.caseRight);
  const frame = px(F.frame);

  // The bookcase opening: inside the frame.
  const opening = {
    x: round(caseL + frame),
    y: round(caseTop + frame),
    w: round(caseR - caseL - 2 * frame),
    h: round(floorLine - caseTop - frame),
  };

  const shelfH = opening.h / STORY.shelvesPerSide;
  const boardH = round(shelfH * F.board);
  const slotW = opening.w / STORY.booksPerShelf;

  const shelves = [];
  for (let s = 0; s < STORY.shelvesPerSide; s++) {
    const top = round(opening.y + s * shelfH);
    const clearH = round(shelfH - boardH);
    const slots = [];
    for (let b = 0; b < STORY.booksPerShelf; b++) {
      slots.push({
        index: b,
        x: round(opening.x + b * slotW),
        y: top,
        w: round(slotW),
        h: clearH,
      });
    }
    shelves.push({
      index: s,
      x: opening.x,
      y: top,
      w: opening.w,
      h: round(shelfH),
      clearH,
      board: { x: opening.x, y: round(top + clearH), w: opening.w, h: boardH },
      slots,
    });
  }

  return {
    width: W,
    height: H,
    /**
     * The two side walls, as trapezoids receding toward the vanishing point.
     * The outer edge is the tile edge; the inner edge is farther away.
     */
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
    cornice: { x: sideReturn, y: ceilingH, w: round(W - 2 * sideReturn), h: round(caseTop - ceilingH) },
    floor: { x: 0, y: floorLine, w: W, h: round(H - floorLine) },
    caseFrame: { x: caseL, y: caseTop, w: round(caseR - caseL), h: round(floorLine - caseTop) },
    opening,
    shelves,
    /** "two, transversally placed, in each hexagon" - one per shelved wall here. */
    lamp: { cx: round(W / 2), cy: px(F.lampY, H), r: px(F.lampR, H) },
    caseTop,
    floorLine,
    sideReturn,
  };
}

export { F as LAYOUT_FRACTIONS };
