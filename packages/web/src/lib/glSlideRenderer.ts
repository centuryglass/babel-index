/**
 * Spike: the WebGL counterpart of `slide.ts`'s `createSlideRenderer`.
 *
 * Mirrors `slide.ts`'s own per-cell paint (still field, then each line in
 * motion extended by its travel, then the prefetch ring) using
 * `gl/context.ts`'s quad primitives instead of `CanvasRenderingContext2D`
 * calls. `packages/map/board.ts`/`moves.ts`'s `Board`/`Motion`/`applyMove`
 * are consumed completely unmodified - `createSlideshow`'s `advanceTo()`
 * output feeds this renderer exactly as it feeds `slide.ts`, only the final
 * paint step differs.
 *
 * `GLSlideDrawOpts` is `slide.ts`'s own `SlideDrawOpts` with `ctx:
 * DrawContext` swapped for `gl: GLContext`, and `GLSlideDrawResult` is
 * literally `SlideDrawResult` - same "derive, don't restate" approach as
 * `glRenderer.ts`.
 *
 * Same known gaps as `glRenderer.ts` at this point in the spike: no
 * favorites-sort switch, no distill toggle, no clear-history overlay (all
 * center-tile "chrome", never drawn during a slide by the Canvas2D path
 * either until it lands - see `slide.ts`'s own `chrome` block). Spine text
 * is a non-issue here: `slide.ts` draws none during a rearrangement, so
 * neither does this file.
 */
import { PYRAMID, type Pyramid } from './pyramid.ts';
import { pxPerCell } from './camera.ts';
import { CENTER, genericId, type RoomId, type TileCache } from './tiles.ts';
import { CENTER as BOARD_CENTER, GENERIC as BOARD_GENERIC } from '../../../map/board.ts';
import type { BoardValue } from '../../../map/moves.ts';
import type { GLContext, Rect } from './gl/context.ts';
import { createGLTextureCache, type GLTextureCache } from './gl/textureCache.ts';
import { drawFavoriteBadgeGL } from './glRenderer.ts';
import type { SlideDrawOpts, SlideDrawResult } from './slide.ts';

/** Same cache-id rule as `slide.ts`'s own (unexported) `idFor` - duplicated rather than imported so this file changes nothing about `slide.ts`. */
const idFor = (
  value: BoardValue,
  homeMx: number,
  homeMy: number,
  genericIndexAt: (x: number, y: number) => number
): RoomId =>
  value === BOARD_CENTER
    ? CENTER
    : value === BOARD_GENERIC
      ? genericId(genericIndexAt(homeMx, homeMy))
      : value;

export interface CreateGLSlideRendererOpts {
  cache: TileCache;
  pyramid?: Pyramid;
  /** Shared with `glRenderer.ts` so a tile decoded for one is already resident for the other. */
  textures?: GLTextureCache;
}

/** `slide.ts`'s `SlideDrawOpts` with the 2D context swapped for a GL one. */
export type GLSlideDrawOpts = Omit<SlideDrawOpts, 'ctx'> & { gl: GLContext };

export type GLSlideDrawResult = SlideDrawResult;

const BACKGROUND: [number, number, number] = [0x0a / 255, 0x09 / 255, 0x08 / 255];
const BLANK_FILL: [number, number, number] = [0x15 / 255, 0x12 / 255, 0x0f / 255];

