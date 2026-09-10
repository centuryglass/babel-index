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
 * `drawFavoriteBadgeGL` below. Its hover highlight is a flat translucent
 * rectangle over the badge's bounding box, not the traced silhouette
 * `render.ts`'s `drawFavoriteBadge` fills/strokes - an approximation, not
 * pixel-identical, per the plan's known gaps (no vector-path rendering here).
 *
 * The center tile's spine text is a separately-cached texture
 * (`gl/spineTexture.ts`, re-rendering `composeSpines` onto an offscreen 2D
 * canvas only when its content/hover/size key changes) drawn as one quad
 * over the center cell.
 *
 * NOT yet implemented (later steps in the spike plan): the favorites-sort
 * switch, the distill toggle, the clear-history overlay, and the
 * keyboard-cursor ring (no stroke-quad primitive exists yet - see
 * `gl/context.ts`). The rank-label chrome (`render.ts`'s `drawChrome`) has
 * no text-rendering path in this spike at all and is left out rather than
 * faked - see the plan's known gaps.
 */
import { PYRAMID, prefetchBounds, type Bounds, type Pyramid } from './pyramid.ts';
import { pxPerCell, type Camera } from './camera.ts';
import { CENTER, FAV_ON, FAV_OFF, genericId, type RoomId, type TileCache } from './tiles.ts';
import { favoriteIconScreenRect } from './favoriteBadge.ts';
import type { GLContext, Rect } from './gl/context.ts';
import { createGLTextureCache, type GLTextureCache } from './gl/textureCache.ts';
import { createSpineTextureCache, type SpineTextureCache } from './gl/spineTexture.ts';
import type { DrawOpts, DrawResult } from './render.ts';
import type { MapLayout, RoomAtResult } from '../../../map/ordering.ts';

/** Same cache-id rule as `render.ts`'s own (unexported) `idOf` - duplicated rather than imported so this file changes nothing about `render.ts`. */
const idOf = (cell: RoomAtResult, layout: MapLayout, gx: number, gy: number): RoomId =>
  cell.center ? CENTER : cell.generic ? genericId(layout.genericIndexAt(gx, gy)) : cell.id;

export interface CreateGLRendererOpts {
  cache: TileCache;
  pyramid?: Pyramid;
  /** Shared across `glRenderer.ts`/`glSlideRenderer.ts` so a tile decoded for one is already resident for the other. */
  textures?: GLTextureCache;
}

/** `render.ts`'s `DrawOpts` with the 2D context swapped for a GL one. */
export type GLDrawOpts = Omit<DrawOpts, 'ctx'> & { gl: GLContext };

export type GLDrawResult = DrawResult;

/** `#0a0908`, `render.ts`'s background fill, as float RGB. */
const BACKGROUND: [number, number, number] = [0x0a / 255, 0x09 / 255, 0x08 / 255];
/** `#15120f`, `render.ts`'s blank-cell fallback fill, as float RGB. */
const BLANK_FILL: [number, number, number] = [0x15 / 255, 0x12 / 255, 0x0f / 255];
/** `render.ts`'s `FAVORITE_HOVER_GLOW_FILL` (`rgba(200,169,95,0.28)`), as a flat quad rather than the traced silhouette - see this file's doc. */
const FAVORITE_HOVER_GLOW: [number, number, number, number] = [200 / 255, 169 / 255, 95 / 255, 0.28];

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
  hovered: boolean
): void {
  const hit = cache.get(isFavorite ? FAV_ON : FAV_OFF, 0);
  const tex = hit ? textures.get(gl, hit.img) : null;
  if (!hit || !tex) return;
  const iconSize = hit.rect ? { w: hit.rect.sw, h: hit.rect.sh } : { w: tex.width, h: tex.height };
  const rect: Rect = favoriteIconScreenRect(cellPx, sx, sy, iconSize);
  const src = hit.rect
    ? { x: hit.rect.sx, y: hit.rect.sy, w: hit.rect.sw, h: hit.rect.sh }
    : { x: 0, y: 0, w: tex.width, h: tex.height };
  gl.drawTexturedQuad(tex.texture, src, tex.width, tex.height, rect);
  if (hovered) gl.drawFlatQuad(rect, FAVORITE_HOVER_GLOW);
}

export function createGLRenderer({ cache, pyramid = PYRAMID, textures = createGLTextureCache() }: CreateGLRendererOpts) {
  let level: number | null = null;
  const spineTextures: SpineTextureCache = createSpineTextureCache();

  function draw({
    gl, width: w, height: h, dpr, cam, layout, order, genericFade = 0,
    favorites = null, hoveredFavorite = null,
    centreSlots = null, hoveredBook = null, spineFontLimits = null,
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

        if (cell.generic && genericFade >= 1) {
          gl.drawFlatQuad(dst, [0, 0, 0, Math.min(1, genericFade)]);
        } else {
          const hit = cache.get(id, level);
          const tex = hit ? textures.get(gl, hit.img) : null;

          if (hit && tex) {
            const src = hit.rect
              ? { x: hit.rect.sx, y: hit.rect.sy, w: hit.rect.sw, h: hit.rect.sh }
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
            gl.drawFlatQuad(dst, [0, 0, 0, Math.min(1, genericFade)]);
        }

        // The favorite badge - every real room, never the center or a
        // generic cell, same gate as `render.ts`.
        if (favorites && !cell.center && !cell.generic) {
          const hovered = hoveredFavorite != null && hoveredFavorite.x === gx && hoveredFavorite.y === gy;
          drawFavoriteBadgeGL(gl, cache, textures, favorites.isFavorite(cell.id), cellPx, sx, sy, hovered);
        }

        // The center room's spines - a separately-cached texture
        // (`gl/spineTexture.ts`) rather than text drawn straight into this
        // frame, same content-gated re-render `composeSpines` itself already
        // does for legibility (`areSpinesLegible`, called inside it).
        if (cell.center && centreSlots && spineFontLimits) {
          const spine = spineTextures.get(gl.gl, cw, ch, centreSlots, hoveredBook, spineFontLimits);
          if (spine) gl.drawTexturedQuad(spine.texture, { x: 0, y: 0, w: spine.width, h: spine.height }, spine.width, spine.height, dst);
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

    const cells = (bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1);
    return { cells, drawn, substituted, blank, level, bounds, zoom };
  }

  return { draw, textures, spineTextures };
}
