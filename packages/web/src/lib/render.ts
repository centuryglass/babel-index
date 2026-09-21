/**
 * One frame of the map: a 2d context and the state of the world in, a painted
 * frame and draw stats out. No React, no DOM lookups, no event handlers - so
 * its decisions (which level to draw, what to substitute when that level is
 * missing, what to warm next) are asserted browser-free by `render.test.ts`.
 *
 * Where the three pyramid rules meet the screen. "Rule 1"/"rule 2" elsewhere
 * in this cluster mean these:
 *
 *   1. Never blank. Every cell asks the cache for its room and takes whatever
 *      comes back, at whatever level; only a room with nothing at all resident
 *      falls through to a flat fill, and the pinned generic makes even that
 *      rare.
 *   2. Load ahead. After the visible pass, a ring of cells outside the viewport
 *      is queued at the current level, and the next level out is warmed for
 *      what is on screen. Both run behind everything visible: a prefetch that
 *      delays a visible tile has served rule 2 by breaking rule 1.
 *   3. Hold. Nothing here evicts; that is the cache's business, and it is told
 *      where the frame starts (`beginFrame()`) so it never drops what this
 *      pass is drawing.
 *
 * The level is remembered between frames for `pickLevel()`'s hysteresis band:
 * it stops a zoom held near a boundary from flickering between two levels,
 * and it can only apply if it knows what was on screen last frame.
 */
import { PYRAMID, prefetchBounds, type Bounds, type Pyramid } from './pyramid.ts';
import { pxPerCell, type Camera } from './camera.ts';
import {
  CENTER, FAV_ON, FAV_OFF, FAV_CENTER_SWITCH_BASE, FAV_MINE_ON, FAV_COUNT_ON,
  DISTILL_OFF, DISTILL_ON, CLEAR_HISTORY_BOOK,
  genericId, genericDistillId, type Drawable, type RoomId, type TileCache, type TileHit,
} from './tiles.ts';
import {
  composeSpines, areSpinesLegible, BOOK_COUNT,
  type Slot, type SpineContext, type SpineFontLimits,
} from './center.ts';
import { HOVER_GLOW_FILL, HOVER_GLOW_STROKE } from './cssVars.ts';
import { favoriteIconScreenRect, favoriteSwitchScreenRect, FAVORITE_TOGGLE_PATH } from './favoriteBadge.ts';
import { distillIconScreenRect, DISTILL_OFF_PATH, DISTILL_ON_PATH } from './distillToggle.ts';
import { clearHistoryBookScreenRect } from './clearHistoryBook.ts';
import { tracePathCommands } from './svgPath.ts';
import { perfRecordSheetFirstDraw } from './perfProbe.ts';
import type { LoadingFrame } from './loadingAnimation.ts';
import type { MapLayout, RoomAtResult } from '../../../map/ordering.ts';
import type { SortMode } from '../../../map/favorites.ts';

/**
 * The 2d-context surface this file calls - the whole `CanvasRenderingContext2D`
 * narrowed to what a frame uses, so `render.test.ts`'s recording fake implements
 * exactly the calls it records. A real context satisfies this structurally, so
 * nothing at the call sites changes - and the same is true of the wider
 * surfaces this file casts into (`SpineContext`, `PathContext`): a real context
 * supports them all, and the fake never exercises those paths.
 */
export interface DrawContext {
  // The union, not `string`: a real `CanvasRenderingContext2D` types
  // `fillStyle`/`strokeStyle` as `string | CanvasGradient | CanvasPattern`
  // even where only strings are assigned, and matching that union is what lets
  // a real context satisfy this interface.
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  /** 0-1. Distill mode's crossfade over generic tiles; restored to 1 after. */
  globalAlpha: number;
  /**
   * Whether `drawImage` bilinearly filters. Set per frame from the draw's
   * downscale ratio - see `SMOOTHING_MAX_DOWNSCALE`.
   */
  imageSmoothingEnabled: boolean;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  // `CanvasImageSource` is added to the union only so a real
  // `CanvasRenderingContext2D`, whose `drawImage` accepts nothing else, keeps
  // satisfying this interface; all call sites pass a `Drawable`.
  drawImage(
    image: Drawable | CanvasImageSource,
    dx: number, dy: number, dw: number, dh: number
  ): void;
  drawImage(
    image: Drawable | CanvasImageSource,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number
  ): void;
}