export function createGLSlideRenderer({ cache, pyramid = PYRAMID, textures = createGLTextureCache() }: CreateGLSlideRendererOpts) {
  function draw({
    gl, width: w, height: h, dpr, cam, board, origin, motions = [], genericIndexAt = () => -1,
    favorites = null, genericFade = 0,
  }: GLSlideDrawOpts): GLSlideDrawResult {
    cache.beginFrame();
    textures.beginFrame();
    gl.resize(w, h, dpr);
    gl.clear(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);

    const cellPxCss = pxPerCell(cam);
    const cellPx = { x: cellPxCss.x * dpr, y: cellPxCss.y * dpr };
    const level = pyramid.pickLevel({ w: cellPx.x, h: cellPx.y }, null);

    const wDev = w * dpr;
    const hDev = h * dpr;
    const halfW = wDev / 2 / cellPx.x;
    const halfH = hDev / 2 / cellPx.y;
    const x0 = Math.floor(cam.x - halfW);
    const x1 = Math.ceil(cam.x + halfW);
    const y0 = Math.floor(cam.y - halfH);
    const y1 = Math.ceil(cam.y + halfH);

    const W = board.width;
    const H = board.height;
    const valueAt = (bx: number, by: number): BoardValue =>
      board.cells[(((by % H) + H) % H) * W + (((bx % W) + W) % W)];
    const cw = cellPx.x + dpr;
    const ch = cellPx.y + dpr;

    let drawn = 0;
    let blank = 0;
    const wanted: RoomId[] = [];

    const paint = (value: BoardValue, homeMx: number, homeMy: number, drawMx: number, drawMy: number): void => {
      const sx = (drawMx - cam.x) * cellPx.x + wDev / 2;
      const sy = (drawMy - cam.y) * cellPx.y + hDev / 2;
      const dst = { x: sx, y: sy, w: cw, h: ch };
      const id = idFor(value, homeMx, homeMy, genericIndexAt);

      if (value === BOARD_GENERIC && genericFade >= 1) {
        gl.drawFlatQuad(dst, [0, 0, 0, Math.min(1, genericFade)]);
        wanted.push(id);
        return;
      }
      const hit = cache.get(id, level);
      const tex = hit ? textures.get(gl, hit.img) : null;
      if (hit && tex) {
        const src: Rect = hit.rect
          ? { x: hit.rect.sx, y: hit.rect.sy, w: hit.rect.sw, h: hit.rect.sh }
          : { x: 0, y: 0, w: tex.width, h: tex.height };
        gl.drawTexturedQuad(tex.texture, src, tex.width, tex.height, dst);
        drawn++;
      } else {
        gl.drawFlatQuad(dst, [BLANK_FILL[0], BLANK_FILL[1], BLANK_FILL[2], 1]);
        blank++;
      }
      if (value === BOARD_GENERIC && genericFade)
        gl.drawFlatQuad(dst, [0, 0, 0, Math.min(1, genericFade)]);
      if (favorites && typeof value === 'number')
        drawFavoriteBadgeGL(gl, cache, textures, favorites.isFavorite(value), cellPx, sx, sy, false);
      wanted.push(id);
    };

    const movingRows = new Set<number>();
    const movingCols = new Set<number>();
    for (const m of motions)
      (m.kind === 'row' ? movingRows : movingCols).add(
        m.kind === 'row' ? m.index - origin.y : m.index - origin.x
      );
    for (let my = y0; my <= y1; my++)
      for (let mx = x0; mx <= x1; mx++) {
        if (movingRows.has(my) || movingCols.has(mx)) continue;
        paint(valueAt(mx + origin.x, my + origin.y), mx, my, mx, my);
      }

    for (const m of motions) {
      const shift = m.offset * m.dir;
      const pad = Math.ceil(Math.abs(shift)) + 1;
      if (m.kind === 'row')
        for (let mx = x0 - pad; mx <= x1 + pad; mx++)
          paint(valueAt(mx + origin.x, m.index), mx, m.index - origin.y, mx + shift, m.index - origin.y);
      else
        for (let my = y0 - pad; my <= y1 + pad; my++)
          paint(valueAt(m.index, my + origin.y), m.index - origin.x, my, m.index - origin.x, my + shift);
    }

    for (let my = y0 - 2; my <= y1 + 2; my++)
      for (let mx = x0 - 2; mx <= x1 + 2; mx++)
        if (my < y0 || my > y1 || mx < x0 || mx > x1)
          cache.prefetch(idFor(valueAt(mx + origin.x, my + origin.y), mx, my, genericIndexAt), level);

    return { drawn, blank, level, cells: wanted.length };
  }

  return { draw, textures };
}
