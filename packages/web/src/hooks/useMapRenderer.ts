/**
 * The map's frame loop: one effect, rebuilt whenever what it draws changes.
 *
 * A hook in its own file for the same reason `useMapCamera.ts` is one - it owns
 * a listener lifetime and a cancellable animation frame, and reading `main.jsx`
 * should not mean reading a hundred and forty lines of canvas plumbing to find
 * the state everything else shares.
 *
 * It does not own the frame REQUEST. `draw` is passed in as a ref this hook
 * assigns into, because the tile cache is built with `onLoad: requestDraw` and
 * this hook takes that cache as an argument - so a hook that also handed back
 * the request function would have to be created before the thing it depends on.
 * One ref breaks the cycle, and it is the arrangement the code already had.
 *
 * Three things it is responsible for beyond drawing, all of which have to share
 * the effect's lifetime:
 *
 *   - positioning the center tile's two overlays, which move every frame with
 *     the camera and so cannot be React state;
 *   - writing the HUD, which is the app's own account of what it just drew and
 *     is what the e2e suite reads the camera out of;
 *   - ending a rearrangement on `pointerdown`, because a map you cannot
 *     interrupt is not a map.
 */
import { useEffect } from 'react';
import { cursorCell, pxPerCell, worldToScreen, type Camera } from '../lib/camera.ts';
import {
  bookAtPoint, centerBookAtPoint, centerCellRect,
  shuffleButtonAtPoint, mineToggleAtPoint, countToggleAtPoint,
} from '../lib/center.ts';
import { roomAtPoint } from '../lib/picking.ts';
import { favoriteIconScreenRect, favoriteHitRect, favoriteToggleAtPoint } from '../lib/favoriteBadge.ts';
import { distillToggleAtPoint } from '../lib/distillToggle.ts';
import type { SortMode } from '../../../map/favorites.ts';
import { sizeOf as pyramidSizeOf } from '../lib/pyramid.ts';
import type { TileCache } from '../lib/tiles.ts';
import type { MapLayout } from '../../../map/ordering.ts';
import type { Board, Motion, Point } from '../../../map/moves.ts';
import type { Slot } from '../lib/center.ts';
import { createRenderer, type DrawResult } from '../lib/render.ts';
import type { SpineFontLimits } from '../lib/center.ts';
import type { createSlideRenderer, createSlideshow, SlideDrawResult } from '../lib/slide.ts';

/** Same check `main.tsx`'s tap-hit test uses - a coarse pointer gets its hit rect padded (`favoriteHitRect`), a mouse stays precise. */
const COARSE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/**
 * `RoomRenderer`/`SlideRenderer` read their shape off the real `createRenderer`/
 * `createSlideRenderer` rather than restating it, so a change to either
 * signature is picked up automatically instead of leaving a second, driftable
 * copy.
 */
type RoomRenderer = ReturnType<typeof createRenderer>;
type SlideRenderer = ReturnType<typeof createSlideRenderer>;

/** The live rearrangement, as `useRearrangement.ts` builds it into the `anim` ref. */
export interface RunningAnim {
  /** the arrangement being flown away from, held on screen for the flight home */
  before?: { layout: MapLayout; order: number[] };
  board?: Board;
  cam?: Camera;
  origin?: Point;
  motions?: Motion[];
  show?: ReturnType<typeof createSlideshow>;
  t0?: number;
}

/** `centreOverlay(w, h)`'s return - see `main.jsx`. */
interface CentreOverlay {
  cellRect: { x: number; y: number; w: number; h: number };
  box: { x: number; y: number; w: number; h: number };
  usable: boolean;
  books: boolean;
}