/**
 * The cache id for whatever a cell holds: the center cell takes the blank
 * center tile, a generic cell one of the generic tiles chosen by
 * `layout.genericIndexAt`, a content cell its room. `genericId(-1)` is
 * `CENTER`, the fallback for a corpus with no generic tiles at all.
 */
const idOf = (cell: RoomAtResult, layout: MapLayout, gx: number, gy: number): RoomId =>
  cell.center ? CENTER : cell.generic ? genericId(layout.genericIndexAt(gx, gy)) : cell.id;

/**
 * The largest tile-to-cell downscale ratio at which bilinear filtering still
 * earns its cost. `pickLevel` hands back a tile at least as large as the
 * demand, so this ratio is >= 1; near 1:1 (and above, when a coarser tile is
 * substituted) filtering pays for itself, and beyond it nearest-neighbour of
 * an already-filtered mip looks the same for a fraction of the work. Bilinear
 * downscaling of the whole visible field is the largest single cost in a
 * zoomed-out frame (Skia's filtered sampler), and a zoomed-out frame is where
 * this ratio is high.
 */
export const SMOOTHING_MAX_DOWNSCALE = 1.25;

export interface CreateRendererOpts {
  cache: TileCache;
  pyramid?: Pyramid;
}

export interface DrawOpts {
  ctx: DrawContext;
  /** css pixels */
  width: number;
  /** css pixels */
  height: number;
  /** device pixel ratio, already clamped */
  dpr: number;
  cam: Camera;
  /** from packages/map */
  layout: MapLayout;
  /** room ids, best first */
  order: number[];
  /**
   * The history/tag titles to composite onto the center tile's spines, or
   * null to draw none. The slide renderer draws no spine text, so only the
   * map's draw call passes it.
   */
  centreSlots?: (Slot | null)[] | null;
  /** the shelf book under the pointer, or null - see `composeSpines`'s hover backdrop */
  hoveredBook?: number | null;
  /**
   * `config.center`'s auto-fit font range for `composeSpines` - required
   * together with `centreSlots`; the spines are skipped (not sized off a
   * restated fallback) if a caller supplies one without the other.
   */
  spineFontLimits?: SpineFontLimits | null;
  cursor?: { x: number; y: number } | null;
  /**
   * Overlay a favorite badge on every non-center, non-generic cell, or null
   * to draw none - null whenever this deployment has no favorite store (see
   * `useFavorites.ts`'s `enabled`).
   */
  favorites?: { isFavorite: (id: number) => boolean } | null;
  /**
   * The world cell of the tile whose favorite badge is under the pointer, or
   * null - same read-per-frame split as `hoveredBook`. A cell, not a room id:
   * only real rooms carry badges, and a favorite's cell is what the draw loop
   * compares against.
   */
  hoveredFavorite?: { x: number; y: number } | null;
  /**
   * Which of the three rankings is in force, for the center tile's
   * favorites-sort switch (drawn whenever `favorites` is non-null - see
   * `drawFavoriteSwitch`). `favorites`, not this, gates whether the switch
   * draws: `sortMode` always has a value.
   */
  sortMode?: SortMode;
  /**
   * Distill mode's crossfade over generic tiles - 0 (normal) to 1 (fully
   * replaced by the tile's paired distill alternate, `genericDistillId`);
   * see `useDistillMode.ts`.
   */
  genericFade?: number;
  /**
   * Whether distill mode is on, for the center tile's distill toggle - the
   * state its icon and hover highlight read, distinct from `genericFade`,
   * which is the transition's progress. See `drawDistillToggle`.
   */
  distillMode?: boolean;
  /** Whether the pointer is over the distill toggle's traced silhouette - same split as `hoveredBook`. */
  hoveredDistill?: boolean;
  /**
   * The center-tile loading indicator's current frame, or null to draw none -
   * composited over the center cell's book page while a rearrangement
   * preloads (`loadingAnimation.ts`). The slide renderer draws none.
   */
  loadingFrame?: LoadingFrame | null;
}

