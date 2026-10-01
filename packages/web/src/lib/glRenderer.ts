/**
 * The WebGL map renderer: `framePlan.ts` decides the frame, and `paintGL`
 * draws its `DrawList` with `gl/context.ts`'s quad primitives. One draw call
 * per item, no instancing. `glSlideRenderer.ts` paints with `paintGL` too.
 *
 * The painter resolves each image item through `gl/textureCache.ts`, the GPU
 * side's own cache. An item whose texture has not uploaded yet draws its
 * fallback fill, if it has one, and a cell lost that way is reported back so
 * the frame's stats count it blank.
 *
 * Two primitives are baked to textures rather than drawn per frame, keyed so
 * they re-render only on change: the hover glow's traced silhouette
 * (`gl/glowTexture.ts`, by path string) and the center tile's spine titles
 * (`gl/spineTexture.ts`, by content, hover and size).
 */
import { HOVER_GLOW_RGB } from './cssVars.ts';
import type { GLContext, Rect } from './gl/context.ts';
import { createGLTextureCache, type GLTextureCache } from './gl/textureCache.ts';
import { createSpineTextureCache, type SpineTextureCache } from './gl/spineTexture.ts';
import { createGlowTextureCache, type GlowTextureCache } from './gl/glowTexture.ts';
import { assertNever, type DrawList } from './drawList.ts';
import { createMapPlanner, type DrawResult, type MapFrameOpts } from './framePlan.ts';
import type { TileCache } from './tiles.ts';
import type { Pyramid } from './pyramid.ts';

export interface CreateGLRendererOpts {
  cache: TileCache;
  pyramid?: Pyramid;
  /** Shared with `glSlideRenderer.ts` so a tile decoded for one renderer is already resident for the other across the handoff. */
  textures?: GLTextureCache;
  /** Shared with `glSlideRenderer.ts`, same reason as `textures` - the toggle glows must survive the handoff too. */
  glowTextures?: GlowTextureCache;
}

/** `framePlan.ts`'s `MapFrameOpts` plus the GL context to paint on. */
export type GLDrawOpts = MapFrameOpts & { gl: GLContext };

export type GLDrawResult = DrawResult;

/**
 * The GL clear colour, `#0a0908`, shared with `glSlideRenderer.ts`. Every
 * cell paints over it (see `createMapPlanner`), so it shows only where a
 * frame leaves a gap.
 */
export const BACKGROUND: [number, number, number] = [0x0a / 255, 0x09 / 255, 0x08 / 255];

/**
 * `cssVars.ts`'s `HOVER_GLOW_RGB`, as a flat quad. Used only when
 * `gl/glowTexture.ts` has no offscreen canvas to bake with - a headless
 * environment such as `npm test`, which never exercises a hover state
 * anyway. The real treatment is the baked silhouette.
 */
const FLAT_HOVER_GLOW: [number, number, number, number] = [
  HOVER_GLOW_RGB[0] / 255, HOVER_GLOW_RGB[1] / 255, HOVER_GLOW_RGB[2] / 255, 0.28,
];

/** The textures `paintGL` resolves items through. */
export interface GLPaintResources {
  textures: GLTextureCache;
  glowTextures: GlowTextureCache;
  /** Only the map renderer plans spines; a list with a spines item needs this. */
  spineTextures?: SpineTextureCache;
}

/** Cell images `paintGL` could not draw, by the `CellStat` they were planned with. */
export interface GLPaintLoss {
  drawn: number;
  substituted: number;
}

/**
 * Paint a planned frame with GL quads, in list order. The list's CSS-pixel
 * rects are scaled by its `dpr` here: a shader has no implicit pixel-ratio
 * scale (`gl/context.ts`). The caller has already resized and cleared.
 */
export function paintGL(gl: GLContext, list: DrawList, res: GLPaintResources): GLPaintLoss {
  const { dpr } = list;
  const loss: GLPaintLoss = { drawn: 0, substituted: 0 };
  // Reused for every destination: `gl/context.ts` reads a rect only during
  // the call it is passed to.
  const dst: Rect = { x: 0, y: 0, w: 0, h: 0 };
  const scaled = (r: Rect): Rect => {
    dst.x = r.x * dpr;
    dst.y = r.y * dpr;
    dst.w = r.w * dpr;
    dst.h = r.h * dpr;
    return dst;
  };

  for (let i = 0; i < list.length; i++) {
    const item = list.items[i];
    switch (item.kind) {
      case 'image': {
        const tex = res.textures.get(gl, item.source);
        if (tex) {
          const src = item.whole ? { x: 0, y: 0, w: tex.width, h: tex.height } : item.src;
          gl.drawTexturedQuad(tex.texture, src, tex.width, tex.height, scaled(item.dst), item.alpha);
          break;
        }
        // The decode landed but the upload has not (or the image is past
        // `maxTextureSize`): the planned fallback stands in for it.
        if (item.fallback) {
          const [r, g, b] = item.fallback.rgb;
          gl.drawFlatQuad(scaled(item.dst), [r, g, b, item.alpha]);
        }
        if (item.stat === 'drawn') loss.drawn++;
        else if (item.stat === 'substituted') loss.substituted++;
        break;
      }
      case 'fill': {
        const [r, g, b] = item.color.rgb;
        gl.drawFlatQuad(scaled(item.dst), [r, g, b, item.alpha]);
        break;
      }
      case 'stroke': {
        const [r, g, b] = item.color.rgb;
        gl.drawStrokeQuad(scaled(item.dst), item.width * dpr, [r, g, b, 1]);
        break;
      }
      case 'glow': {
        // The path's coordinates are fractions of the whole tile, so a baked
        // glow covers the cell rect, not the icon's own smaller one.
        const glow = res.glowTextures.get(gl.gl, item.path);
        if (glow)
          gl.drawTexturedQuad(glow.texture, { x: 0, y: 0, w: glow.width, h: glow.height }, glow.width, glow.height, scaled(item.cell));
        else gl.drawFlatQuad(scaled(item.fallback), FLAT_HOVER_GLOW);
        break;
      }
      case 'spines': {
        const rect = scaled(item.dst);
        const spine = res.spineTextures?.get(gl.gl, rect.w, rect.h, item.slots, item.hoveredBook, item.limits);
        if (spine) gl.drawTexturedQuad(spine.texture, { x: 0, y: 0, w: spine.width, h: spine.height }, spine.width, spine.height, rect);
        break;
      }
      default:
        assertNever(item);
    }
  }
  return loss;
}

export function createGLRenderer({
  cache, pyramid, textures = createGLTextureCache(), glowTextures = createGlowTextureCache(),
}: CreateGLRendererOpts) {
  const planner = createMapPlanner({ cache, pyramid });
  const spineTextures: SpineTextureCache = createSpineTextureCache();

  function draw({ gl, ...opts }: GLDrawOpts): GLDrawResult {
    const result = planner.plan(opts);
    textures.beginFrame();
    gl.resize(opts.width, opts.height, opts.dpr);
    gl.clear(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    const loss = paintGL(gl, planner.list, { textures, glowTextures, spineTextures });
    result.drawn -= loss.drawn + loss.substituted;
    result.substituted -= loss.substituted;
    result.blank += loss.drawn + loss.substituted;
    return result;
  }

  return { draw, textures, spineTextures, glowTextures };
}