interface UseMapRendererOpts {
  /** the one canvas, mounted for the session */
  canvasRef: { current: HTMLCanvasElement | null };
  /** the center tile's search field */
  searchFormRef: { current: HTMLFormElement | null };
  /** the center tile's shelf of buttons */
  booksRef: { current: HTMLElement | null };
  /** the open book painted into a shelf gap - a distinct hotspot, not one of the shelf's buttons */
  centerBookRef?: { current: HTMLElement | null };
  /**
   * The favorites-sort switch and reorder button, painted into the center
   * tile - one container over the whole cell, like `booksRef`, holding three
   * buttons positioned in percentages of it.
   */
  controlsRef?: { current: HTMLElement | null };
  /** the search badge's orbiting arrow */
  searchArrowRef?: { current: HTMLElement | null };
  /** assigned by this hook; called by `requestDraw` */
  draw: { current: () => void };
  /** the running rearrangement, or null */
  anim: { current: RunningAnim | null };
  /** the live camera, a ref */
  cam: { current: Camera };
  /** 'map' or 'catalog'; hidden means no frames */
  mode: string;
  /** the current `createLayout` result */
  layout: MapLayout;
  /** room ids by rank */
  order: number[];
  renderer: RoomRenderer;
  slideRenderer: SlideRenderer;
  cache: TileCache;
  centreSlots?: (Slot | null)[] | null;
  /** `config.center`'s auto-fit font range - see `render.ts`'s `DrawOpts.spineFontLimits` */
  spineFontLimits?: SpineFontLimits | null;
  centreOverlay: (w: number, h: number) => CentreOverlay;
  /** rooms the reader's blocked tags removed, for the HUD */
  blockedCount?: number;
  /** overlay a favorite badge on every real room's tile - see `render.ts`'s `DrawOpts.favorites` */
  favorites?: { isFavorite: (id: number) => boolean } | null;
  /**
   * The floating "add to favorites"/"remove from favorites" tooltip - one
   * element for the whole map, since a badge is canvas-painted on every
   * tile and has no DOM element of its own to hang `.control-tooltip` off
   * of (unlike the center tile's fixed controls). Positioned and shown by
   * the `pointermove` listener below, alongside `hoveredFavorite`.
   */
  favTooltipRef?: { current: HTMLElement | null };
  /** which ranking is in force, for the center tile's favorites-sort switch - see `render.ts`'s `DrawOpts.sortMode` */
  sortMode?: SortMode;
  /**
   * Distill mode's black fade over generic tiles, 0-1 - a ref rather than a
   * plain value since it changes every rAF tick of `useDistillMode.ts`'s own
   * fade loop, the same reason `anim`/`cam` are refs rather than props.
   */
  genericFade?: { current: number };
  /** whether distill mode is on - see `render.ts`'s `DrawOpts.distillMode` */
  distillMode?: boolean;
  /**
   * The distill toggle's own floating tooltip - the same "one element, no
   * per-tile DOM node" treatment `favTooltipRef` gets, for the same reason:
   * the toggle is canvas-painted onto the center tile and has no button of
   * its own to hang a `.control-tooltip` off of.
   */
  distillTooltipRef?: { current: HTMLElement | null };
}

