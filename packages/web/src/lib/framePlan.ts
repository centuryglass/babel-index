/**
 * The per-cell decisions of a map frame, made once for both renderers.
 *
 * `createMapPlanner` turns the state of the world into a `DrawList`
 * (`drawList.ts`) and the frame's stats; `render.ts` and `glRenderer.ts` only
 * paint that list. The `plan*` helpers are the per-cell and overlay rules,
 * shared with `slidePlan.ts` so a sliding tile wears the same overlays as a
 * still one. No context, no DOM: everything here is asserted browser-free.
 *
 * Where the three pyramid rules meet the screen. "Rule 1"/"rule 2" elsewhere
 * in the rendering cluster mean these:
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
 * Planning queries the cache through `get()`, which touches the LRU and
 * requests what is missing. The calls happen inside the frame `beginFrame()`
 * opened and in paint order, so `tiles.ts`'s eviction rule holds as if the
 * painter had made them.
 *
 * The level is remembered between frames for `pickLevel()`'s hysteresis band:
 * it stops a zoom held near a boundary from flickering between two levels,
 * and it can only apply if it knows what was on screen last frame.
 */
import { prefetchBounds, type Bounds, type Pyramid } from './pyramid.ts';
import { pxPerCell, type Camera } from './camera.ts';
import {
  CENTER, FAVORITE_BADGE, FAVORITE_SWITCH, DISTILL_TOGGLE, CLEAR_HISTORY,
  genericId, genericDistillId, type RoomId, type TileCache, type TileHit,
} from './tiles.ts';
import { areSpinesLegible, BOOK_COUNT, type Slot, type SpineFontLimits } from './center.ts';
import { FAVORITE_TOGGLE_PATH } from './favoriteBadge.ts';
import { DISTILL_OFF_PATH, DISTILL_ON_PATH } from './distillToggle.ts';
import { overlayScreenRect, type Rect } from './overlay.ts';
import { overlayFaceId, type Overlays } from '../../../map/overlays.ts';
import { perfRecordSheetFirstDraw } from './perfProbe.ts';
import { createDrawList, BLANK_FILL, FADE_FILL, CURSOR_STROKE, type DrawList } from './drawList.ts';
import type { LoadingFrame } from './loadingAnimation.ts';
import { isCenter, type MapLayout } from '../../../map/ordering.ts';
import type { SortMode } from '../../../map/favorites.ts';

/**
 * The largest tile-to-cell downscale ratio at which bilinear filtering still
 * earns its cost. `pickLevel` hands back a tile at least as large as the
 * demand, so this ratio is >= 1; near 1:1 (and above, when a coarser tile is
 * substituted) filtering pays for itself, and beyond it nearest-neighbour of
 * an already-filtered mip looks the same for a fraction of the work. Bilinear
 * downscaling of the whole visible field is the largest single cost in a
 * zoomed-out Canvas2D frame (Skia's filtered sampler), and a zoomed-out frame
 * is where this ratio is high. The GL painter ignores it.
 */
export const SMOOTHING_MAX_DOWNSCALE = 1.25;

/** Whether a frame drawn at `level` with cells `cellPx` css pixels wide filters - see `SMOOTHING_MAX_DOWNSCALE`. */
export function smoothingFor(pyramid: Pyramid, level: number, cellPx: { x: number }, dpr: number): boolean {
  const src = pyramid.sizeOf(level);
  return !src || src.w <= cellPx.x * dpr * SMOOTHING_MAX_DOWNSCALE;
}

/**
 * The cache id for whatever cell (gx, gy) holds: the center cell takes the
 * blank center tile, a generic cell one of the generic tiles chosen by
 * `layout.genericIndexAt`, a content cell its room. `genericId(-1)` is
 * `CENTER`, the fallback for a collection with no generic tiles at all.
 *
 * Built from `layout.rankOf`/`isCenter` because `layout.roomAt()` allocates a
 * `RoomAtResult` per call, and this runs once per cell in the visible pass
 * and the prefetch ring, tens of thousands of times a frame at coarse zoom.
 */
export const idOf = (layout: MapLayout, order: number[], gx: number, gy: number): RoomId => {
  if (isCenter(gx, gy)) return CENTER;
  const rank = layout.rankOf(gx, gy);
  return rank === -1 || rank >= order.length
    ? genericId(layout.genericIndexAt(gx, gy))
    : order[rank];
};

