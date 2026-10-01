/**
 * One frame as data: the primitives a planner decides and a painter emits.
 *
 * `framePlan.ts` and `slidePlan.ts` make every per-cell decision (level,
 * substitution, badge gating, overlay geometry) and write the result here.
 * `render.ts`'s `paintCanvas2D` and `glRenderer.ts`'s `paintGL` walk the list
 * and make no decisions of their own. A new primitive kind needs a case in
 * both painters; `assertNever` in each painter's `switch` makes a missing one
 * fail typecheck.
 *
 * Rects are CSS pixels. The GL painter multiplies them by `dpr`; the Canvas2D
 * context already carries that scale in its transform.
 *
 * The list is pooled because it is rebuilt every frame during motion: each
 * kind's items are reused objects, and `reset()` rewinds the pools rather than
 * dropping them. An item is valid only until the next `reset()`, and entries
 * of `items` at or past `length` are stale.
 */
import type { Drawable } from './tiles.ts';
import type { Slot, SpineFontLimits } from './center.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One color in both painters' terms: a CSS string and 0-1 float RGB. */
export interface Color {
  css: string;
  rgb: readonly [number, number, number];
}

const color = (r: number, g: number, b: number): Color => ({
  css: `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`,
  rgb: [r / 255, g / 255, b / 255],
});

/**
 * Rule 1's floor (`framePlan.ts`), for a cell with nothing resident to draw.
 * `npm run test:parity` compares it across renderers.
 */
export const BLANK_FILL = color(0x15, 0x12, 0x0f);
/** Distill mode's stand-in for a distill alternate that has not loaded - see `planGenericFade`. */
export const FADE_FILL = color(0, 0, 0);
/** The keyboard cursor's ring. */
export const CURSOR_STROKE = color(0xe8, 0xe0, 0xd2);

/**
 * Which `DrawResult` counter an image item fed. A painter that cannot draw
 * the item's source (the GL painter, before its texture uploads) reports the
 * loss back so the renderer moves the cell from drawn to blank.
 */
export type CellStat = 'none' | 'drawn' | 'substituted';

/** A source image, or a sub-rect of one, scaled into `dst`. */
export interface ImageItem {
  kind: 'image';
  source: Drawable;
  /** Whether to draw the whole source; `src` is stale when true. */
  whole: boolean;
  /** Source-image pixels. */
  src: Rect;
  dst: Rect;
  /** 0-1. */
  alpha: number;
  /** What to fill `dst` with if a painter cannot draw `source`, or null to draw nothing. */
  fallback: Color | null;
  stat: CellStat;
}

export interface FillItem {
  kind: 'fill';
  dst: Rect;
  color: Color;
  alpha: number;
}

/**
 * A rectangle's outline. Each painter strokes it its own way: Canvas2D
 * centres the line on the rect's edge, GL draws it inside the rect.
 */
export interface StrokeItem {
  kind: 'stroke';
  dst: Rect;
  width: number;
  color: Color;
}

/**
 * The gold hover glow in an SVG path's silhouette. `path` is in fractions of
 * `cell` (`svgPath.ts`). `fallback` is where the GL painter draws a flat glow
 * when it cannot bake the path (`gl/glowTexture.ts` with no `document`).
 */
export interface GlowItem {
  kind: 'glow';
  path: string;
  cell: Rect;
  fallback: Rect;
}

/**
 * The center tile's spine titles, composed by `center.ts`'s `composeSpines`.
 * Canvas2D composes into `cell`; the GL painter bakes a texture the size of
 * `dst`, the cell padded like its tile.
 */
export interface SpinesItem {
  kind: 'spines';
  cell: Rect;
  dst: Rect;
  slots: (Slot | null)[];
  hoveredBook: number | null;
  limits: SpineFontLimits;
}

export type DrawItem = ImageItem | FillItem | StrokeItem | GlowItem | SpinesItem;

/** The exhaustiveness check each painter's `switch` ends with. */
export function assertNever(item: never): never {
  throw new Error(`unknown draw item: ${JSON.stringify(item)}`);
}

