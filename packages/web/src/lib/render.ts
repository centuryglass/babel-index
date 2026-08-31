/**
 * One frame of the map.
 *
 * Pulled out of `main.jsx`'s effect so the decisions it makes - which level to
 * draw, what to substitute when that level is missing, what to warm next - can
 * be asserted without a browser. What it needs is a 2d context and the state of
 * the world; it owns no React, no DOM lookups and no event handlers.
 *
 * The renderer is where the three pyramid rules meet the screen:
 *
 *   1. Never blank. Every cell asks the cache for its room and takes whatever
 *      comes back, at whatever level; only a room with nothing at all resident
 *      falls through to a flat fill, and the pinned generic makes even that
 *      rare.
 *   2. Load ahead. After the visible pass, a ring of cells outside the viewport
 *      is queued at the current level, and the next level out is warmed for
 *      what is on screen - both behind everything visible, because a prefetch
 *      that delays a visible tile has served rule 2 by breaking rule 1.
 *   3. Hold. Nothing here evicts; that is the cache's business, and it is told
 *      where the frame starts so it never drops what this pass is drawing.
 *
 * The level is remembered between frames because `pickLevel()` needs it: the
 * hysteresis band is what stops a zoom held near a boundary from flickering
 * between two levels, and it can only apply if it knows what is on screen now.
 */
import { PYRAMID, prefetchBounds, type Bounds, type Pyramid } from './pyramid.ts';
import { pxPerCell, type Camera } from './camera.ts';
import { CENTER, FAV_ON, FAV_OFF, genericId, type LoadableImage, type RoomId, type TileCache } from './tiles.ts';
import { composeSpines, type Slot, type SpineContext, type SpineFontLimits } from './center.ts';
import { favoriteIconScreenRect } from './favoriteBadge.ts';
import type { MapLayout, RoomAtResult } from '../../../map/ordering.ts';

/**
 * The 2d-context surface this file actually calls - not the whole DOM
 * `CanvasRenderingContext2D`, which `render.test.mjs`'s recording fake has
 * never implemented and should not have to. A real context satisfies this
 * structurally, so nothing at the call sites changes.
 */
export interface DrawContext {
  // A real `CanvasRenderingContext2D`'s `fillStyle`/`strokeStyle` read back as
  // `string | CanvasGradient | CanvasPattern` even though this file only ever
  // assigns a string to them - matching that union here is what lets a real
  // context satisfy this interface, not just the test's recording fake.
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  // `LoadableImage` is all this file ever passes; `CanvasImageSource` is added
  // to the union purely so a real `CanvasRenderingContext2D` - whose own
  // `drawImage` only accepts the latter - still satisfies this interface.
  drawImage(
    image: LoadableImage | CanvasImageSource,
    dx: number, dy: number, dw: number, dh: number
  ): void;
  drawImage(
    image: LoadableImage | CanvasImageSource,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number
  ): void;
}

/**
 * The cache id for whatever a cell holds. The center is the blank center tile;
 * a generic cell is one of the generic tiles, chosen positionally by the
 * layout (so a reorder never changes it); a slot is its room. `genericId(-1)`
 * falls back to the center tile, which covers a corpus with no generic tiles
 * at all.
 */
