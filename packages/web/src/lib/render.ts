/**
 * The Canvas2D map renderer: `framePlan.ts` decides the frame, and
 * `paintCanvas2D` draws its `DrawList` onto a 2d context. No React, no DOM
 * lookups, no event handlers, so `render.test.ts` asserts a whole frame
 * against a recording context.
 *
 * `paintCanvas2D` makes no decisions, and `slide.ts` paints with it too. The
 * context carries the device pixel ratio in its transform
 * (`useMapRenderer.ts`), so the list's CSS-pixel rects go in as they are.
 */
import { composeSpines, type SpineContext } from './center.ts';
import { HOVER_GLOW_FILL, HOVER_GLOW_STROKE } from './cssVars.ts';
import { tracePathCommands } from './svgPath.ts';
import { assertNever, type DrawList } from './drawList.ts';
import { createMapPlanner, type DrawResult, type MapFrameOpts } from './framePlan.ts';
import type { Drawable, TileCache } from './tiles.ts';
import type { Overlays } from '../../../map/overlays.ts';

export type { DrawResult };

/**
 * The 2d-context surface this file calls - the whole `CanvasRenderingContext2D`
 * narrowed to what a frame uses, so `render.test.ts`'s recording fake implements
 * only the calls it records. A real context satisfies this structurally, so
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
  /** 0-1. Set for a translucent item (distill mode's crossfade) and restored to 1 after. */
  globalAlpha: number;
  /**
   * Whether `drawImage` bilinearly filters. Set per frame from the list's
   * `smoothing` - see `framePlan.ts`'s `SMOOTHING_MAX_DOWNSCALE`.
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

export interface CreateRendererOpts {
  cache: TileCache;
  /** `manifest.overlays` - see `framePlan.ts`'s `CreateMapPlannerOpts`. */
  overlays: Overlays;
}

/** `framePlan.ts`'s `MapFrameOpts` plus the context to paint on. */
export type DrawOpts = MapFrameOpts & { ctx: DrawContext };

/**
 * Paint a planned frame onto a 2d context, in list order. The `ctx` casts to
 * `PathContext`/`SpineContext` are the `DrawContext` note's wider-surface
 * case.
 */
export function paintCanvas2D(ctx: DrawContext, list: DrawList): void {
  ctx.imageSmoothingEnabled = list.smoothing;
  for (let i = 0; i < list.length; i++) {
    const item = list.items[i];
    switch (item.kind) {
      case 'image': {
        const { dst, src } = item;
        if (item.alpha !== 1) ctx.globalAlpha = item.alpha;
        if (item.whole) ctx.drawImage(item.source, dst.x, dst.y, dst.w, dst.h);
        else ctx.drawImage(item.source, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
        if (item.alpha !== 1) ctx.globalAlpha = 1;
        break;
      }
      case 'fill':
        if (item.alpha !== 1) ctx.globalAlpha = item.alpha;
        ctx.fillStyle = item.color.css;
        ctx.fillRect(item.dst.x, item.dst.y, item.dst.w, item.dst.h);
        if (item.alpha !== 1) ctx.globalAlpha = 1;
        break;
      case 'stroke':
        ctx.strokeStyle = item.color.css;
        ctx.lineWidth = item.width;
        ctx.strokeRect(item.dst.x, item.dst.y, item.dst.w, item.dst.h);
        break;
      case 'glow': {
        // The true Bezier, replayed (`tracePathCommands`); `flattenPath` is for
        // hit-testing only.
        const path = ctx as PathContext;
        const { cell } = item;
        tracePathCommands(path, item.path, { x: cell.w, y: cell.h }, cell.x, cell.y);
        path.fillStyle = HOVER_GLOW_FILL;
        path.fill();
        path.lineWidth = 1;
        path.strokeStyle = HOVER_GLOW_STROKE;
        path.stroke();
        break;
      }
      case 'spines':
        composeSpines(ctx as SpineContext, item.cell, item.slots, item.hoveredBook, item.limits);
        break;
      default:
        assertNever(item);
    }
  }
}

export function createRenderer({ cache, overlays }: CreateRendererOpts) {
  const planner = createMapPlanner({ cache, overlays });

  function draw({ ctx, ...opts }: DrawOpts): DrawResult {
    const result = planner.plan(opts);
    paintCanvas2D(ctx, planner.list);
    return result;
  }

  return { draw };
}
