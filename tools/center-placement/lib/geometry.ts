import { MEASURED } from './measured.ts';

/**
 * Layout of one tile.
 *
 * A tile is ONE SHELVED WALL of a gallery, seen in shallow one-point
 * perspective - not a whole room. Only the center tile (cell (0, 0)) is
 * traced exactly; every corpus room is inpainted and needs only a bounding
 * box, so this module's precision exists for the center alone.
 *
 * The center's own book count and shelf count are a UI choice - legible
 * search-history titles - not a restatement of Borges' 5 shelves x 32 books;
 * see docs/borges-parameters.md for the story's numbers, which this module no
 * longer tracks.
 *
 * TWO CLASSES OF NUMBER LIVE HERE, and the difference matters:
 *
 *   MEASURED - the opening, the search box and every book rectangle come from
 *   measured.ts, traced off the Blender render in Inkscape and imported by
 *   import-shelf-svg.mjs. These are exact. Shelf boards, case uprights and the
 *   lamp used to be traced too; they no longer are; only books and the search
 *   box are read from the SVG.
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
};

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Scale a `CenterBook.d` string onto a tile of size `W x H`.
 *
 * Every number in `import-shelf-svg.ts`'s canonical M/L/C/Z output is one
 * half of an `x,y` pair (H/V/S/Q/T were all normalised away on import, and Z
 * carries no numbers), so a blind regex over `x,y` pairs is enough - the same
 * shortcut every other rect in this module takes (`r()`, above), just applied
 * to path data instead of four numbers.
 */
const scalePathData = (d: string, W: number, H: number) =>
  d.replace(/(-?\d*\.?\d+),(-?\d*\.?\d+)/g, (_, x, y) => `${round(Number(x) * W)},${round(Number(y) * H)}`);

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

/** The open book's exact outline, scaled to a tile size - see measured.ts's `CenterBook`. */
export interface CenterBook {
  d: string;
  bbox: Rect;
}

export interface TileLayout {
  width: number;
  height: number;
  measured: true;
  opening: Rect;
  searchBox: Rect;
  /** hit region for the "sort by my favorites" switch - null if the trace has none */
  mineToggle: Rect | null;
  /** hit region for the "sort by most favorited" switch - null if the trace has none */
  countToggle: Rect | null;
  /** hit region for the reorder control - null if the trace has none */
  shuffleButton: Rect | null;
  /** the open book painted into a shelf gap - null if the trace has none */
  centerBook: CenterBook | null;
  /**
   * The on-tile favorite badge's traced silhouette, in the same per-axis
   * fraction space as every other rect here (see measured.ts) - null if the
   * trace has none.
   */
  favoriteToggle: CenterBook | null;
  shelves: Shelf[];
  floorLine: number;
  sideReturn: number;
  sideReturns: SideReturn[];
  ceiling: Rect;
  cornice: Rect;
  floor: Rect;
}

/** Every rectangle the renderer and the web app need. */
export function layout({ width = 1024, height = Math.round(width * TILE_ASPECT) } = {}): TileLayout {
  const W = width;
  const H = height;
  // Rects carry no aspect of their own - the importer normalised x against the
  // traced width and y against the traced height separately - so each axis
  // scales by its own edge and a tile of any shape comes out right.
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
  const favoriteToggle: CenterBook | null = MEASURED.favoriteToggle
    ? { d: scalePathData(MEASURED.favoriteToggle.d, W, H), bbox: r(MEASURED.favoriteToggle.bbox) }
    : null;

  const shelves: Shelf[] = MEASURED.shelves.map((s, index) => ({
    index,
    books: s.books.map((b, i) => ({ index: i, ...r(b) })),
  }));

  // No case uprights are traced any more, so the opening IS the case frame -
  // the bounding box of every book on the wall.
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