const idOf = (cell: RoomAtResult, layout: MapLayout, gx: number, gy: number): RoomId =>
  cell.center ? CENTER : cell.generic ? genericId(layout.genericIndexAt(gx, gy)) : cell.id;

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
  /** draw the center-room marker and rank labels */
  chrome?: boolean;
  /**
   * the history/tag titles to composite onto the center tile's spines, or
   * null to draw none. Optional so tests and the slide renderer, which never
   * pass it, exercise no text compositing.
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
   * to draw none - absent whenever this deployment has no favorite store
   * (see `useFavorites.ts`'s `enabled`).
   */
  favorites?: { isFavorite: (id: number) => boolean } | null;
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
    ctx, width: w, height: h, dpr, cam, layout, order, chrome = true, centreSlots = null,
    hoveredBook = null, spineFontLimits = null, cursor = null, favorites = null,
  }: DrawOpts): DrawResult {
    cache.beginFrame();

    ctx.fillStyle = '#0a0908';
    ctx.fillRect(0, 0, w, h);

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
        const hit = cache.get(id, level);

        if (hit) {
          if (hit.rect) {
            const { sx: rx, sy: ry, sw, sh } = hit.rect;
            ctx.drawImage(hit.img, rx, ry, sw, sh, sx, sy, cw, ch);
          } else {
            ctx.drawImage(hit.img, sx, sy, cw, ch);
          }
          drawn++;
          if (hit.level !== level) substituted++;
        } else {
          // Rule 1's floor. Only reachable before the generic itself has
          // loaded, or for a room the manifest does not have.
          ctx.fillStyle = '#15120f';
          ctx.fillRect(sx, sy, cw, ch);
          blank++;
        }

        if (chrome) drawChrome(ctx, cell, sx, sy, cellPx, zoom);
        // The favorite badge - every real room, never the center (it is the
        // controls, not a room) and never a generic cell (nothing to favorite).
        if (favorites && !cell.center && !cell.generic)
          drawFavoriteBadge(ctx, cache, favorites.isFavorite(cell.id) ? FAV_ON : FAV_OFF, cellPx, sx, sy);
        // The center room's spines carry the search history. Content, not
        // chrome, so it is not gated on that flag - but it is gated on legible
        // spine width inside composeSpines, so far out it draws nothing.
        //
        // `ctx` is only `DrawContext` here (see that interface's own doc) - a
        // real 2d context also satisfies `composeSpines`'s wider `SpineContext`,
        // and the cast is what lets `render.test.mjs`'s fake stay narrow per
        // AGENTS.md, since it never exercises this path.
        if (cell.center && centreSlots && spineFontLimits)
          composeSpines(
            ctx as SpineContext, { x: sx, y: sy, w: cellPx.x, h: cellPx.y }, centreSlots, hoveredBook, spineFontLimits
          );
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
    // The keyboard cursor's ring - drawn LAST, over everything, and only once
    // the reader has actually used a keyboard (the caller gates `cursor` on
    // that; a permanent reticle in the middle of a page nobody has touched
    // would be a strong visual choice made on nobody's behalf). Doubles as a
    // desync detector: if this ring is ever on the wrong cell, that is visible
    // to every sighted reader, not only to the one it would otherwise mislead.
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
 * Draw one tile's favorite badge, if its art has landed - rule 1 does not
 * apply here, since a badge that has not loaded yet simply does not draw
 * rather than falling back to anything. Shared between `render.ts` and
 * `slide.ts`, since both draw the exact same badge over the exact same corner.
 */
export function drawFavoriteBadge(
  ctx: DrawContext,
  cache: TileCache,
  id: RoomId,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number
): void {
  const hit = cache.get(id, 0);
  if (!hit) return;
  const { x, y, w, h } = favoriteIconScreenRect(cellPx, sx, sy);
  if (hit.rect) {
    const { sx: rx, sy: ry, sw, sh } = hit.rect;
    ctx.drawImage(hit.img, rx, ry, sw, sh, x, y, w, h);
  } else {
    ctx.drawImage(hit.img, x, y, w, h);
  }
}

/** The center-room marker and the rank labels. Cosmetic, and zoom-gated. */
function drawChrome(
  ctx: DrawContext,
  cell: RoomAtResult,
  sx: number,
  sy: number,
  cellPx: { x: number; y: number },
  zoom: number
): void {
  if (cell.center) {
    ctx.strokeStyle = 'rgba(200,169,95,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx + 1, sy + 1, cellPx.x - 2, cellPx.y - 2);
    if (zoom > 90) {
      ctx.fillStyle = 'rgba(200,169,95,0.95)';
      ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('the center', sx + 10, sy + 22);
    }
  } else if (!cell.generic && zoom > 120) {
    ctx.fillStyle = 'rgba(232,224,210,0.55)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(`#${cell.rank}`, sx + 8, sy + 18);
  }
}
