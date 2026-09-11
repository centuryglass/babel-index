/**
 * Spike: the WebGL counterpart of `render.ts`'s `createRenderer`.
 *
 * Mirrors `render.ts`'s per-cell loop (blank fallback -> tile draw -> generic
 * fade, then the prefetch ring and coarser-level warm pass) using
 * `gl/context.ts`'s quad primitives instead of `CanvasRenderingContext2D`
 * calls, and the same `TileCache`/`pyramid.ts` this file's Canvas2D twin
 * uses unmodified. One draw call per cell for this first cut - see the
 * plan's "Draw strategy", no instancing yet.
 *
 * `GLDrawOpts` is `render.ts`'s own `DrawOpts` with `ctx: DrawContext`
 * swapped for `gl: GLContext` - imported and derived rather than restated,
 * so a change to `DrawOpts`'s shape is picked up here too. `GLDrawResult` is
 * literally `render.ts`'s `DrawResult` - the two draw loops report the same
 * shape of outcome, so `useMapRendererGL.ts`'s HUD text can read either one
 * the same way `useMapRenderer.ts` already does.
 *
 * The favorite badge is a textured quad via the same texture cache, keyed by
 * `FAV_ON`/`FAV_OFF` exactly as `tiles.ts` already resolves them - see
 * `drawFavoriteBadgeGL` below. Its hover highlight is `render.ts`'s own
 * traced silhouette (`FAVORITE_TOGGLE_PATH`), baked once to a GL texture by
 * `gl/glowTexture.ts` rather than re-traced every frame - see that file's
 * doc for why a bake works regardless of a tile's own pixel size.
 *
 * The center tile's spine text is a separately-cached texture
 * (`gl/spineTexture.ts`, re-rendering `composeSpines` onto an offscreen 2D
 * canvas only when its content/hover/size key changes) drawn as one quad
 * over the center cell.
 *
 * The favorites-sort switch, distill toggle, clear-history overlay and
 * keyboard-cursor ring are the same technique: a textured quad per
 * icon (`drawFavoriteSwitchGL`/`drawDistillToggleGL`/
 * `drawClearHistoryBookOverlayGL`, exported so `glSlideRenderer.ts` can draw
 * them on the center tile's ride across the handoff too) or, for the
 * cursor, `gl/context.ts`'s `drawStrokeQuad`. The distill toggle's hover
 * highlight is the same baked-silhouette treatment as the favorite badge's.
 */
import { PYRAMID, prefetchBounds, type Bounds, type Pyramid } from './pyramid.ts';
import { pxPerCell, type Camera } from './camera.ts';
import {
  CENTER, FAV_ON, FAV_OFF, FAV_CENTER_SWITCH_BASE, FAV_MINE_ON, FAV_COUNT_ON,
  DISTILL_OFF, DISTILL_ON, CLEAR_HISTORY_BOOK,
  genericId, genericDistillId, type RoomId, type TileCache,
} from './tiles.ts';
import { favoriteIconScreenRect, favoriteSwitchScreenRect, FAVORITE_TOGGLE_PATH } from './favoriteBadge.ts';
import { distillIconScreenRect, DISTILL_OFF_PATH, DISTILL_ON_PATH } from './distillToggle.ts';
import { clearHistoryBookScreenRect } from './clearHistoryBook.ts';
import { areSpinesLegible, BOOK_COUNT } from './center.ts';
import { toGLRect, type GLContext, type Rect } from './gl/context.ts';
import { createGLTextureCache, type GLTextureCache } from './gl/textureCache.ts';
import { createSpineTextureCache, type SpineTextureCache } from './gl/spineTexture.ts';
import { createGlowTextureCache, type GlowTextureCache } from './gl/glowTexture.ts';
import type { DrawOpts, DrawResult } from './render.ts';
import type { MapLayout, RoomAtResult } from '../../../map/ordering.ts';
import type { SortMode } from '../../../map/favorites.ts';

/** Same cache-id rule as `render.ts`'s own (unexported) `idOf` - duplicated rather than imported so this file changes nothing about `render.ts`. */
const idOf = (cell: RoomAtResult, layout: MapLayout, gx: number, gy: number): RoomId =>
  cell.center ? CENTER : cell.generic ? genericId(layout.genericIndexAt(gx, gy)) : cell.id;

