/**
 * Pure geometry for the center-tile loading animation packer (index.ts).
 *
 * The loading indicator plays a short frame cycle over the illustrated page of
 * the center room's artist-statement book while a rearrangement is preparing
 * (packages/web/src/hooks/useRearrangement.ts). Each cycle ships as one packed
 * sprite sheet plus a crop rectangle saying where, on the center tile, those
 * frames belong.
 *
 * This file is the no-I/O half: bounding-box union, the sheet grid layout, and
 * the pixel->cell-fraction conversion. It reads nothing from disk, which is
 * what lets it be unit-tested without sharp or a real frame. index.ts does the
 * sharp reads/writes and calls in here for the arithmetic.
 *
 * Coordinates follow the same convention as tools/center-placement: a crop is
 * stored as a `Rect` in cell fractions ({x, y, w, h} against the tile's width
 * and height independently), because the center cell is stretched per-axis when
 * drawn - one divisor for both axes would be the silent-stretch bug the tile
 * geometry warns about.
 */

/** Pixel size of an image or a frame. */
export interface Size {
  w: number;
  h: number;
}

/**
 * A half-open pixel rectangle: [x0, x1) x [y0, y1), so `x1`/`y1` are one past
 * the last covered pixel - the shape sharp's `extract` and a raw alpha scan
 * both speak in (width = x1 - x0).
 */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A crop rectangle in cell fractions, matching tools/center-placement's `Rect`. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One packed cycle's entry in the manifest index.ts writes. */
export interface AnimationCycle {
  /** The cycle's source directory name, e.g. `center_0`. */
  name: string;
  /** Sheet url relative to the manifest (and so to `sharedBase`), e.g. `sheets/center_0.png`. */
  sheet: string;
  /** How many frames the sheet holds, laid out left-to-right, top-to-bottom. */
  frames: number;
  /** Frames per row in the sheet grid. */
  columns: number;
  /** Rows in the sheet grid. */
  rows: number;
  /** One frame's pixel size within the sheet. */
  frameWidth: number;
  frameHeight: number;
  /** Where the frame content sits on the center tile, in cell fractions. */
  rect: Rect;
}

/** The whole loading-animation manifest served alongside the sheets. */
export interface AnimationManifest {
  /** Milliseconds each frame is shown. */
  frameDurationMs: number;
  /** The source tile size the crop fractions were measured against. */
  tile: Size;
  cycles: AnimationCycle[];
}

/**
 * Combine two half-open bounds into the smallest box covering both. A null
 * operand is "no content", so it contributes nothing.
 */
export function mergeBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/**
 * The union of every frame's content bounds - the one crop rectangle used for
 * the whole cycle, so a frame whose content shifts still lands registered
 * against the same origin. Null when no frame had any content.
 */
export function unionBounds(list: (Bounds | null)[]): Bounds | null {
  return list.reduce<Bounds | null>((acc, b) => mergeBounds(acc, b), null);
}

/** A half-open bounds' pixel size. */
export function boundsSize(b: Bounds): Size {
  return { w: b.x1 - b.x0, h: b.y1 - b.y0 };
}

/**
 * Convert pixel bounds to a cell-fraction `Rect` against `tile`. Per-axis
 * divisors on purpose - see the file header.
 */
export function boundsToRect(b: Bounds, tile: Size): Rect {
  return {
    x: b.x0 / tile.w,
    y: b.y0 / tile.h,
    w: (b.x1 - b.x0) / tile.w,
    h: (b.y1 - b.y0) / tile.h,
  };
}

/** The pixel size and grid shape of a packed sheet. */
export interface SheetLayout {
  columns: number;
  rows: number;
  sheet: Size;
  frame: Size;
}

/**
 * Lay `frameCount` frames of size `frame` into a near-square grid (or exactly
 * `columns` wide when given). Near-square keeps the sheet's largest dimension
 * small, which is friendlier to the max-texture-size limits the WebGL renderer
 * uploads through than one long strip would be.
 */
export function packLayout(frameCount: number, frame: Size, columns?: number): SheetLayout {
  if (frameCount < 1) throw new Error('packLayout needs at least one frame');
  const cols = columns ?? Math.ceil(Math.sqrt(frameCount));
  const rows = Math.ceil(frameCount / cols);
  return {
    columns: cols,
    rows,
    frame,
    sheet: { w: cols * frame.w, h: rows * frame.h },
  };
}

/** The top-left pixel of frame `i` within a packed sheet. */
export function frameCellAt(i: number, layout: SheetLayout): { left: number; top: number } {
  return {
    left: (i % layout.columns) * layout.frame.w,
    top: Math.floor(i / layout.columns) * layout.frame.h,
  };
}
