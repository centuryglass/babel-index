import { STORY } from './story.js';

/**
 * Layout of one gallery tile.
 *
 * PROJECTION
 * ----------
 * The tile is an *unrolled elevation* of a single hexagonal gallery: the six
 * sides are cut open and laid flat, left to right, in this order:
 *
 *     [ hallway/2 ][ shelves ][ shelves ][ shaft ][ shelves ][ shelves ][ hallway/2 ]
 *
 * The two free sides are taken to be opposite each other (the story does not
 * say; opposite is the reading that keeps the tile symmetric). The hallway is
 * the side that gets cut, so it appears split across the left and right tile
 * edges, and the air shaft sits at the centre. Four shelved sides remain, which
 * is exactly what the story specifies.
 *
 * SEAM CONTRACT
 * -------------
 * Any room must abut any other room in all four directions with no visible
 * join. That is guaranteed structurally rather than by eye:
 *
 *   - A "straddle" band is authored once at double width in its own local
 *     coordinate space, then drawn twice on the tile, halves swapped: local
 *     x in [seam, 2*seam] is painted at tile x in [0, seam], and local
 *     x in [0, seam] is painted at tile x in [W-seam, W]. Where two tiles meet,
 *     the two halves reassemble into the single band the artist drew, so
 *     continuity is automatic for *any* content.
 *   - The horizontal (hallway) band and the vertical (floor/ceiling slab) band
 *     each work this way, on their own axis.
 *   - The four corners, where the bands would overlap, are a flat constant
 *     fill. That removes the only case the straddle rule cannot resolve on its
 *     own.
 *
 * Consequence: every variant room - however wildly restyled - only has to keep
 * the band regions byte-identical to the base room to remain tileable. That
 * region is emitted as `seam-mask.png` for use as an inpainting/ControlNet mask.
 */

/** Layout fractions, expressed over /128 so common sizes land on integers. */
const F = {
  seam: 11 / 128, //  88 @1024 - half the hallway width, and the slab thickness
  shaftHalf: 9 / 128, //  72 @1024 - half the air shaft width
  caseTop: 21 / 128, // 168 @1024 - top of the bookcases / ceiling line
  floorLine: 109 / 128, // 872 @1024 - floor surface
  pier: 1 / 16, // upright thickness, as a fraction of one bay's width
  board: 1 / 18, // shelf board thickness, as a fraction of one shelf's height
  railHeight: 7 / 128, // "very low railings" around the air shaft
  lampRadius: 13 / 512,
};

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * @param {{width?: number, height?: number}} opts
 * @returns {object} every rectangle the renderers and the web app need
 */
export function layout({ width = 1024, height = width } = {}) {
  const W = width;
  const H = height;

  const seamX = round(W * F.seam);
  const seamY = round(H * F.seam);
  const caseTop = round(H * F.caseTop);
  const floorLine = round(H * F.floorLine);
  const shaftHalf = round(W * F.shaftHalf);
  const shaftL = round(W / 2 - shaftHalf);
  const shaftR = round(W / 2 + shaftHalf);

  // Two shelf regions, one either side of the shaft, two bays each.
  const regions = [
    { x0: seamX, x1: shaftL },
    { x0: shaftR, x1: W - seamX },
  ];
  const baysPerRegion = STORY.shelvedSides / regions.length; // 2
  const bayW = round((regions[0].x1 - regions[0].x0) / baysPerRegion);

  const caseH = floorLine - caseTop;
  const shelfH = caseH / STORY.shelvesPerSide;
  const boardH = round(shelfH * F.board);
  const pierW = round(bayW * F.pier);

  const bays = [];
  for (const region of regions) {
    for (let i = 0; i < baysPerRegion; i++) {
      const x = round(region.x0 + i * bayW);
      const inner = { x: round(x + pierW), w: round(bayW - 2 * pierW) };
      const slotW = inner.w / STORY.booksPerShelf;

      const shelves = [];
      for (let s = 0; s < STORY.shelvesPerSide; s++) {
        // Shelf 0 is the topmost. The board sits at the bottom of each bay.
        const top = round(caseTop + s * shelfH);
        const clearH = round(shelfH - boardH);
        const slots = [];
        for (let b = 0; b < STORY.booksPerShelf; b++) {
          slots.push({
            index: b,
            x: round(inner.x + b * slotW),
            y: top,
            w: round(slotW),
            h: clearH,
          });
        }
        shelves.push({
          index: s,
          x: inner.x,
          y: top,
          w: inner.w,
          h: round(shelfH),
          board: { x, y: round(top + clearH), w: bayW, h: boardH },
          clearH,
          slots,
        });
      }

      bays.push({
        index: bays.length,
        x,
        y: caseTop,
        w: bayW,
        h: round(caseH),
        pierW,
        shelves,
      });
    }
  }

  // Air shaft: a void running the full height of the tile at its centre.
  const railH = round(H * F.railHeight);
  const shaft = {
    x: shaftL,
    y: 0,
    w: round(shaftR - shaftL),
    h: H,
    rail: {
      x: shaftL,
      y: round(floorLine - railH),
      w: round(shaftR - shaftL),
      h: railH,
    },
  };

  // "two, transversally placed" - across the gallery, hung below the ceiling.
  const lampR = round(Math.min(W, H) * F.lampRadius);
  const lamps = [
    { cx: round(W * 0.25), cy: round(caseTop * 0.75), r: lampR },
    { cx: round(W * 0.75), cy: round(caseTop * 0.75), r: lampR },
  ];

  return {
    width: W,
    height: H,
    seamX,
    seamY,
    caseTop,
    floorLine,
    bays,
    shaft,
    lamps,
    corridor: corridorLayout({ W, H, seamX, seamY, caseTop, floorLine }),
    slab: slabLayout({ W, H, seamX, seamY, shaftL, shaftR }),
    /** The four regions a variant room must not repaint. */
    seamRegions: [
      { name: 'left', x: 0, y: 0, w: seamX, h: H },
      { name: 'right', x: round(W - seamX), y: 0, w: seamX, h: H },
      { name: 'top', x: 0, y: 0, w: W, h: seamY },
      { name: 'bottom', x: 0, y: round(H - seamY), w: W, h: seamY },
    ],
    corners: [
      { x: 0, y: 0, w: seamX, h: seamY },
      { x: round(W - seamX), y: 0, w: seamX, h: seamY },
      { x: 0, y: round(H - seamY), w: seamX, h: seamY },
      { x: round(W - seamX), y: round(H - seamY), w: seamX, h: seamY },
    ],
    /**
     * Where the two straddle bands are instantiated. `src` is the rect in the
     * band's own local space; `dst` is where it lands on the tile.
     */
    placements: {
      corridorRight: {
        src: { x: 0, y: seamY, w: seamX, h: round(H - 2 * seamY) },
        dst: { x: round(W - seamX), y: seamY, w: seamX, h: round(H - 2 * seamY) },
      },
      corridorLeft: {
        src: { x: seamX, y: seamY, w: seamX, h: round(H - 2 * seamY) },
        dst: { x: 0, y: seamY, w: seamX, h: round(H - 2 * seamY) },
      },
      slabBottom: {
        src: { x: seamX, y: 0, w: round(W - 2 * seamX), h: seamY },
        dst: { x: seamX, y: round(H - seamY), w: round(W - 2 * seamX), h: seamY },
      },
      slabTop: {
        src: { x: seamX, y: seamY, w: round(W - 2 * seamX), h: seamY },
        dst: { x: seamX, y: 0, w: round(W - 2 * seamX), h: seamY },
      },
    },
  };
}