export interface CreateGLRendererOpts {
  cache: TileCache;
  pyramid?: Pyramid;
  /** Shared across `glRenderer.ts`/`glSlideRenderer.ts` so a tile decoded for one is already resident for the other. */
  textures?: GLTextureCache;
  /** Shared with `glSlideRenderer.ts`, same reason as `textures` - the distill toggle's hover glow rides along across the handoff too. */
  glowTextures?: GlowTextureCache;
}

/** `render.ts`'s `DrawOpts` with the 2D context swapped for a GL one. */
export type GLDrawOpts = Omit<DrawOpts, 'ctx'> & { gl: GLContext };

export type GLDrawResult = DrawResult;

/** `#0a0908`, `render.ts`'s background fill, as float RGB. */
const BACKGROUND: [number, number, number] = [0x0a / 255, 0x09 / 255, 0x08 / 255];
/** `#15120f`, `render.ts`'s blank-cell fallback fill, as float RGB. */
const BLANK_FILL: [number, number, number] = [0x15 / 255, 0x12 / 255, 0x0f / 255];
/**
 * `render.ts`'s `FAVORITE_HOVER_GLOW_FILL`, as a flat quad - the fallback
 * used only when `gl/glowTexture.ts` has no offscreen canvas to bake with
 * (e.g. `npm test`'s Node environment, which never exercises a hover state
 * anyway); the real hover treatment is `drawGlow` below.
 */
const FAVORITE_HOVER_GLOW: [number, number, number, number] = [200 / 255, 169 / 255, 95 / 255, 0.28];

/**
 * Composite a hover-glow silhouette over a tile's full screen rect - `d`'s
 * coordinates are fractions of the WHOLE tile (see `gl/glowTexture.ts`'s
 * doc), so unlike every other textured quad in this file the destination is
 * `{sx, sy, cellPx.x, cellPx.y}`, not an icon's own smaller rect. Falls back
 * to the old flat-rect approximation over `fallbackRect` when no bake is
 * available, so a headless test environment still draws something.
 */
function drawGlow(
  gl: GLContext,
  glowTextures: GlowTextureCache,
  d: string | null,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  fallbackRect: Rect
): void {
  const glow = d ? glowTextures.get(gl.gl, d) : null;
  if (glow) {
    const rect: Rect = { x: sx, y: sy, w: cellPx.x, h: cellPx.y };
    gl.drawTexturedQuad(glow.texture, { x: 0, y: 0, w: glow.width, h: glow.height }, glow.width, glow.height, rect);
  } else {
    gl.drawFlatQuad(fallbackRect, FAVORITE_HOVER_GLOW);
  }
}
/** `render.ts`'s cursor-ring stroke color (`#e8e0d2`), as float RGBA. */
const CURSOR_STROKE: [number, number, number, number] = [232 / 255, 224 / 255, 210 / 255, 1];

/**
 * `render.ts`'s `drawGenericFade`, GL twin: the generic tile's paired distill
 * alternate, drawn as a textured quad at `fade` alpha over the base tile
 * already drawn beneath it - a real crossfade, not a flat overlay. Falls back
 * to a flat black quad when the alternate has no resident texture yet (or,
 * per `genericDistillId`'s doc, does not exist for this index), same "rule 1
 * does not apply here" fallback `drawFavoriteBadgeGL` uses. Shared with
 * `glSlideRenderer.ts` so a generic tile mid-slide gets the same treatment.
 */
export function drawGenericFadeGL(
  gl: GLContext,
  cache: TileCache,
  textures: GLTextureCache,
  distillId: RoomId,
  fade: number,
  dst: Rect
): void {
  if (fade <= 0) return;
  const alpha = Math.min(1, fade);
  const hit = cache.get(distillId, 0);
  const tex = hit ? textures.get(gl, hit.img) : null;
  if (hit && tex) {
    const src: Rect = hit.rect ? toGLRect(hit.rect) : { x: 0, y: 0, w: tex.width, h: tex.height };
    gl.drawTexturedQuad(tex.texture, src, tex.width, tex.height, dst, alpha);
  } else {
    gl.drawFlatQuad(dst, [0, 0, 0, alpha]);
  }
}

/**
 * The favorite badge, if its art has landed - same "rule 1 does not apply
 * here" as `render.ts`'s own `drawFavoriteBadge`: a badge with no resident
 * texture yet simply does not draw.
 */
