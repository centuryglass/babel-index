/**
 * The WebGL rearrangement renderer: `slidePlan.ts` decides the frame, and
 * `glRenderer.ts`'s `paintGL` draws it. `createSlideshow`'s `advanceTo()`
 * output (`slide.ts`) feeds this renderer as it feeds `slide.ts`'s.
 *
 * Spine text is not drawn here, because `slidePlan.ts` plans none during a
 * rearrangement.
 */
import { createGLTextureCache, type GLTextureCache } from './gl/textureCache.ts';
import { createGlowTextureCache, type GlowTextureCache } from './gl/glowTexture.ts';
import type { GLContext } from './gl/context.ts';
import { BACKGROUND, paintGL } from './glRenderer.ts';
import { createSlidePlanner, type SlideDrawResult, type SlideFrameOpts } from './slidePlan.ts';
import type { TileCache } from './tiles.ts';
import type { Pyramid } from './pyramid.ts';
import type { Overlays } from '../../../map/overlays.ts';

export interface CreateGLSlideRendererOpts {
  cache: TileCache;
  /** `manifest.overlays` - see `framePlan.ts`'s `CreateMapPlannerOpts`. */
  overlays: Overlays;
  pyramid?: Pyramid;
  /** Shared with `glRenderer.ts` so a tile decoded for one is already resident for the other. */
  textures?: GLTextureCache;
  /** Shared with `glRenderer.ts`, same reason as `textures` - the distill toggle's hover glow rides along across the handoff too. */
  glowTextures?: GlowTextureCache;
}

/** `slidePlan.ts`'s `SlideFrameOpts` plus the GL context to paint on. */
export type GLSlideDrawOpts = SlideFrameOpts & { gl: GLContext };

export type GLSlideDrawResult = SlideDrawResult;

export function createGLSlideRenderer({
  cache, overlays, pyramid, textures = createGLTextureCache(), glowTextures = createGlowTextureCache(),
}: CreateGLSlideRendererOpts) {
  const planner = createSlidePlanner({ cache, overlays, pyramid });

  function draw({ gl, ...opts }: GLSlideDrawOpts): GLSlideDrawResult {
    const result = planner.plan(opts);
    textures.beginFrame();
    gl.resize(opts.width, opts.height, opts.dpr);
    gl.clear(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    const loss = paintGL(gl, planner.list, { textures, glowTextures });
    result.drawn -= loss.drawn + loss.substituted;
    result.blank += loss.drawn + loss.substituted;
    return result;
  }

  return { draw, textures, glowTextures };
}