export function useMapRenderer({
  canvasRef,
  searchFormRef,
  booksRef,
  searchArrowRef,
  centerBookRef,
  controlsRef,
  draw,
  anim,
  cam,
  mode,
  layout,
  order,
  renderer,
  slideRenderer,
  cache,
  centreSlots,
  spineFontLimits = null,
  centreOverlay,
  blockedCount = 0,
  favorites = null,
  favTooltipRef,
  sortMode = 'relevance',
  genericFade,
  distillMode = false,
  distillTooltipRef,
}: UseMapRendererOpts) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    // The pending frame's id, so it can be cancelled - not just a flag. This
    // closure captures `layout` and `order`, so a frame scheduled through it
    // and left to fire after the effect has been rebuilt repaints the state
    // this render pass replaced. That is a real frame of the old map, arriving
    // after the new one and winning, which is what a stale draw looks like.
    let pending = 0;
    // The shelf book under the pointer, or null - read by `render()` each
    // frame and written by the `pointermove` listener below, the same split
    // `centerBookRef`'s hover class uses (`bookEl`/`onMove` further down).
    let hoveredBook: number | null = null;
    // The world cell of the tile whose favorite badge is under the pointer,
    // or null - same split as `hoveredBook` just above: read each frame by
    // `render()`, written by the `pointermove` listener below.
    let hoveredFavorite: { x: number; y: number } | null = null;
    // Whether the pointer is over the distill toggle's traced silhouette -
    // same split as `hoveredFavorite`, read each frame by `render()`, written
    // by the `pointermove` listener below.
    let hoveredDistill = false;
    // Gates the cursor ring (`render.ts`). Tied to the canvas's own focus
    // rather than to whether a key has ever been pressed: a reader who just
    // tabbed onto the map has no other way to tell the press landed, since
    // nothing else about the page changes until the first arrow key moves
    // something. `:focus-visible` (not plain `:focus`) is what keeps a mouse
    // click from lighting up a permanent reticle for someone who never
    // touched a keyboard - the same distinction every other focus ring in
    // this app already draws (index.html's global `:focus-visible` rule).
    let focusVisible = document.activeElement === canvas && canvas.matches(':focus-visible');

    const render = () => {
      pending = 0;
      // Hidden, so there is nothing to draw and nothing to measure. Not merely
      // an optimisation: with `display: none` up the tree every clientWidth is
      // 0, and a frame drawn against that would size the canvas to nothing and
      // place both center-tile overlays at the origin. The camera, the cache
      // and the pyramid's LRU are all untouched meanwhile, which is what makes
      // coming back free.
      if (mode !== 'map') return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // The center tile's live search field, positioned every frame like the
      // canvas content it sits over - it is not React state, for the same
      // reason the camera itself is a ref: it moves on every pan, zoom and
      // flight, and a re-render per frame is not the architecture here.
      const searchEl = searchFormRef.current;
      const booksEl = booksRef.current;
      const arrowEl = searchArrowRef?.current;
      const bookEl = centerBookRef?.current;
      const controlsEl = controlsRef?.current;
      if (searchEl || booksEl || arrowEl || bookEl || controlsEl) {
        const { box, usable, cellRect, books } = centreOverlay(w, h);
        if (searchEl) {
          searchEl.style.display = usable ? 'block' : 'none';
          if (usable) {
            searchEl.style.left = `${box.x}px`;
            searchEl.style.top = `${box.y}px`;
            searchEl.style.width = `${box.w}px`;
            searchEl.style.height = `${box.h}px`;
          }
        }
        // The whole shelf in ONE style write, not forty: the books are an
        // affine map of the cell rect, so they sit inside this box in
        // percentages and need no per-frame work of their own
        // (accessibility-plan.md §3.3).
        if (booksEl) {
          booksEl.style.display = books ? 'block' : 'none';
          if (books) {
            booksEl.style.left = `${cellRect.x}px`;
            booksEl.style.top = `${cellRect.y}px`;
            booksEl.style.width = `${cellRect.w}px`;
            booksEl.style.height = `${cellRect.h}px`;
          }
        }
        // The open book: same visibility gate and same box as the shelf - it
        // is an SVG path drawn with `viewBox="0 0 1 1"` over the whole cell,
        // exactly like `booksEl`'s buttons are percentages of it, so it needs
        // no rect of its own.
        if (bookEl) {
          bookEl.style.display = books ? 'block' : 'none';
          if (books) {
            bookEl.style.left = `${cellRect.x}px`;
            bookEl.style.top = `${cellRect.y}px`;
            bookEl.style.width = `${cellRect.w}px`;
            bookEl.style.height = `${cellRect.h}px`;
          }
        }
        // The favorites-sort switch and the reorder button - the same
        // whole-cell container + percentage-children shape as `booksEl`, so
        // this costs one style write regardless of how many controls it holds.
        if (controlsEl) {
          controlsEl.style.display = books ? 'block' : 'none';
          if (books) {
            controlsEl.style.left = `${cellRect.x}px`;
            controlsEl.style.top = `${cellRect.y}px`;
            controlsEl.style.width = `${cellRect.w}px`;
            controlsEl.style.height = `${cellRect.h}px`;
          }
        }
        // The arrow, pointed at the center tile's screen position rather
        // than any fixed direction - `cellRect` is in the same coordinate
        // space the badge is positioned in (both absolute against #root), so
        // no separate conversion is needed. It has to work when the center
        // tile is off screen too (`cellRect` can be arbitrarily far outside
        // the viewport), since that is when knowing *which way* to fly there
        // matters most - the badge's own `getBoundingClientRect` is read
        // fresh each frame rather than assumed, so a CSS change to its
        // position or size cannot leave this pointing at a stale spot.
        if (arrowEl) {
          const badge = arrowEl.getBoundingClientRect();
          const root = canvas.getBoundingClientRect();
          const fromX = badge.left - root.left + badge.width / 2;
          const fromY = badge.top - root.top + badge.height / 2;
          const toX = cellRect.x + cellRect.w / 2;
          const toY = cellRect.y + cellRect.h / 2;
          // The traced arrow points up by default (`assets/search_arrow.svg`
          // sits at the top of the badge's circle), which is -90° from the
          // atan2 convention's zero (pointing right) - so the rotation that
          // lands it on the target's bearing is the bearing plus 90°.
          const deg = (Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI + 90;
          arrowEl.style.transform = `rotate(${deg}deg)`;
        }
      }

      // Three states, and the middle one is why this is not an `if`.
      //
      // While SLIDING, the rearrangement draws itself from its own board at the
      // camera it was planned for; the live camera is not consulted, because
      // the board is a finite window and panning off it would show the wrap
      // that makes the whole illusion affordable.
      //
      // While FLYING home to start one, the ordinary renderer draws - but the
      // arrangement it draws is the one being flown away from, not the one just
      // computed. `layout` and `order` update the moment a search resolves,
      // which is before the camera has moved, so drawing them here would show
      // the new library, fly to it, and then slide it in from the old one.
      const running = anim.current;
      const showing = running?.before ?? { layout, order };
      // Named consts rather than object literals passed straight to `draw()` -
      // kept purely for symmetry between the two draw calls below.
      const slideDrawOpts = {
        ctx, width: w, height: h, dpr, cam: running?.cam as Camera,
        board: running?.board as Board, origin: running?.origin as Point, motions: running?.motions,
        genericIndexAt: layout.genericIndexAt, favorites, sortMode, genericFade: genericFade?.current,
        distillMode, hoveredDistill,
      };
      const roomDrawOpts = {
        ctx, width: w, height: h, dpr, cam: cam.current,
        layout: showing.layout, order: showing.order, centreSlots, hoveredBook, spineFontLimits,
        cursor: focusVisible ? cursorCell(cam.current) : null, favorites, hoveredFavorite, sortMode,
        genericFade: genericFade?.current, distillMode, hoveredDistill,
      };
      const stats: object = running?.board ? slideRenderer.draw(slideDrawOpts) : renderer.draw(roomDrawOpts);

      const hud = document.getElementById('hud');
      if (running?.board && hud) {
        const slideStats = stats as SlideDrawResult;
        const show = running.show as NonNullable<RunningAnim['show']>;
        const t0 = running.t0 as number;
        const motions = running.motions ?? [];
        const pct = Math.round((100 * Math.min(show.totalMs, performance.now() - t0)) / show.totalMs);
        hud.textContent =
          `rearranging · ${pct}% · ${motions.length} lines moving · ` +
          `level ${slideStats.level} · ${slideStats.blank} blank · ${cache.size()} cached` +
          (blockedCount ? ` · ${blockedCount} blocked` : '');
      } else if (hud) {
        const renderStats = stats as DrawResult;
        const size = pyramidSizeOf(renderStats.level);
        const over = cache.overBudget();
        const favHit = favoriteHitRect(favoriteIconScreenRect(pxPerCell(cam.current), 0, 0), pxPerCell(cam.current), COARSE_POINTER);
        hud.textContent =
          `${renderStats.cells} cells · ${renderStats.drawn} drawn · ` +
          `level ${renderStats.level} (${size.w}px) · ${renderStats.substituted} substituted · ` +
          `${renderStats.blank} blank · ` +
          `${cache.size()} cached${over ? ` (+${over} over budget)` : ''} · ` +
          `zoom ${Math.round(renderStats.zoom)} · ` +
          `x ${cam.current.x.toFixed(1)} y ${cam.current.y.toFixed(1)} · ` +
          `edge at r=${layout.boundaryRadius.toFixed(1)}` +
          (layout.gradedCount ? ` · ${layout.gradedCount} clustered` : '') +
          (blockedCount ? ` · ${blockedCount} blocked` : '') +
          ` · fav hit ${favHit.w.toFixed(1)}×${favHit.h.toFixed(1)}px (${COARSE_POINTER ? 'touch-padded' : 'mouse'})`;
      }
    };

    draw.current = () => {
      if (pending) return;
      pending = requestAnimationFrame(render);
    };

    render();
    const onResize = () => draw.current();
    // Touching the map ends a rearrangement rather than fighting it: the
    // remaining moves land at once, which is exactly the instant rebuild this
    // animation replaced. A map you cannot interrupt is not a map.
    const onDown = () => {
      const running = anim.current;
      if (!running) return;
      // Mid-slide, the remaining moves land at once - which is the instant
      // rebuild this replaced. Still flying home, there is no slideshow yet and
      // nothing to finish; dropping the hold is enough, and the next draw shows
      // the new arrangement. `useMapCamera` cancels the flight itself.
      running.show?.advanceTo(running.show.totalMs);
      anim.current = null;
      draw.current();
    };
    window.addEventListener('resize', onResize);
    canvas.addEventListener('pointerdown', onDown);

    // Blur always hides the ring outright - there is no reading of `:focus-
    // visible` to make there, since an element with no focus at all cannot be
    // focus-visible. Focus re-checks it fresh each time rather than assuming
    // true, because a programmatic `.focus()` call and a mouse click both
    // fire this event and only one of them should light the ring.
    const onFocus = () => {
      focusVisible = canvas.matches(':focus-visible');
      draw.current();
    };
    const onBlur = () => {
      focusVisible = false;
      draw.current();
    };
    canvas.addEventListener('focus', onFocus);
    canvas.addEventListener('blur', onBlur);

    // The open book's hover highlight, and the shelf's. Cosmetic only -
    // `centerBookRef`'s element and every `.center-books` button are
    // `pointer-events: none` (see index.html), the same reasoning in both
    // cases: the canvas keeps every gesture, so a pan whose start happens to
    // land here must still pan. A real click already reaches `onTap` ->
    // `centerBookAtPoint`/`bookAtPoint` in main.tsx; this listener only
    // decides what highlights, so it does not need to distinguish a hover
    // from the start of a drag the way gesture arbitration does.
    //
    // The open book's highlight is a DOM `.hover` class because that hotspot
    // paints no text of its own - a CSS overlay is the whole highlight. A
    // shelf book's IS text, and the DOM sits above the canvas in paint order,
    // so a DOM glow there would wash out over the composited title instead of
    // sitting behind it. `hoveredBook` instead feeds `composeSpines` directly
    // (via `render()` below), which paints the glow FIRST and the hover
    // backdrop plate over it, on the same canvas layer as the title.
    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const viewportRect = { width: canvas.clientWidth, height: canvas.clientHeight };
      const cellRect = centerCellRect(cam.current, viewportRect);
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      const el = centerBookRef?.current;
      if (el) el.classList.toggle('hover', centerBookAtPoint(px, py, cellRect));

      // The favorites-sort switch and reorder button - same DOM `.hover`
      // class approach as the open book above, for the same reason: neither
      // paints any text of its own, so a CSS overlay is the whole highlight.
      const controls = controlsRef?.current;
      if (controls) {
        controls
          .querySelector('[data-control="shuffle"]')
          ?.classList.toggle('hover', shuffleButtonAtPoint(px, py, cellRect));
        controls
          .querySelector('[data-control="mine"]')
          ?.classList.toggle('hover', mineToggleAtPoint(px, py, cellRect));
        controls
          .querySelector('[data-control="count"]')
          ?.classList.toggle('hover', countToggleAtPoint(px, py, cellRect));
      }

      // The distill toggle - a DOM `.hover` class doesn't apply here (no
      // per-tile element, same reason the favorite badge below has none), so
      // both the highlight and the tooltip are driven from here, the same
      // shape as the favorite badge's own hover handling just below.
      const nextDistill = distillToggleAtPoint(
        px, py, { x: cellRect.w, y: cellRect.h }, cellRect.x, cellRect.y, distillMode
      );
      if (nextDistill !== hoveredDistill) {
        hoveredDistill = nextDistill;
        draw.current();
      }
      const distillTooltip = distillTooltipRef?.current;
      if (distillTooltip) {
        if (nextDistill) {
          distillTooltip.textContent = distillMode ? 'Disable distillation' : 'Enable distillation';
          distillTooltip.style.left = `${px}px`;
          distillTooltip.style.top = `${py}px`;
          distillTooltip.style.display = 'block';
        } else {
          distillTooltip.style.display = 'none';
        }
      }

      const next = booksRef.current ? bookAtPoint(px, py, cellRect) : null;
      if (next !== hoveredBook) {
        hoveredBook = next;
        draw.current();
      }

      // The on-tile favorite badge - there is no per-tile DOM element to
      // toggle a `.hover` class on (unlike every control above, which is
      // fixed to the one center cell), so both the highlight (`hoveredFavorite`,
      // read by `render()` above) and the tooltip are driven from here. The
      // hover trigger is the badge's traced silhouette (`favoriteToggleAtPoint`)
      // - already precise on its own, so no padding/gate is applied here the
      // way the tap hit test pads out for touch (`favoriteHitRect`); a mouse
      // hover should track the art exactly.
      let nextFavorite: { x: number; y: number; id: number } | null = null;
      if (favorites) {
        const hit = roomAtPoint(px, py, cam.current, viewportRect, layout, order);
        if (hit && !('generic' in hit)) {
          const cellPx = pxPerCell(cam.current);
          const { x: bsx, y: bsy } = worldToScreen(hit.x, hit.y, cam.current, viewportRect);
          if (favoriteToggleAtPoint(px, py, cellPx, bsx, bsy))
            nextFavorite = { x: hit.x, y: hit.y, id: hit.id };
        }
      }
      if (nextFavorite?.x !== hoveredFavorite?.x || nextFavorite?.y !== hoveredFavorite?.y) {
        hoveredFavorite = nextFavorite;
        draw.current();
      }
      const tooltip = favTooltipRef?.current;
      if (tooltip) {
        if (nextFavorite && favorites) {
          tooltip.textContent = favorites.isFavorite(nextFavorite.id)
            ? 'Remove from favorites'
            : 'Add to favorites';
          tooltip.style.left = `${px}px`;
          tooltip.style.top = `${py}px`;
          tooltip.style.display = 'block';
        } else {
          tooltip.style.display = 'none';
        }
      }
    };
    const onLeave = () => {
      centerBookRef?.current?.classList.remove('hover');
      controlsRef?.current
        ?.querySelectorAll('.hover')
        .forEach((n) => n.classList.remove('hover'));
      if (favTooltipRef?.current) favTooltipRef.current.style.display = 'none';
      if (distillTooltipRef?.current) distillTooltipRef.current.style.display = 'none';
      if (hoveredFavorite !== null) {
        hoveredFavorite = null;
        draw.current();
      }
      if (hoveredDistill) {
        hoveredDistill = false;
        draw.current();
      }
      if (hoveredBook !== null) {
        hoveredBook = null;
        draw.current();
      }
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      if (pending) cancelAnimationFrame(pending);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('focus', onFocus);
      canvas.removeEventListener('blur', onBlur);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [
    canvasRef, searchFormRef, booksRef, searchArrowRef, centerBookRef, controlsRef, draw, anim,
    layout, order, renderer, slideRenderer, cache, cam, centreSlots, spineFontLimits, centreOverlay, mode,
    blockedCount, favorites, favTooltipRef, sortMode, genericFade, distillMode, distillTooltipRef,
  ]);
}
