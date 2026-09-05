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
import {
  CENTER, FAV_ON, FAV_OFF, FAV_CENTER_SWITCH_BASE, FAV_MINE_ON, FAV_COUNT_ON,
  genericId, type LoadableImage, type RoomId, type TileCache,
} from './tiles.ts';
import { composeSpines, areSpinesLegible, type Slot, type SpineContext, type SpineFontLimits } from './center.ts';
import { favoriteIconScreenRect, favoriteSwitchScreenRect, FAVORITE_TOGGLE_PATH } from './favoriteBadge.ts';
import { parsePath } from './svgPath.ts';
import type { MapLayout, RoomAtResult } from '../../../map/ordering.ts';
import type { SortMode } from '../../../map/favorites.ts';

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
  /** 0-1. Used only for distill mode's black fade over generic tiles - restored to 1 after. */
  globalAlpha: number;
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
  /**
   * The world cell of the tile whose favorite badge is under the pointer, or
   * null - same split as `hoveredBook`: read each frame here, written by
   * `useMapRenderer.ts`'s `pointermove` listener. Compared against `(gx, gy)`
   * in the draw loop below rather than carried as a room id, since a generic
   * or center cell never has a badge to hover in the first place.
   */
  hoveredFavorite?: { x: number; y: number } | null;
  /**
   * Which of the three rankings is in force, for the center tile's
   * favorites-sort switch (drawn whenever `favorites` is non-null - see
   * `drawFavoriteSwitch`). Read together with `favorites` rather than folded
   * into it: `sortMode` always has a value, `favorites` is what actually
   * gates whether the switch draws at all.
   */
  sortMode?: SortMode;
  /**
   * Distill mode's black fade over generic tiles - 0 (normal) to 1 (fully
   * hidden), or undefined/0 to draw generics as usual. See
   * `packages/web/src/hooks/useDistillMode.ts`.
   */
  genericFade?: number;
}

/**
 * Distill mode's black overlay for a generic tile - drawn OVER the tile's own
 * art rather than skipping it, so the fade is a crossfade rather than a cut.
 * Shared with `slide.ts` so a generic tile mid-slide gets the same treatment.
 */