/**
 * Distill mode's crossfade for a generic tile: the tile's paired distill
 * alternate (`genericDistillId`) drawn over the base art at `fade` opacity -
 * a crossfade between two images, not a fade to black. When the alternate has
 * no cached tile yet - or, per `genericDistillId`'s doc, none exists for this
 * index - it draws flat black at `fade` instead, so a slow load never lets the
 * base art bleed through at an opacity that reads as broken. `slide.ts` calls
 * this too, so a generic tile mid-slide gets the same treatment; the fully-
 * faded skip lives at each draw loop (a tile under a full fade is pure waste
 * there), not here.
 */
export function drawGenericFade(
  ctx: DrawContext, cache: TileCache, distillId: RoomId, fade: number,
  sx: number, sy: number, w: number, h: number
): void {
  if (fade <= 0) return;
  const hit = cache.get(distillId, 0);
  ctx.globalAlpha = Math.min(1, fade);
  if (hit) {
    if (hit.rect) {
      const { sx: rx, sy: ry, sw, sh } = hit.rect;
      ctx.drawImage(hit.img, rx, ry, sw, sh, sx, sy, w, h);
    } else {
      ctx.drawImage(hit.img, sx, sy, w, h);
    }
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(sx, sy, w, h);
  }
  ctx.globalAlpha = 1;
}

/**
 * Composite one loading-indicator frame onto the center cell: the frame's
 * sheet sub-rect (`src`) at its cell-fraction position (`rect`) inside
 * `cellRect`, per-axis (`loadingAnimation.ts`). `glRenderer.ts`'s counterpart
 * draws the same placement; the parity suite checks the two stay in step.
 */
export function drawLoadingFrame(
  ctx: DrawContext,
  frame: LoadingFrame,
  cellRect: { x: number; y: number; w: number; h: number }
): void {
  const dx = cellRect.x + frame.rect.x * cellRect.w;
  const dy = cellRect.y + frame.rect.y * cellRect.h;
  const dw = frame.rect.w * cellRect.w;
  const dh = frame.rect.h * cellRect.h;
  ctx.drawImage(frame.image, frame.src.x, frame.src.y, frame.src.w, frame.src.h, dx, dy, dw, dh);
}

/** What the frame did, for the HUD and for tests. */
export interface DrawResult {
  cells: number;
  drawn: number;
  substituted: number;
  blank: number;
  level: number;
  bounds: Bounds;
  zoom: number;
}