/** Shared with `glSlideRenderer.ts` - the badge rides along with a sliding tile exactly as `render.ts`'s `drawFavoriteBadge` does with `slide.ts`. */
export function drawFavoriteBadgeGL(
  gl: GLContext,
  cache: TileCache,
  textures: GLTextureCache,
  isFavorite: boolean,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  hovered: boolean,
  glowTextures: GlowTextureCache
): void {
  const hit = cache.get(isFavorite ? FAV_ON : FAV_OFF, 0);
  const tex = hit ? textures.get(gl, hit.img) : null;
  if (!hit || !tex) return;
  const iconSize = hit.rect ? { w: hit.rect.sw, h: hit.rect.sh } : { w: tex.width, h: tex.height };
  const rect: Rect = favoriteIconScreenRect(cellPx, sx, sy, iconSize);
  const src = hit.rect
    ? toGLRect(hit.rect)
    : { x: 0, y: 0, w: tex.width, h: tex.height };
  gl.drawTexturedQuad(tex.texture, src, tex.width, tex.height, rect);
  if (hovered) drawGlow(gl, glowTextures, FAVORITE_TOGGLE_PATH, cellPx, sx, sy, rect);
}

/**
 * The favorites-sort switch on the center tile: the base plate, always drawn
 * once favorites are enabled, plus whichever "on" face matches the active
 * sort - mirrors `render.ts`'s `drawFavoriteSwitch`, one textured quad per
 * piece rather than a shared rect (see that function's doc for why the three
 * pieces aren't forced into one size). Shared with `glSlideRenderer.ts` -
 * the center tile is the rearrangement's fixed tile, so the switch must keep
 * drawing across the handoff between renderers.
 */
export function drawFavoriteSwitchGL(
  gl: GLContext,
  cache: TileCache,
  textures: GLTextureCache,
  sortMode: SortMode,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number
): void {
  const draw = (id: RoomId) => {
    const hit = cache.get(id, 0);
    const tex = hit ? textures.get(gl, hit.img) : null;
    if (!hit || !tex) return;
    const iconSize = hit.rect ? { w: hit.rect.sw, h: hit.rect.sh } : { w: tex.width, h: tex.height };
    const rect: Rect = favoriteSwitchScreenRect(cellPx, sx, sy, iconSize);
    const src: Rect = hit.rect
      ? toGLRect(hit.rect)
      : { x: 0, y: 0, w: tex.width, h: tex.height };
    gl.drawTexturedQuad(tex.texture, src, tex.width, tex.height, rect);
  };
  draw(FAV_CENTER_SWITCH_BASE);
  if (sortMode === 'mine') draw(FAV_MINE_ON);
  else if (sortMode === 'count') draw(FAV_COUNT_ON);
}

/**
 * The center tile's distill toggle - mirrors `render.ts`'s
 * `drawDistillToggle`, same flat-rect hover approximation as
 * `drawFavoriteBadgeGL` (see this file's doc). Shared with
 * `glSlideRenderer.ts`, same reason as `drawFavoriteSwitchGL`.
 */
export function drawDistillToggleGL(
  gl: GLContext,
  cache: TileCache,
  textures: GLTextureCache,
  distillMode: boolean,
  hovered: boolean,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  glowTextures: GlowTextureCache
): void {
  const id = distillMode ? DISTILL_ON : DISTILL_OFF;
  const hit = cache.get(id, 0);
  const tex = hit ? textures.get(gl, hit.img) : null;
  if (!hit || !tex) return;
  const iconSize = hit.rect ? { w: hit.rect.sw, h: hit.rect.sh } : { w: tex.width, h: tex.height };
  const rect: Rect = distillIconScreenRect(cellPx, sx, sy, iconSize);
  const src: Rect = hit.rect
    ? toGLRect(hit.rect)
    : { x: 0, y: 0, w: tex.width, h: tex.height };
  gl.drawTexturedQuad(tex.texture, src, tex.width, tex.height, rect);
  if (hovered) {
    const activePath = distillMode ? DISTILL_ON_PATH : DISTILL_OFF_PATH;
    drawGlow(gl, glowTextures, activePath, cellPx, sx, sy, rect);
  }
}

/**
 * The "forget searches" book's black spine overlay - mirrors `render.ts`'s
 * `drawClearHistoryBookOverlay`, no hover treatment (the book's own hover
 * glow comes from `composeSpines`/the spine texture, drawn on top of this).
 * Shared with `glSlideRenderer.ts`, same reason as `drawFavoriteSwitchGL`.
 */