/** The state of the world a map frame is planned from; each renderer adds its context. */
export interface MapFrameOpts {
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
   * only real rooms carry badges, and a favorite's cell is what the plan
   * compares against.
   */
  hoveredFavorite?: { x: number; y: number } | null;
  /**
   * Which of the three rankings is in force, for the center tile's
   * favorites-sort switch (planned whenever `favorites` is non-null - see
   * `planFavoriteSwitch`). `favorites`, not this, gates whether the switch
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
   * which is the transition's progress. See `planDistillToggle`.
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

/** How `planCell` filled a cell - which `DrawResult` counter it feeds. */
export type CellOutcome = 'faded' | 'drawn' | 'substituted' | 'blank';

/**
 * Plan one cell's tile at `(sx, sy, w, h)`: the room's art at whatever level
 * the cache has (rule 1), the blank fill if it has none, and distill mode's
 * fade on top for a generic cell (`distillId` non-null).
 *
 * A generic cell fully faded to its distill alternate shows none of the base
 * tile's art, so the base is not requested at all - and zoomed out, generic
 * cells are the majority. The prefetch pass still warms the base, so toggling
 * distill off again does not pop.
 */
export function planCell(
  list: DrawList, cache: TileCache, id: RoomId, distillId: RoomId | null, genericFade: number,
  level: number, sx: number, sy: number, w: number, h: number
): CellOutcome {
  if (distillId !== null && genericFade >= 1) {
    planGenericFade(list, cache, distillId, genericFade, sx, sy, w, h, level);
    return 'faded';
  }
  const hit = cache.get(id, level);
  let outcome: CellOutcome;
  if (hit) {
    outcome = hit.level !== level ? 'substituted' : 'drawn';
    list.image(hit.img, hit.rect, sx, sy, w, h, 1, BLANK_FILL, outcome);
    if (hit.sheetUrl) perfRecordSheetFirstDraw(hit.sheetUrl);
  } else {
    // Rule 1's floor. Only reachable before the generic itself has loaded, or
    // for a room the manifest does not have.
    list.fill(sx, sy, w, h, BLANK_FILL);
    outcome = 'blank';
  }
  if (distillId !== null && genericFade) planGenericFade(list, cache, distillId, genericFade, sx, sy, w, h, level);
  return outcome;
}

/**
 * Distill mode's crossfade for a generic tile: the tile's paired distill
 * alternate (`genericDistillId`) drawn over the base art at `fade` opacity -
 * a crossfade between two images, not a fade to black. When the alternate has
 * no cached tile yet - or, per `genericDistillId`'s doc, none exists for this
 * index - it fills `FADE_FILL` at `fade` instead, so a slow load never lets
 * the base art bleed through at an opacity that reads as broken.
 */
export function planGenericFade(
  list: DrawList, cache: TileCache, distillId: RoomId, fade: number,
  sx: number, sy: number, w: number, h: number, level = 0
): void {
  if (fade <= 0) return;
  const alpha = Math.min(1, fade);
  const hit = cache.get(distillId, level);
  if (hit) list.image(hit.img, hit.rect, sx, sy, w, h, alpha, FADE_FILL);
  else list.fill(sx, sy, w, h, FADE_FILL, alpha);
}

/**
 * The hit's decoded pixel size: a sheet sub-rect's `sw`/`sh`, else the
 * image's natural size. Sheet packing never happens for overlay art -
 * `rooms.ts` resolves it flat - but sizing from the hit keeps the rule the
 * same as every other tile lookup. The cast is sound because `tiles.ts`'s
 * `Drawable` doc makes a real tile's image an `ImageBitmap` in the browser.
 *
 * Overlay art is sized from this, not a constant, so replacement art of a
 * different size moves where the overlay draws; hit-testing is independent
 * of it (see `overlay.ts`), so a size change cannot change what is
 * clickable.
 */
function naturalIconSize(hit: TileHit): { w: number; h: number } {
  if (hit.rect) return { w: hit.rect.sw, h: hit.rect.sh };
  const img = hit.img as unknown as { width: number; height: number };
  return { w: img.width, h: img.height };
}

/**
 * Plan one face of overlay `id` on a tile drawn at `level`, if the
 * manifest describes that overlay and face and the art has landed. Returns
 * where it drew, or null. Rule 1 does not apply: art still loading draws
 * nothing this frame.
 *
 * The descriptor's `scale` picks the art's level:
 * - `tile` art is requested at level 0, whatever the tile's level.
 * - `pyramid` art is requested at `level` and drawn only if that exact
 *   level came back, never the cache's coarser-or-finer substitute. Its
 *   screen size tracks the tile whichever rung backs it, so a substitute
 *   would only be blurrier, and a level with no art draws nothing.
 *
 * Placement is `overlayScreenRect`, off the descriptor's `anchor`.
 */
export function planOverlay(
  list: DrawList, cache: TileCache, overlays: Overlays, id: string, face: string,
  cellPx: { x: number; y: number }, sx: number, sy: number, level: number
): Rect | null {
  const overlay = overlays[id];
  if (!overlay || !(face in overlay.faces)) return null;
  const want = overlay.scale === 'pyramid' ? level : 0;
  const hit = cache.get(overlayFaceId(id, face), want);
  if (!hit || hit.level !== want) return null;
  const r = overlayScreenRect(overlay.anchor, cellPx, sx, sy, naturalIconSize(hit), cache.pyramid, hit.level);
  list.image(hit.img, hit.rect, r.x, r.y, r.w, r.h);
  return r;
}

/**
 * Plan one tile's favorite badge (`FAVORITE_BADGE`), the face matching
 * `isFavorite`.
 *
 * `hovered` adds the gold glow in the badge's traced silhouette
 * (`FAVORITE_TOGGLE_PATH`) - shape, not box, like the shelf's open book - and
 * only over drawn art. It is canvas-side because a tile has no DOM element of
 * its own for CSS `:hover` to sit on; `planDistillToggle` follows the same
 * rule.
 */
export function planFavoriteBadge(
  list: DrawList, cache: TileCache, overlays: Overlays, isFavorite: boolean,
  cellPx: { x: number; y: number }, sx: number, sy: number, level: number, hovered = false
): void {
  const r = planOverlay(list, cache, overlays, FAVORITE_BADGE, isFavorite ? 'on' : 'off', cellPx, sx, sy, level);
  if (r && hovered && FAVORITE_TOGGLE_PATH)
    list.glow(FAVORITE_TOGGLE_PATH, { x: sx, y: sy, w: cellPx.x, h: cellPx.y }, r);
}

/**
 * Plan the "forget searches" book's black spine (`CLEAR_HISTORY`). The art
 * is anchored to the tile corner, not to the book's traced rect: its
 * transparent margin carries where on the shelf the spine lands. No hover
 * treatment of its own: the spine titles' glow, drawn on top, already covers
 * the book, whose hit-test stays in `center.ts`.
 */
export function planClearHistoryBook(
  list: DrawList, cache: TileCache, overlays: Overlays,
  cellPx: { x: number; y: number }, sx: number, sy: number, level: number
): void {
  planOverlay(list, cache, overlays, CLEAR_HISTORY, 'black', cellPx, sx, sy, level);
}

/**
 * Plan the center tile's distill toggle (`DISTILL_TOGGLE`): the face
 * matching `distillMode`, plus the hover glow traced onto the active state's
 * own silhouette - the `planFavoriteBadge` treatment, same gold, same
 * reasons.
 */
export function planDistillToggle(
  list: DrawList, cache: TileCache, overlays: Overlays, distillMode: boolean, hovered: boolean,
  cellPx: { x: number; y: number }, sx: number, sy: number, level: number
): void {
  const r = planOverlay(list, cache, overlays, DISTILL_TOGGLE, distillMode ? 'on' : 'off', cellPx, sx, sy, level);
  const activePath = distillMode ? DISTILL_ON_PATH : DISTILL_OFF_PATH;
  if (r && hovered && activePath) list.glow(activePath, { x: sx, y: sy, w: cellPx.x, h: cellPx.y }, r);
}

/**
 * Plan the center tile's favorites-sort switch (`FAVORITE_SWITCH`): the
 * `base` plate plus whichever face matches `sortMode` - neither for
 * `'relevance'`, the switch's off position. Each face draws only once its
 * own art has landed.
 *
 * Each face is sized from its own decoded pixels, not the base's rect: the
 * faces' art is close to the base's size but not pixel-identical, and
 * forcing a face into the base plate's rect stretches it off the base's own
 * indicator.
 *
 * `slidePlan.ts` plans this too because the center tile is the
 * rearrangement's fixed tile: its controls must keep drawing across the
 * handoff between renderers, not blink out mid-animation.
 */
export function planFavoriteSwitch(
  list: DrawList, cache: TileCache, overlays: Overlays, sortMode: SortMode,
  cellPx: { x: number; y: number }, sx: number, sy: number, level: number
): void {
  planOverlay(list, cache, overlays, FAVORITE_SWITCH, 'base', cellPx, sx, sy, level);
  if (sortMode === 'mine') planOverlay(list, cache, overlays, FAVORITE_SWITCH, 'mine', cellPx, sx, sy, level);
  else if (sortMode === 'count') planOverlay(list, cache, overlays, FAVORITE_SWITCH, 'count', cellPx, sx, sy, level);
}

/**
 * Plan one loading-indicator frame onto the center cell: the frame's sheet
 * sub-rect (`src`) at its cell-fraction position (`rect`) inside the cell at
 * `(sx, sy)`, per-axis (`loadingAnimation.ts`).
 */
export function planLoadingFrame(
  list: DrawList, frame: LoadingFrame, cellPx: { x: number; y: number }, sx: number, sy: number
): void {
  const { src, rect } = frame;
  list.image(
    frame.image, { sx: src.x, sy: src.y, sw: src.w, sh: src.h },
    sx + rect.x * cellPx.x, sy + rect.y * cellPx.y, rect.w * cellPx.x, rect.h * cellPx.y
  );
}

export interface CreateMapPlannerOpts {
  cache: TileCache;
  /** `manifest.overlays`: the corner overlays' art, anchors and scales. */
  overlays: Overlays;
}

/**
 * One renderer's map planner. `plan()` fills `list` for a frame and returns
 * its stats; the list is reused, so paint it before the next `plan()`.
 */
export function createMapPlanner({ cache, overlays }: CreateMapPlannerOpts) {
  const { pyramid } = cache;
  const list = createDrawList();
  // Survives across frames purely so hysteresis has something to compare to.
  let level: number | null = null;
  // Cycles the prefetch ring's starting corner across frames - see its use below.
  let ringFrame = 0;

  function plan({
    width: w, height: h, dpr, cam, layout, order, centreSlots = null,
    hoveredBook = null, spineFontLimits = null, cursor = null, favorites = null, hoveredFavorite = null,
    sortMode = 'relevance', genericFade = 0, distillMode, hoveredDistill = false, loadingFrame = null,
  }: MapFrameOpts): DrawResult {
    cache.beginFrame();

    // No background fill: the cell grid below is computed to cover the whole
    // viewport with no gaps (`render.test.ts`'s "the cell grid covers the full
    // viewport with no gaps, at any zoom or fractional pan" asserts it), and
    // every cell plans something - a tile or rule 1's blank fill.
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
    // Decided once per frame from the level every visible tile shares.
    list.reset(dpr, smoothingFor(pyramid, level, cellPx, dpr));

    // +1 kills hairline gaps from rounding, on each axis independently.
    const cw = cellPx.x + 1;
    const ch = cellPx.y + 1;

    let drawn = 0;
    let substituted = 0;
    let blank = 0;
    const visible: RoomId[] = [];

    for (let gy = bounds.y0; gy <= bounds.y1; gy++) {
      for (let gx = bounds.x0; gx <= bounds.x1; gx++) {
        // Scalar reads rather than `layout.roomAt()`, which allocates a fresh
        // `RoomAtResult` object per cell - see `idOf`'s comment.
        const isCtr = isCenter(gx, gy);
        const rank = isCtr ? -1 : layout.rankOf(gx, gy);
        const isGeneric = !isCtr && (rank === -1 || rank >= order.length);
        const id: RoomId = isCtr ? CENTER : isGeneric ? genericId(layout.genericIndexAt(gx, gy)) : order[rank];
        visible.push(id);

        const sx = (gx - cx) * cellPx.x + w / 2;
        const sy = (gy - cy) * cellPx.y + h / 2;
        const distillId = isGeneric ? genericDistillId(layout.genericIndexAt(gx, gy)) : null;

        const outcome = planCell(list, cache, id, distillId, genericFade, level, sx, sy, cw, ch);
        if (outcome === 'blank') blank++;
        else if (outcome !== 'faded') {
          drawn++;
          if (outcome === 'substituted') substituted++;
        }

        // The favorite badge: every real room, never the center (it is the
        // controls, not a room) and never a generic cell (nothing to favorite).
        if (favorites && !isCtr && !isGeneric) {
          const hovered = hoveredFavorite != null && hoveredFavorite.x === gx && hoveredFavorite.y === gy;
          planFavoriteBadge(list, cache, overlays, favorites.isFavorite(order[rank]), cellPx, sx, sy, level, hovered);
        }
        if (!isCtr) continue;
        const cell = { x: sx, y: sy, w: cellPx.x, h: cellPx.y };
        // The "forget searches" book's black spine, claimed whenever history
        // holds its slot. The check reads `centreSlots` itself - the same
        // override `useCenterShelf.ts` reserves the slot with - so there is no
        // second "is there history" flag to drift. Planned before the shelf's
        // titles so the gilt text composites on top.
        if (centreSlots?.[BOOK_COUNT - 1]?.action === 'forgetHistory')
          planClearHistoryBook(list, cache, overlays, cellPx, sx, sy, level);
        // The center room's spines carry the search history; `composeSpines`
        // gates on legible spine width, so far out it draws nothing.
        if (centreSlots && spineFontLimits)
          list.spines(cell, { x: sx, y: sy, w: cw, h: ch }, centreSlots, hoveredBook, spineFontLimits);
        // The favorites-sort switch, in the center tile's upper left corner -
        // the favorite badge's upper-right mirror. Gated on a favorite store
        // existing and on `areSpinesLegible`, the same zoom gate the shelf's
        // titles use.
        if (favorites && areSpinesLegible(cell))
          planFavoriteSwitch(list, cache, overlays, sortMode, cellPx, sx, sy, level);
        // The distill toggle, in the center tile's lower right corner -
        // ungated by `favorites`, since distill mode needs no favorite store.
        // `distillMode === undefined` means the caller does not use distill
        // mode at all (a test asserting on level selection, say), and the
        // toggle then plans nothing rather than requesting art nobody asked
        // for.
        if (distillMode !== undefined)
          planDistillToggle(list, cache, overlays, distillMode, hoveredDistill, cellPx, sx, sy, level);
        // The loading indicator's frame, over the center book's page. Its
        // region is disjoint from everything above, so the order among them is
        // cosmetic.
        if (loadingFrame) planLoadingFrame(list, loadingFrame, cellPx, sx, sy);
      }
    }

    // --- rule 2, strictly after every visible cell has been asked for -------
    // The walk stops as soon as `hasPrefetchCapacity()` says the queue is
    // full, before computing that cell's id - a coarse-zoom ring can be tens
    // of thousands of cells, and `idOf()` for whatever is past the
    // cap would only be thrown away (`tiles.ts`'s `prefetch()` already
    // resolves an already-cached or nonexistent id for free, ahead of the
    // cap, so this never cuts off work that would have cost nothing anyway).
    // The starting corner rotates across four frames so a region with more
    // distinct uncached ids than the queue can hold in one frame does not
    // always lose the same corner while the camera sits still.
    const ring = prefetchBounds(bounds);
    ringFrame = (ringFrame + 1) % 4;
    const flipY = (ringFrame & 1) !== 0;
    const flipX = (ringFrame & 2) !== 0;
    const ringHeight = ring.y1 - ring.y0;
    const ringWidth = ring.x1 - ring.x0;
    ringWalk:
    for (let iy = 0; iy <= ringHeight; iy++) {
      const gy = flipY ? ring.y1 - iy : ring.y0 + iy;
      for (let ix = 0; ix <= ringWidth; ix++) {
        if (!cache.hasPrefetchCapacity()) break ringWalk;
        const gx = flipX ? ring.x1 - ix : ring.x0 + ix;
        const inside =
          gx >= bounds.x0 && gx <= bounds.x1 && gy >= bounds.y0 && gy <= bounds.y1;
        if (inside) continue;
        cache.prefetch(idOf(layout, order, gx, gy), level);
      }
    }

    // Zooming out needs ~4x as many tiles at once and has nothing to show until
    // they land; zooming in has the coarse tile on screen already and it
    // upscales acceptably. Hence warming outward only. Deduped once here: at
    // coarse zoom most of `visible` is a handful of repeated generic ids
    // (`packages/map/ordering.ts`'s `genericIndexAt`), and `prefetch()` is a
    // no-op for anything already cached or in flight, so walking the raw
    // array re-checks the same id once per occurrence for nothing.
    const distinctVisible = new Set(visible);
    for (const coarser of pyramid.warmLevels(level))
      for (const id of distinctVisible) cache.prefetch(id, coarser);

    const cells = (bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1);
    // The keyboard cursor's ring, last and over everything, and only once the
    // reader has used a keyboard - the caller gates `cursor` on that. It
    // doubles as a desync detector: a ring on the wrong cell is visible to
    // every sighted reader, not only to the one it would otherwise mislead.
    if (cursor && cursor.x >= bounds.x0 && cursor.x <= bounds.x1
      && cursor.y >= bounds.y0 && cursor.y <= bounds.y1) {
      const sx = (cursor.x - cx) * cellPx.x + w / 2;
      const sy = (cursor.y - cy) * cellPx.y + h / 2;
      list.stroke(sx + 2, sy + 2, cellPx.x - 4, cellPx.y - 4, 3, CURSOR_STROKE);
    }

    return { cells, drawn, substituted, blank, level, bounds, zoom };
  }

  return { plan, list };
}