export function createRenderer({ cache, pyramid = PYRAMID }: CreateRendererOpts) {
  // Survives across frames purely so hysteresis has something to compare to.
  let level: number | null = null;

  function draw({
    ctx, width: w, height: h, dpr, cam, layout, order, centreSlots = null,
    hoveredBook = null, spineFontLimits = null, cursor = null, favorites = null, hoveredFavorite = null,
    sortMode = 'relevance', genericFade = 0, distillMode, hoveredDistill = false, loadingFrame = null,
  }: DrawOpts): DrawResult {
    cache.beginFrame();

    // No full-viewport clear: the cell grid below is computed to cover the
    // whole viewport with no gaps (`render.test.ts`'s "the cell grid covers
    // the full viewport with no gaps, at any zoom or fractional pan" asserts
    // it), and every cell paints something - a tile or rule 1's blank
    // fallback rect. A clear here would only ever be painted over.
    const { x: cx, y: cy, zoom } = cam;
    // Pixels per cell on each axis. The cell is the world's base unit and is
    // not square, so every size below comes from here rather than from `zoom`.
    const cellPx = pxPerCell(cam);
    const halfW = w / 2 / cellPx.x;
    const halfH = h / 2 / cellPx.y;
    const bounds: Bounds = {
      x0: Math.floor(cx - halfW), x1: Math.ceil(cx + halfW),
      y0: Math.floor(cy - halfH), y1: Math.ceil(cy + halfH),
    };

    // Demand is in DEVICE pixels, because that is what the tile actually
    // covers. Picking on css pixels ships half-resolution art to every retina
    // display. Both axes go in: a cell need not share the tile's aspect.
    level = pyramid.pickLevel({ w: cellPx.x * dpr, h: cellPx.y * dpr }, level);

    // Smoothing decided once per frame from the level every visible tile
    // shares, not per cell - see `SMOOTHING_MAX_DOWNSCALE`.
    const src = pyramid.sizeOf(level);
    ctx.imageSmoothingEnabled = !src || src.w <= cellPx.x * dpr * SMOOTHING_MAX_DOWNSCALE;

    const toScreen = (wx: number, wy: number): [number, number] =>
      [(wx - cx) * cellPx.x + w / 2, (wy - cy) * cellPx.y + h / 2];
    // +1 kills hairline gaps from rounding, on each axis independently.
    const cw = cellPx.x + 1;
    const ch = cellPx.y + 1;

    let drawn = 0;
    let substituted = 0;
    let blank = 0;
    const visible: RoomId[] = [];

    for (let gy = bounds.y0; gy <= bounds.y1; gy++) {
      for (let gx = bounds.x0; gx <= bounds.x1; gx++) {
        const cell = layout.roomAt(gx, gy, order);
        const id = idOf(cell, layout, gx, gy);
        visible.push(id);

        const [sx, sy] = toScreen(gx, gy);
        const distillId = cell.generic ? genericDistillId(layout.genericIndexAt(gx, gy)) : null;

        // A generic cell fully faded to its distill alternate shows none of the
        // base tile's art, so drawing the base beneath the fade is pure waste -
        // and zoomed out, generic cells are the majority. The prefetch pass
        // still warms the base, so toggling distill off again does not pop.
        if (cell.generic && genericFade >= 1) {
          drawGenericFade(ctx, cache, distillId!, genericFade, sx, sy, cw, ch);
        } else {
          const hit = cache.get(id, level);

          if (hit) {
            if (hit.rect) {
              const { sx: rx, sy: ry, sw, sh } = hit.rect;
              ctx.drawImage(hit.img, rx, ry, sw, sh, sx, sy, cw, ch);
            } else {
              ctx.drawImage(hit.img, sx, sy, cw, ch);
            }
            if (hit.sheetUrl) perfRecordSheetFirstDraw(hit.sheetUrl);
            drawn++;
            if (hit.level !== level) substituted++;
          } else {
            // Rule 1's floor. Only reachable before the generic itself has
            // loaded, or for a room the manifest does not have.
            ctx.fillStyle = '#15120f';
            ctx.fillRect(sx, sy, cw, ch);
            blank++;
          }

          if (cell.generic && genericFade) drawGenericFade(ctx, cache, distillId!, genericFade, sx, sy, cw, ch);
        }

        // The favorite badge: every real room, never the center (it is the
        // controls, not a room) and never a generic cell (nothing to favorite).
        if (favorites && !cell.center && !cell.generic) {
          const hovered = hoveredFavorite != null && hoveredFavorite.x === gx && hoveredFavorite.y === gy;
          drawFavoriteBadge(
            ctx, cache, favorites.isFavorite(cell.id) ? FAV_ON : FAV_OFF, cellPx, sx, sy, hovered
          );
        }
        // The "forget searches" book's black spine, claimed whenever history
        // holds its slot. The check reads `centreSlots` itself - the same
        // override `useCenterShelf.ts` reserves the slot with - so there is no
        // second "is there history" flag to drift. Drawn before the shelf's
        // titles so the gilt text composites on top.
        if (cell.center && centreSlots?.[BOOK_COUNT - 1]?.action === 'forgetHistory')
          drawClearHistoryBookOverlay(ctx, cache, cellPx, sx, sy);
        // The center room's spines carry the search history; `composeSpines`
        // gates on legible spine width, so far out it draws nothing. The cast
        // is the `DrawContext` note's wider-surface case.
        if (cell.center && centreSlots && spineFontLimits)
          composeSpines(
            ctx as SpineContext, { x: sx, y: sy, w: cellPx.x, h: cellPx.y }, centreSlots, hoveredBook, spineFontLimits
          );
        // The favorites-sort switch, in the center tile's upper left corner -
        // the favorite badge's upper-right mirror. Gated on a favorite store
        // existing and on `areSpinesLegible`, the same zoom gate the shelf's
        // titles use.
        if (cell.center && favorites && areSpinesLegible({ x: sx, y: sy, w: cellPx.x, h: cellPx.y }))
          drawFavoriteSwitch(ctx, cache, sortMode, cellPx, sx, sy);
        // The distill toggle, in the center tile's lower right corner -
        // ungated by `favorites`, since distill mode needs no favorite store.
        // `distillMode === undefined` means the caller does not use distill
        // mode at all (a test asserting on level selection, say), and the
        // toggle then draws nothing rather than requesting art nobody asked
        // for.
        if (cell.center && distillMode !== undefined)
          drawDistillToggle(ctx, cache, distillMode, hoveredDistill, cellPx, sx, sy);
        // The loading indicator's frame, over the center book's page. Its
        // region is disjoint from everything above, so the order among them is
        // cosmetic; last matches the GL draw loop's order (glRenderer.ts).
        if (cell.center && loadingFrame)
          drawLoadingFrame(ctx, loadingFrame, { x: sx, y: sy, w: cellPx.x, h: cellPx.y });
      }
    }

    // --- rule 2, strictly after every visible cell has been asked for -------
    const ring = prefetchBounds(bounds);
    for (let gy = ring.y0; gy <= ring.y1; gy++)
      for (let gx = ring.x0; gx <= ring.x1; gx++) {
        const inside =
          gx >= bounds.x0 && gx <= bounds.x1 && gy >= bounds.y0 && gy <= bounds.y1;
        if (inside) continue;
        cache.prefetch(idOf(layout.roomAt(gx, gy, order), layout, gx, gy), level);
      }

    // Zooming out needs ~4x as many tiles at once and has nothing to show until
    // they land; zooming in has the coarse tile on screen already and it
    // upscales acceptably. Hence warming outward only.
    for (const coarser of pyramid.warmLevels(level))
      for (const id of visible) cache.prefetch(id, coarser);

    const cells = (bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1);
    // The keyboard cursor's ring, drawn last and over everything, and only
    // once the reader has used a keyboard - the caller gates `cursor` on that.
    // It doubles as a desync detector: a ring on the wrong cell is visible to
    // every sighted reader, not only to the one it would otherwise mislead.
    if (cursor && cursor.x >= bounds.x0 && cursor.x <= bounds.x1
      && cursor.y >= bounds.y0 && cursor.y <= bounds.y1) {
      const [sx, sy] = toScreen(cursor.x, cursor.y);
      ctx.strokeStyle = '#e8e0d2';
      ctx.lineWidth = 3;
      ctx.strokeRect(sx + 2, sy + 2, cellPx.x - 4, cellPx.y - 4);
    }

    return { cells, drawn, substituted, blank, level, bounds, zoom };
  }

  return { draw };
}

