import { MEASURED } from './measured.ts';

/**
 * Layout of one center tile, as pixels for a tile of a given size. The center
 * is the only tile traced exactly (docs/agents/map.md, "Tile geometry"); a
 * corpus room needs only a bounding box.
 *
 * Two kinds of number come out of `layout()`:
 *
 *   Measured - the opening, the search box, every control hit region and every
 *   book rect. These come from `measured.ts`: traced off the render in
 *   Inkscape, imported by `import-shelf-svg.ts`, and exact. The hit-tests and
 *   the composited spines run on them.
 *
 *   Provisional - the side returns, the ceiling strip and the cornice
 *   (`PROVISIONAL`). Nothing is traced for them, so they are eyeballed
 *   fractions, and only the placeholder's own drawing reads them. A hit-test
 *   that came to depend on one would be testing an untraced guess.
 *
 * `SHELF_COUNT` and `BOOK_COUNT` in `measured.ts` are a legibility choice - how
 * many spines the wall can carry - not the novel's 5 shelves of 32 books.
 */

const PROVISIONAL = {
  sideReturn: 0.085,
  ceiling: 0.055,
};

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Scale a `CenterBook.d` string onto a tile of size `W x H`.
 *
 * A blind regex over `x,y` pairs is enough because `normalizePath` and
 * `ellipseToPath` leave only absolute M/L/C/Z behind, every number one half of
 * such a pair and Z carrying no numbers at all. Change that grammar and this
 * scales silently wrong.
 */
const scalePathData = (d: string, W: number, H: number) =>
  d.replace(/(-?\d*\.?\d+),(-?\d*\.?\d+)/g, (_, x, y) => `${round(Number(x) * W)},${round(Number(y) * H)}`);

/**
 * The traced tile's height over its width. `layout()` defaults its height to
 * this, so a caller giving only a width gets the shape the numbers were
 * measured at: on any other aspect every rect is stretched onto art it no
 * longer matches, silently, because each rect is still inside the tile.
 *
 * The trace and `BASE_TILE` are two statements of one fact, and
 * `geometry.test.ts` asserts they agree.
 */
export const TILE_ASPECT = MEASURED.tile.aspect;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Book extends Rect {
  index: number;
}

export interface Shelf {
  index: number;
  books: Book[];
}

export interface SideReturn {
  side: 'left' | 'right';
  outer: { x: number; top: number; bottom: number };
  inner: { x: number; top: number; bottom: number };
}

/** A traced silhouette scaled onto this tile - see `measured.ts`'s `CenterBook`. */
export interface CenterBook {
  d: string;
  bbox: Rect;
}

export interface TileLayout {
  width: number;
  height: number;
  measured: true;
  opening: Rect;
  /**
   * One field per traced element, scaled to this tile, and null when the trace
   * carried none. What each is for is `import-shelf-svg.ts`'s label table.
   * `searchBox` is the one the trace must carry: the importer reports a trace
   * without it, and `layout()`'s `!` throws at load if it is ever missing.
   */
  searchBox: Rect;
  mineToggle: Rect | null;
  countToggle: Rect | null;
  shuffleButton: Rect | null;
  centerBook: CenterBook | null;
  distillOff: CenterBook | null;
  distillOn: CenterBook | null;
  favoriteToggle: CenterBook | null;
  shelves: Shelf[];
  floorLine: number;
  sideReturn: number;
  sideReturns: SideReturn[];
  ceiling: Rect;
  cornice: Rect;
  floor: Rect;
}

/** Scales the measured fractions onto a tile of the given size. */
export function layout({ width = 1024, height = Math.round(width * TILE_ASPECT) } = {}): TileLayout {
  const W = width;
  const H = height;
  // One divisor per axis, and that is load-bearing: the measured fractions
  // carry no aspect, so a single divisor for both axes stretches every rect
  // onto a shape the trace never had (docs/agents/map.md, "The fractions are
  // per-axis").
  const r = ([x, y, w, h]: [number, number, number, number]): Rect => ({
    x: round(x * W),
    y: round(y * H),
    w: round(w * W),
    h: round(h * H),
  });

  const opening = r(MEASURED.opening);
  const searchBox = r(MEASURED.searchBox!);
  const mineToggle = MEASURED.mineToggle ? r(MEASURED.mineToggle) : null;
  const countToggle = MEASURED.countToggle ? r(MEASURED.countToggle) : null;
  const shuffleButton = MEASURED.shuffleButton ? r(MEASURED.shuffleButton) : null;
  const centerBook: CenterBook | null = MEASURED.centerBook
    ? { d: scalePathData(MEASURED.centerBook.d, W, H), bbox: r(MEASURED.centerBook.bbox) }
    : null;
  const distillOff: CenterBook | null = MEASURED.distillOff
    ? { d: scalePathData(MEASURED.distillOff.d, W, H), bbox: r(MEASURED.distillOff.bbox) }
    : null;
  const distillOn: CenterBook | null = MEASURED.distillOn
    ? { d: scalePathData(MEASURED.distillOn.d, W, H), bbox: r(MEASURED.distillOn.bbox) }
    : null;
  const favoriteToggle: CenterBook | null = MEASURED.favoriteToggle
    ? { d: scalePathData(MEASURED.favoriteToggle.d, W, H), bbox: r(MEASURED.favoriteToggle.bbox) }
    : null;

  const shelves: Shelf[] = MEASURED.shelves.map((s, index) => ({
    index,
    books: s.books.map((b, i) => ({ index: i, ...r(b) })),
  }));

  const sideReturn = round(W * PROVISIONAL.sideReturn);
  const ceilingH = round(H * PROVISIONAL.ceiling);
  const floorLine = round(opening.y + opening.h);

  return {
    width: W,
    height: H,
    measured: true,
    opening,
    searchBox,
    mineToggle,
    countToggle,
    shuffleButton,
    centerBook,
    distillOff,
    distillOn,
    favoriteToggle,
    shelves,
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
      h: round(opening.y - ceilingH),
    },
    floor: { x: 0, y: floorLine, w: W, h: round(H - floorLine) },
  };
}

export { PROVISIONAL as PROVISIONAL_FRACTIONS };