export interface DrawList {
  /** The device pixel ratio the frame was planned for. */
  dpr: number;
  /** Whether image draws filter bilinearly - see `framePlan.ts`'s `SMOOTHING_MAX_DOWNSCALE`. */
  smoothing: boolean;
  /** Paint order. Only the first `length` entries belong to this frame. */
  readonly items: readonly DrawItem[];
  readonly length: number;
  reset(dpr: number, smoothing: boolean): void;
  image(
    source: Drawable, src: { sx: number; sy: number; sw: number; sh: number } | null,
    x: number, y: number, w: number, h: number,
    alpha?: number, fallback?: Color | null, stat?: CellStat
  ): void;
  fill(x: number, y: number, w: number, h: number, color: Color, alpha?: number): void;
  stroke(x: number, y: number, w: number, h: number, width: number, color: Color): void;
  glow(path: string, cell: Rect, fallback: Rect): void;
  spines(
    cell: Rect, dst: Rect, slots: (Slot | null)[], hoveredBook: number | null, limits: SpineFontLimits
  ): void;
}

const rect = (): Rect => ({ x: 0, y: 0, w: 0, h: 0 });

const setRect = (r: Rect, x: number, y: number, w: number, h: number): Rect => {
  r.x = x;
  r.y = y;
  r.w = w;
  r.h = h;
  return r;
};

/** A grow-only stack of reusable objects; `rewind()` makes every one free again. */
function pool<T>(make: () => T) {
  const all: T[] = [];
  let used = 0;
  return {
    next(): T {
      if (used === all.length) all.push(make());
      return all[used++];
    },
    rewind(): void {
      used = 0;
    },
  };
}

export function createDrawList(): DrawList {
  const items: DrawItem[] = [];
  let length = 0;
  const images = pool<ImageItem>(() => ({
    kind: 'image', source: null as unknown as Drawable, whole: true, src: rect(), dst: rect(),
    alpha: 1, fallback: null, stat: 'none',
  }));
  const fills = pool<FillItem>(() => ({ kind: 'fill', dst: rect(), color: BLANK_FILL, alpha: 1 }));
  const strokes = pool<StrokeItem>(() => ({ kind: 'stroke', dst: rect(), width: 1, color: CURSOR_STROKE }));
  const glows = pool<GlowItem>(() => ({ kind: 'glow', path: '', cell: rect(), fallback: rect() }));
  const spines = pool<SpinesItem>(() => ({
    kind: 'spines', cell: rect(), dst: rect(), slots: [], hoveredBook: null,
    limits: null as unknown as SpineFontLimits,
  }));

  const push = (item: DrawItem): void => {
    if (length < items.length) items[length] = item;
    else items.push(item);
    length++;
  };

  const list: DrawList = {
    dpr: 1,
    smoothing: true,
    items,
    get length() {
      return length;
    },
    reset(dpr, smoothing) {
      list.dpr = dpr;
      list.smoothing = smoothing;
      length = 0;
      images.rewind();
      fills.rewind();
      strokes.rewind();
      glows.rewind();
      spines.rewind();
    },
    image(source, src, x, y, w, h, alpha = 1, fallback = null, stat = 'none') {
      const item = images.next();
      item.source = source;
      item.whole = src === null;
      if (src) setRect(item.src, src.sx, src.sy, src.sw, src.sh);
      setRect(item.dst, x, y, w, h);
      item.alpha = alpha;
      item.fallback = fallback;
      item.stat = stat;
      push(item);
    },
    fill(x, y, w, h, c, alpha = 1) {
      const item = fills.next();
      setRect(item.dst, x, y, w, h);
      item.color = c;
      item.alpha = alpha;
      push(item);
    },
    stroke(x, y, w, h, width, c) {
      const item = strokes.next();
      setRect(item.dst, x, y, w, h);
      item.width = width;
      item.color = c;
      push(item);
    },
    glow(path, cell, fallback) {
      const item = glows.next();
      item.path = path;
      setRect(item.cell, cell.x, cell.y, cell.w, cell.h);
      setRect(item.fallback, fallback.x, fallback.y, fallback.w, fallback.h);
      push(item);
    },
    spines(cell, dst, slots, hoveredBook, limits) {
      const item = spines.next();
      setRect(item.cell, cell.x, cell.y, cell.w, cell.h);
      setRect(item.dst, dst.x, dst.y, dst.w, dst.h);
      item.slots = slots;
      item.hoveredBook = hoveredBook;
      item.limits = limits;
      push(item);
    },
  };
  return list;
}