/**
 * The hallway, authored across the full 2*seamX width it occupies when two
 * tiles meet. Local origin is the left edge of the *assembled* corridor, so
 * local x = seamX is exactly the tile boundary.
 */
function corridorLayout({ W, H, seamX, seamY, caseTop, floorLine }) {
  const w = round(seamX * 2);
  const jamb = round(w * 0.09);
  const aperture = {
    x: jamb,
    y: caseTop,
    w: round(w - 2 * jamb),
    h: round(floorLine - caseTop),
  };
  const closetW = round(aperture.w * 0.17);
  const closetH = round(aperture.h * 0.62);
  return {
    width: w,
    height: H,
    /** Content is clipped to this band; above and below it the corners rule. */
    liveY: { y: seamY, h: round(H - 2 * seamY) },
    aperture,
    /** "which opens onto another gallery, identical to the first" */
    farGallery: {
      x: round(aperture.x + aperture.w * 0.36),
      y: round(aperture.y + aperture.h * 0.24),
      w: round(aperture.w * 0.28),
      h: round(aperture.h * 0.62),
    },
    /** "To the left and right of the hallway there are two very small closets." */
    closets: [
      {
        side: 'left',
        x: round(aperture.x + aperture.w * 0.03),
        y: round(aperture.y + aperture.h * 0.3),
        w: closetW,
        h: closetH,
      },
      {
        side: 'right',
        x: round(aperture.x + aperture.w * (0.97 - 0.17)),
        y: round(aperture.y + aperture.h * 0.3),
        w: closetW,
        h: closetH,
      },
    ],
    /** "In the hallway there is a mirror which faithfully duplicates all appearances." */
    mirror: {
      x: round(aperture.x + aperture.w * 0.235),
      y: round(aperture.y + aperture.h * 0.22),
      w: round(aperture.w * 0.1),
      h: round(aperture.h * 0.5),
    },
    /** "a spiral stairway, which sinks abysmally and soars upwards" */
    stair: {
      cx: round(aperture.x + aperture.w * 0.68),
      x: round(aperture.x + aperture.w * 0.56),
      w: round(aperture.w * 0.24),
      y: seamY,
      h: round(H - 2 * seamY),
      treads: 26,
    },
    floorLine,
    caseTop,
  };
}

/**
 * The floor/ceiling slab, authored across the full 2*seamY it occupies when two
 * tiles stack. Local y in [0, seamY] is the floor seen at the bottom of a tile;
 * local y in [seamY, 2*seamY] is the ceiling seen at the top of the tile below.
 */
function slabLayout({ W, H, seamX, seamY, shaftL, shaftR }) {
  return {
    width: W,
    height: round(seamY * 2),
    liveX: { x: seamX, w: round(W - 2 * seamX) },
    /** The shaft punches straight through the slab. */
    shaftOpening: { x: shaftL, y: 0, w: round(shaftR - shaftL), h: round(seamY * 2) },
    /** Stair wells sit in the corridor band, i.e. outside liveX; see corners. */
    floorHalf: { y: 0, h: seamY },
    ceilingHalf: { y: seamY, h: seamY },
  };
}

export { F as LAYOUT_FRACTIONS };