/**
 * The extra 2d-context surface a traced-path hover highlight needs, beyond
 * `DrawContext`, for the same reason that interface is narrow: `render.test.ts`
 * never hovers a badge, so its recording fake implements no path calls.
 */
interface PathContext extends DrawContext {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
}

/**
 * The hit's decoded pixel size: a sheet sub-rect's `sw`/`sh`, else the
 * image's natural size. Sheet packing never actually happens for the shared
 * corner-overlay ids this feeds - `rooms.ts` resolves them flat - but sizing
 * from the hit keeps the rule the same as every other tile lookup. The cast
 * is sound because `tiles.ts`'s `Drawable` doc makes a real tile's image an
 * `ImageBitmap` in the browser.
 *
 * Each corner overlay's screen rect (`favoriteIconScreenRect`,
 * `distillIconScreenRect`, `clearHistoryBookScreenRect`) is sized from this
 * rather than a constant, so replacement art of a different size moves where
 * the overlay draws; hit-testing is independent of it (see each rect's own
 * doc), so a size change cannot silently change what is clickable.
 */
function naturalIconSize(hit: TileHit): { w: number; h: number } {
  if (hit.rect) return { w: hit.rect.sw, h: hit.rect.sh };
  const img = hit.img as unknown as { width: number; height: number };
  return { w: img.width, h: img.height };
}