export function drawGenericFade(
  ctx: DrawContext, fade: number, sx: number, sy: number, w: number, h: number
): void {
  if (fade <= 0) return;
  ctx.globalAlpha = Math.min(1, fade);
  ctx.fillStyle = '#000';
  ctx.fillRect(sx, sy, w, h);
  ctx.globalAlpha = 1;
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
    hoveredBook = null, spineFontLimits = null, cursor = null, favorites = null, hoveredFavorite = null,
    sortMode = 'relevance', genericFade = 0,
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

        if (cell.generic && genericFade) drawGenericFade(ctx, genericFade, sx, sy, cw, ch);

        if (chrome) drawChrome(ctx, cell, sx, sy, zoom);
        // The favorite badge - every real room, never the center (it is the
        // controls, not a room) and never a generic cell (nothing to favorite).
        if (favorites && !cell.center && !cell.generic) {
          const hovered = hoveredFavorite != null && hoveredFavorite.x === gx && hoveredFavorite.y === gy;
          drawFavoriteBadge(
            ctx, cache, favorites.isFavorite(cell.id) ? FAV_ON : FAV_OFF, cellPx, sx, sy, hovered
          );
        }
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
        // The favorites-sort switch, painted into the center tile's upper
        // left corner - the mirror of the favorite badge's upper right,
        // drawn only once this deployment actually has a favorite store
        // (`favorites` is null otherwise) and only once the tile is zoomed in
        // enough to be worth reading, the same gate the shelf's own titles use.
        if (cell.center && favorites && areSpinesLegible({ x: sx, y: sy, w: cellPx.x, h: cellPx.y }))
          drawFavoriteSwitch(ctx, cache, sortMode, cellPx, sx, sy);
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
 * The 2d-context surface a traced-path highlight needs, beyond `DrawContext` -
 * same split as `SpineContext` above, and for the same reason: `render.test.mjs`
 * never hovers a badge, so its recording fake never implements these either.
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

/** Same gold as the shelf's `HOVER_GLOW_FILL`/`_STROKE` (center.ts) - one hover treatment across every integrated control. */
const FAVORITE_HOVER_GLOW_FILL = 'rgba(200,169,95,0.28)';
const FAVORITE_HOVER_GLOW_STROKE = 'rgba(200,169,95,0.55)';

/**
 * Trace `FAVORITE_TOGGLE_PATH` (a per-axis tile fraction, like every other
 * traced rect on a tile) onto a real path at this tile's screen position,
 * ready to `fill()`/`stroke()`. Replays the true Bezier curve rather than a
 * flattened polygon - `parsePath` exists for exactly this, `flattenPath`
 * (`svgPath.ts`) is for hit-testing only.
 */
function traceFavoriteToggle(ctx: PathContext, cellPx: { x: number; y: number }, sx: number, sy: number): void {
  ctx.beginPath();
  for (const cmd of parsePath(FAVORITE_TOGGLE_PATH as string)) {
    if (cmd.type === 'M') ctx.moveTo(sx + cmd.x * cellPx.x, sy + cmd.y * cellPx.y);
    else if (cmd.type === 'L') ctx.lineTo(sx + cmd.x * cellPx.x, sy + cmd.y * cellPx.y);
    else if (cmd.type === 'C')
      ctx.bezierCurveTo(
        sx + cmd.x1 * cellPx.x, sy + cmd.y1 * cellPx.y,
        sx + cmd.x2 * cellPx.x, sy + cmd.y2 * cellPx.y,
        sx + cmd.x * cellPx.x, sy + cmd.y * cellPx.y
      );
    else ctx.closePath();
  }
}

/**
 * Draw one tile's favorite badge, if its art has landed - rule 1 does not
 * apply here, since a badge that has not loaded yet simply does not draw
 * rather than falling back to anything. Shared between `render.ts` and
 * `slide.ts`, since both draw the exact same badge over the exact same corner.
 *
 * `hovered` paints a gold glow OVER the art, in the badge's own traced
 * silhouette (`FAVORITE_TOGGLE_PATH`) rather than a rectangle loose enough to
 * cover the tile's corner - the same "shape, not a box" choice the shelf's
 * open book makes, and the same reason it is drawn on the canvas rather than
 * as a DOM overlay: there is no per-tile DOM element to hang a CSS `:hover`
 * off of. `ctx` is only `DrawContext` here (see that interface's own doc) - a
 * real 2d context also satisfies `PathContext`, and the cast is sound for the
 * same reason `render()`'s own cast into `SpineContext` is.
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
    const { x, y, w, h } = favoriteIconScreenRect(cellPx, sx, sy);
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
    path.fillStyle = FAVORITE_HOVER_GLOW_FILL;
    path.fill();
    path.lineWidth = 1;
    path.strokeStyle = FAVORITE_HOVER_GLOW_STROKE;
    path.stroke();
  }
}

/**
 * Draw the center tile's favorites-sort switch: the base plate, always drawn
 * once favorites are enabled, plus whichever "on" face matches the active
 * sort - neither face for `'relevance'`, which is the switch's off position.
 * Each piece draws only once its own art has landed, same as
 * `drawFavoriteBadge`, and all three share one screen rect since the "on"
 * faces are painted to overlay the base plate exactly. Exported and shared
 * with `slide.ts` (same as `drawFavoriteBadge`) - the center tile is the
 * rearrangement's fixed tile, so its controls must keep drawing across the
 * handoff between renderers rather than blinking out for the animation.
 */
export function drawFavoriteSwitch(
  ctx: DrawContext,
  cache: TileCache,
  sortMode: SortMode,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number
): void {
  const { x, y, w, h } = favoriteSwitchScreenRect(cellPx, sx, sy);
  const draw = (id: RoomId) => {
    const hit = cache.get(id, 0);
    if (hit) ctx.drawImage(hit.img, x, y, w, h);
  };
  draw(FAV_CENTER_SWITCH_BASE);
  if (sortMode === 'mine') draw(FAV_MINE_ON);
  else if (sortMode === 'count') draw(FAV_COUNT_ON);
}

/** The rank labels. Cosmetic, and zoom-gated. */
function drawChrome(
  ctx: DrawContext,
  cell: RoomAtResult,
  sx: number,
  sy: number,
  zoom: number
): void {
  if (!cell.center && !cell.generic && zoom > 120) {
    ctx.fillStyle = 'rgba(232,224,210,0.55)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(`#${cell.rank}`, sx + 8, sy + 18);
  }
}