export function drawClearHistoryBookOverlayGL(
  gl: GLContext,
  cache: TileCache,
  textures: GLTextureCache,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number
): void {
  const hit = cache.get(CLEAR_HISTORY_BOOK, 0);
  const tex = hit ? textures.get(gl, hit.img) : null;
  if (!hit || !tex) return;
  const iconSize = hit.rect ? { w: hit.rect.sw, h: hit.rect.sh } : { w: tex.width, h: tex.height };
  const rect: Rect = clearHistoryBookScreenRect(cellPx, sx, sy, iconSize);
  const src: Rect = hit.rect
    ? toGLRect(hit.rect)
    : { x: 0, y: 0, w: tex.width, h: tex.height };
  gl.drawTexturedQuad(tex.texture, src, tex.width, tex.height, rect);
}

export function createGLRenderer({
  cache, pyramid = PYRAMID, textures = createGLTextureCache(), glowTextures = createGlowTextureCache(),
}: CreateGLRendererOpts) {
  let level: number | null = null;
  const spineTextures: SpineTextureCache = createSpineTextureCache();

  function draw({
    gl, width: w, height: h, dpr, cam, layout, order, genericFade = 0,
    favorites = null, hoveredFavorite = null,
    centreSlots = null, hoveredBook = null, spineFontLimits = null,
    sortMode = 'relevance', distillMode, hoveredDistill = false, cursor = null, loadingFrame = null,
  }: GLDrawOpts): GLDrawResult {
    cache.beginFrame();
    textures.beginFrame();
    gl.resize(w, h, dpr);
    gl.clear(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);

    const { x: cx, y: cy, zoom } = cam;
    // Device pixels throughout - unlike `render.ts`'s `ctx.setTransform(dpr,
    // ...)` trick, there is no implicit pixel-ratio scale here, so every rect
    // handed to a draw call is already in the units `gl.resize()`'s viewport
    // uses.
    const cellPxCss = pxPerCell(cam);
    const cellPx = { x: cellPxCss.x * dpr, y: cellPxCss.y * dpr };
    const wDev = w * dpr;
    const hDev = h * dpr;
    const halfW = wDev / 2 / cellPx.x;
    const halfH = hDev / 2 / cellPx.y;
    const bounds: Bounds = {
      x0: Math.floor(cx - halfW), x1: Math.ceil(cx + halfW),
      y0: Math.floor(cy - halfH), y1: Math.ceil(cy + halfH),
    };

    level = pyramid.pickLevel({ w: cellPx.x, h: cellPx.y }, level);

    const toScreen = (wx: number, wy: number): [number, number] =>
      [(wx - cx) * cellPx.x + wDev / 2, (wy - cy) * cellPx.y + hDev / 2];
    const cw = cellPx.x + dpr;
    const ch = cellPx.y + dpr;

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
        const dst = { x: sx, y: sy, w: cw, h: ch };
        const distillId = cell.generic ? genericDistillId(layout.genericIndexAt(gx, gy)) : null;

        if (cell.generic && genericFade >= 1) {
          drawGenericFadeGL(gl, cache, textures, distillId!, genericFade, dst);
        } else {
          const hit = cache.get(id, level);
          const tex = hit ? textures.get(gl, hit.img) : null;

          if (hit && tex) {
            const src = hit.rect
              ? toGLRect(hit.rect)
              : { x: 0, y: 0, w: tex.width, h: tex.height };
            gl.drawTexturedQuad(tex.texture, src, tex.width, tex.height, dst);
            drawn++;
            if (hit.level !== level) substituted++;
          } else {
            // Rule 1's floor - same as `render.ts`: reachable before the
            // generic itself has loaded, or (a GL-specific extra case) before
            // its `ImageBitmap` has an uploaded texture yet.
            gl.drawFlatQuad(dst, [BLANK_FILL[0], BLANK_FILL[1], BLANK_FILL[2], 1]);
            blank++;
          }

          if (cell.generic && genericFade)
            drawGenericFadeGL(gl, cache, textures, distillId!, genericFade, dst);
        }

        // The favorite badge - every real room, never the center or a
        // generic cell, same gate as `render.ts`.
        if (favorites && !cell.center && !cell.generic) {
          const hovered = hoveredFavorite != null && hoveredFavorite.x === gx && hoveredFavorite.y === gy;
          drawFavoriteBadgeGL(gl, cache, textures, favorites.isFavorite(cell.id), cellPx, sx, sy, hovered, glowTextures);
        }

        // The "forget searches" book's black spine overlay - same gate as
        // `render.ts`, drawn before the spine texture so the gilt text still
        // composites on top.
        if (cell.center && centreSlots?.[BOOK_COUNT - 1]?.action === 'forgetHistory')
          drawClearHistoryBookOverlayGL(gl, cache, textures, cellPx, sx, sy);

        // The center room's spines - a separately-cached texture
        // (`gl/spineTexture.ts`) rather than text drawn straight into this
        // frame, same content-gated re-render `composeSpines` itself already
        // does for legibility (`areSpinesLegible`, called inside it).
        if (cell.center && centreSlots && spineFontLimits) {
          const spine = spineTextures.get(gl.gl, cw, ch, centreSlots, hoveredBook, spineFontLimits);
          if (spine) gl.drawTexturedQuad(spine.texture, { x: 0, y: 0, w: spine.width, h: spine.height }, spine.width, spine.height, dst);
        }
        // The favorites-sort switch - same gate as `render.ts`: only once a
        // favorite store exists and the tile is zoomed in enough to read.
        // `areSpinesLegible` only reads the rect's width, so the CSS-pixel
        // `cellPxCss` (not the device-pixel `cellPx` used to draw) is what
        // keeps the threshold matching `render.ts`'s own gate.
        if (cell.center && favorites && areSpinesLegible({ x: 0, y: 0, w: cellPxCss.x, h: cellPxCss.y }))
          drawFavoriteSwitchGL(gl, cache, textures, sortMode, cellPx, sx, sy);
        // The distill toggle - independent of `favorites`, same `undefined`
        // opt-out as `render.ts`.
        if (cell.center && distillMode !== undefined)
          drawDistillToggleGL(gl, cache, textures, distillMode, hoveredDistill, cellPx, sx, sy, glowTextures);
        // The loading indicator's current frame - the WebGL counterpart of
        // `render.ts`'s `drawLoadingFrame`. Same disjoint region, same last-in
        // ordering; the sheet uploads through the ordinary texture cache.
        if (cell.center && loadingFrame) {
          const tex = textures.get(gl, loadingFrame.image);
          if (tex) {
            const r = loadingFrame.rect;
            gl.drawTexturedQuad(
              tex.texture,
              { x: loadingFrame.src.x, y: loadingFrame.src.y, w: loadingFrame.src.w, h: loadingFrame.src.h },
              tex.width, tex.height,
              { x: sx + r.x * cellPx.x, y: sy + r.y * cellPx.y, w: r.w * cellPx.x, h: r.h * cellPx.y }
            );
          }
        }
      }
    }

    // Same "rule 2" as `render.ts`: prefetch the ring, then warm one level
    // coarser - pure cache calls, no drawing, unchanged from the 2D path.
    const ring = prefetchBounds(bounds);
    for (let gy = ring.y0; gy <= ring.y1; gy++)
      for (let gx = ring.x0; gx <= ring.x1; gx++) {
        const inside =
          gx >= bounds.x0 && gx <= bounds.x1 && gy >= bounds.y0 && gy <= bounds.y1;
        if (inside) continue;
        cache.prefetch(idOf(layout.roomAt(gx, gy, order), layout, gx, gy), level);
      }
    for (const coarser of pyramid.warmLevels(level))
      for (const id of visible) cache.prefetch(id, coarser);

    // The keyboard cursor's ring - drawn LAST, over everything, same gate as
    // `render.ts`'s own draw. `drawStrokeQuad` strokes inside the given rect
    // rather than centering on its path like `strokeRect` does, so this is a
    // visual approximation of `render.ts`'s inset+lineWidth combination, not
    // a pixel-identical stroke.
    const cells = (bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1);
    if (cursor && cursor.x >= bounds.x0 && cursor.x <= bounds.x1
      && cursor.y >= bounds.y0 && cursor.y <= bounds.y1) {
      const [sx, sy] = toScreen(cursor.x, cursor.y);
      gl.drawStrokeQuad(
        { x: sx + 2 * dpr, y: sy + 2 * dpr, w: cellPx.x - 4 * dpr, h: cellPx.y - 4 * dpr },
        3 * dpr,
        CURSOR_STROKE
      );
    }

    return { cells, drawn, substituted, blank, level, bounds, zoom };
  }

  return { draw, textures, spineTextures, glowTextures };
}