/**
 * Trace `FAVORITE_TOGGLE_PATH` onto a real path at this tile's screen
 * position, ready to `fill()`/`stroke()`. The path is per-axis tile fractions
 * like every other traced rect. The hover highlight replays the true Bezier
 * (`tracePathCommands`, `svgPath.ts`); `flattenPath` (same file) is for
 * hit-testing only.
 */
function traceFavoriteToggle(ctx: PathContext, cellPx: { x: number; y: number }, sx: number, sy: number): void {
  tracePathCommands(ctx, FAVORITE_TOGGLE_PATH as string, cellPx, sx, sy);
}

/**
 * Draw one tile's favorite badge if its art has landed: rule 1 does not
 * apply, a missing badge simply does not draw. `slide.ts` calls this too, so
 * a sliding room wears the same badge in the same corner.
 *
 * `hovered` paints the gold glow in the badge's own traced silhouette
 * (`FAVORITE_TOGGLE_PATH`) - shape, not box, like the shelf's open book.
 * Canvas-side because a tile has no DOM element of its own for CSS `:hover`
 * to sit on; `drawDistillToggle` and the GL renderer's baked glows follow the
 * same rule. The `ctx` cast: see the `DrawContext` note.
 */
export function drawFavoriteBadge(
  ctx: DrawContext,
  cache: TileCache,
  id: RoomId,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  hovered = false
): void {
  const hit = cache.get(id, 0);
  if (hit) {
    const { x, y, w, h } = favoriteIconScreenRect(cellPx, sx, sy, naturalIconSize(hit));
    if (hit.rect) {
      const { sx: rx, sy: ry, sw, sh } = hit.rect;
      ctx.drawImage(hit.img, rx, ry, sw, sh, x, y, w, h);
    } else {
      ctx.drawImage(hit.img, x, y, w, h);
    }
  }
  if (hovered && FAVORITE_TOGGLE_PATH) {
    const path = ctx as PathContext;
    traceFavoriteToggle(path, cellPx, sx, sy);
    path.fillStyle = HOVER_GLOW_FILL;
    path.fill();
    path.lineWidth = 1;
    path.strokeStyle = HOVER_GLOW_STROKE;
    path.stroke();
  }
}

/**
 * Draw the "forget searches" book's black spine overlay, if its art has
 * landed - rule 1 does not apply, same as `drawFavoriteBadge`. Anchored to
 * that book's own bottom-right corner, not stretched to fill its rect - see
 * `clearHistoryBookScreenRect`'s doc for why. No hover treatment of its own:
 * `composeSpines`'s glow, drawn on top, already covers the book.
 */
export function drawClearHistoryBookOverlay(
  ctx: DrawContext,
  cache: TileCache,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number
): void {
  const hit = cache.get(CLEAR_HISTORY_BOOK, 0);
  if (!hit) return;
  const { x, y, w, h } = clearHistoryBookScreenRect(cellPx, sx, sy, naturalIconSize(hit));
  if (hit.rect) {
    const { sx: rx, sy: ry, sw, sh } = hit.rect;
    ctx.drawImage(hit.img, rx, ry, sw, sh, x, y, w, h);
  } else {
    ctx.drawImage(hit.img, x, y, w, h);
  }
}

/**
 * Trace `DISTILL_OFF_PATH`/`DISTILL_ON_PATH` (a per-axis tile fraction, like
 * `FAVORITE_TOGGLE_PATH`) onto a real path at this tile's screen position,
 * ready to `fill()`/`stroke()` - same replay-the-true-Bezier approach as
 * `traceFavoriteToggle`.
 */
function traceDistillToggle(ctx: PathContext, cellPx: { x: number; y: number }, sx: number, sy: number, d: string): void {
  tracePathCommands(ctx, d, cellPx, sx, sy);
}

/**
 * Draw the center tile's distill toggle: the overlay PNG matching
 * `distillMode` at the tile's lower right corner (`distillIconScreenRect`),
 * plus the hover glow traced onto the active state's own silhouette - the
 * `drawFavoriteBadge` treatment, same gold, same reasons.
 */
export function drawDistillToggle(
  ctx: DrawContext,
  cache: TileCache,
  distillMode: boolean,
  hovered: boolean,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number
): void {
  const id = distillMode ? DISTILL_ON : DISTILL_OFF;
  const hit = cache.get(id, 0);
  if (hit) {
    const { x, y, w, h } = distillIconScreenRect(cellPx, sx, sy, naturalIconSize(hit));
    if (hit.rect) {
      const { sx: rx, sy: ry, sw, sh } = hit.rect;
      ctx.drawImage(hit.img, rx, ry, sw, sh, x, y, w, h);
    } else {
      ctx.drawImage(hit.img, x, y, w, h);
    }
  }
  const activePath = distillMode ? DISTILL_ON_PATH : DISTILL_OFF_PATH;
  if (hovered && activePath) {
    const path = ctx as PathContext;
    traceDistillToggle(path, cellPx, sx, sy, activePath);
    path.fillStyle = HOVER_GLOW_FILL;
    path.fill();
    path.lineWidth = 1;
    path.strokeStyle = HOVER_GLOW_STROKE;
    path.stroke();
  }
}

/**
 * Draw the center tile's favorites-sort switch: the base plate plus whichever
 * "on" face matches `sortMode` - neither face for `'relevance'`, the switch's
 * off position. Each piece draws only once its own art has landed, like
 * `drawFavoriteBadge`.
 *
 * The three pieces share the tile's upper-left anchor but each is sized from
 * its own decoded pixels (`naturalIconSize`), not one shared rect: the real
 * art of `fav_mine_on.png`/`fav_count_on.png`/`fav_center_switch_base.png` is
 * close but not pixel-identical, and forcing a face into the base plate's
 * rect stretched it off the base's own indicator.
 *
 * `slide.ts` and `glSlideRenderer.ts` call this (or its GL twin) because the
 * center tile is the rearrangement's fixed tile: its controls must keep
 * drawing across the handoff between renderers, not blink out mid-animation.
 */
export function drawFavoriteSwitch(
  ctx: DrawContext,
  cache: TileCache,
  sortMode: SortMode,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number
): void {
  const draw = (id: RoomId) => {
    const hit = cache.get(id, 0);
    if (!hit) return;
    const { x, y, w, h } = favoriteSwitchScreenRect(cellPx, sx, sy, naturalIconSize(hit));
    ctx.drawImage(hit.img, x, y, w, h);
  };
  draw(FAV_CENTER_SWITCH_BASE);
  if (sortMode === 'mine') draw(FAV_MINE_ON);
  else if (sortMode === 'count') draw(FAV_COUNT_ON);
}
