/**
 * The map's frame loop: one effect, rebuilt whenever what it draws changes.
 *
 * A hook in its own file for the same reason `useMapCamera.ts` is one - it
 * owns a listener lifetime and a cancellable animation frame, so reading
 * `main.tsx` does not mean reading a hundred and forty lines of canvas
 * plumbing to find the state everything else shares.
 *
 * It does not own the frame request. `draw` is passed in as a ref this hook
 * assigns into, because the tile cache is built with `onLoad: requestDraw`
 * and this hook takes that cache as an argument - a hook that also handed
 * back the request function would have to be created before the thing it
 * depends on. The `draw` ref breaks the cycle.
 *
 * Three things beyond drawing share the effect's lifetime:
 *
 *   - positioning the center tile's DOM overlays, which move every frame
 *     with the camera and so cannot be React state;
 *   - writing the HUD, which is the app's own account of what it just drew
 *     and is what the e2e suite reads the camera out of;
 *   - ending a rearrangement on `pointerdown`, so a map can always be
 *     interrupted.
 */
import { useEffect } from 'react';
import { cursorCell, pxPerCell, worldToScreen, type Camera } from '../lib/camera.ts';
import {
  bookAtPoint, centerBookAtPoint, centerCellRect,
  shuffleButtonAtPoint, mineToggleAtPoint, countToggleAtPoint, BOOK_COUNT,
} from '../lib/center.ts';
import { roomAtPoint } from '../lib/picking.ts';
import { favoriteHitRect, favoriteToggleAtPoint } from '../lib/favoriteBadge.ts';
import { distillToggleAtPoint } from '../lib/distillToggle.ts';
import type { SortMode } from '../../../map/favorites.ts';
import { sizeOf as pyramidSizeOf, DPR_CAP } from '../lib/pyramid.ts';
import type { TileCache } from '../lib/tiles.ts';
import type { MapLayout } from '../../../map/ordering.ts';
import type { Board, Motion, Point } from '../../../map/moves.ts';
import type { Slot } from '../lib/center.ts';
import { createRenderer, type DrawResult } from '../lib/render.ts';
import type { LoadingAnimation } from '../lib/loadingAnimation.ts';
import type { SpineFontLimits } from '../lib/center.ts';
import type { createSlideRenderer, createSlideshow, SlideDrawResult } from '../lib/slide.ts';
import { PERF, PERF_FORCE_DPR1, perfRecordFrame } from '../lib/perfProbe.ts';
import { DEFAULTS } from '../../../config/config.ts';

/** Same check `main.tsx`'s tap-hit test uses - a coarse pointer gets its hit rect padded (`favoriteHitRect`), a mouse stays precise. */
const COARSE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/**
 * `RoomRenderer`/`SlideRenderer` are `ReturnType`s of the real factories: a
 * signature change arrives as a type error here, not as a second, driftable
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

/** `centreOverlay(w, h)`'s return - the implementation is `main.tsx`'s. */
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
   * `config.favorites.minInteractiveTileWidth` - below this many CSS pixels
   * of cell width, the favorite badge stops responding to hover (and, in
   * `main.tsx`'s tap handler, to a tap).
   */
  minFavoriteInteractiveWidth?: number;
  /**
   * The floating "add to favorites"/"remove from favorites" tooltip (declared
   * in `main.tsx`), positioned and shown by the `pointermove` listener
   * (`onMove`) alongside `hoveredFavorite`.
   */
  favTooltipRef?: { current: HTMLElement | null };
  /** which ranking is in force, for the center tile's favorites-sort switch - see `render.ts`'s `DrawOpts.sortMode` */
  sortMode?: SortMode;
  /**
   * Distill mode's crossfade over generic tiles, 0-1 - a ref rather than a
   * plain value since it changes every rAF tick of `useDistillMode.ts`'s own
   * fade loop, the same reason `anim`/`cam` are refs rather than props.
   */
  genericFade?: { current: number };
  /** whether distill mode is on - see `render.ts`'s `DrawOpts.distillMode` */
  distillMode?: boolean;
  /** The distill toggle's tooltip - one shared element, the `favTooltipRef` arrangement. */
  distillTooltipRef?: { current: HTMLElement | null };
  /**
   * The center-tile loading indicator, or null when none is deployed. Read
   * every frame for the current frame to composite onto the center cell (see
   * `render.ts`'s `DrawOpts.loadingFrame`), and cancelled when the map is
   * grabbed mid-rearrangement. A ref, like `anim`/`cam`, so the render loop is
   * not rebuilt when it changes.
   */
  loadingAnim?: { current: LoadingAnimation | null };
  /**
   * Release a search's indicator/spinner claim (`useRearrangement.ts`'s
   * `beginSearchPreload`) when the map is grabbed before any rearrangement
   * plan exists to own it - the window `anim.current` alone cannot see.
   * A no-op when nothing claimed it.
   */
  cancelSearchPreload?: () => void;
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
  minFavoriteInteractiveWidth = DEFAULTS.favorites.minInteractiveTileWidth,
  favTooltipRef,
  sortMode = 'relevance',
  genericFade,
  distillMode = false,
  distillTooltipRef,
  loadingAnim,
  cancelSearchPreload,
}: UseMapRendererOpts) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    // The pending frame's id, so the cleanup can cancel it - a flag is not
    // enough. This closure captures `layout` and `order`, so a frame left to
    // fire after the effect rebuilds repaints the superseded state: one real
    // frame of the old map, arriving after the new one and winning.
    let pending = 0;
    // The shelf book under the pointer, or null. The hover pattern, shared
    // by all three `hovered*` vars: `render()` reads each one every frame,
    // the `pointermove` listener writes it, and only the value changing
    // triggers a redraw.
    let hoveredBook: number | null = null;
    // The world cell whose favorite badge is under the pointer, or null -
    // hover pattern as `hoveredBook`.
    let hoveredFavorite: { x: number; y: number } | null = null;
    // Whether the pointer is over the distill toggle's silhouette - hover
    // pattern as `hoveredBook`.
    let hoveredDistill = false;
    // Gates the cursor ring (`render.ts`), tied to the canvas's own focus
    // so a reader who just tabbed onto the map sees the press landed.
    // `:focus-visible` keeps a mouse click from lighting a permanent
    // reticle - the same selector the center tile's DOM controls use for
    // their outlines (`style.css`).
    let focusVisible = document.activeElement === canvas && canvas.matches(':focus-visible');

    // The canvas and search-arrow rects are cached and refreshed by their own
    // `ResizeObserver`. Calling `getBoundingClientRect()` inside `render()`
    // would force a reflow of the frame's own style writes (searchEl/booksEl/
    // bookEl/controlsEl) every frame. Neither rect changes on pan/zoom/scroll.
    // `hud` exists only under `?debug` and cannot appear mid-effect, so it is
    // looked up once here too.
    const hud = document.getElementById('hud');
    let canvasRect = canvas.getBoundingClientRect();
    const canvasRO = new ResizeObserver(() => {
      canvasRect = canvas.getBoundingClientRect();
    });
    canvasRO.observe(canvas);
    const arrowElForObserver = searchArrowRef?.current ?? null;
    let badgeRect: DOMRect | null = null;
    let badgeRO: ResizeObserver | null = null;
    if (arrowElForObserver) {
      badgeRect = arrowElForObserver.getBoundingClientRect();
      badgeRO = new ResizeObserver(() => {
        badgeRect = arrowElForObserver.getBoundingClientRect();
      });
      badgeRO.observe(arrowElForObserver);
    }

    // The favorites-sort switch and reorder button's three children, looked
    // up once here for every `pointermove` to share. The container is
    // mounted (hidden, not unmounted) for the whole effect lifetime whether
    // or not its cell is on screen, so these don't change underneath the cache.
    const controlsContainerEl = controlsRef?.current ?? null;
    const shuffleEl = controlsContainerEl?.querySelector<HTMLElement>('[data-control="shuffle"]') ?? null;
    const mineEl = controlsContainerEl?.querySelector<HTMLElement>('[data-control="mine"]') ?? null;
    const countEl = controlsContainerEl?.querySelector<HTMLElement>('[data-control="count"]') ?? null;

    const render = () => {
      pending = 0;
      // Hidden draws nothing and measures nothing: under `display: none` every
      // clientWidth is 0, and a frame drawn against that would size the canvas
      // to nothing and put the center-tile overlays at the origin. The camera,
      // the cache and the pyramid's LRU stay untouched meanwhile, which is
      // what makes coming back free.
      if (mode !== 'map') return;
      const dpr = PERF_FORCE_DPR1 ? 1 : Math.min(DPR_CAP, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // The center tile's overlays, positioned every frame like the canvas
      // content they sit over. None is React state, for the reason the camera
      // itself is a ref: it moves on every pan, zoom and flight, and a
      // re-render per frame is not the architecture here.
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
        // The shelf box - one style write; its book buttons are positioned
        // in percentages of it, so a pan touches no per-button work.
        if (booksEl) {
          booksEl.style.display = books ? 'block' : 'none';
          if (books) {
            booksEl.style.left = `${cellRect.x}px`;
            booksEl.style.top = `${cellRect.y}px`;
            booksEl.style.width = `${cellRect.w}px`;
            booksEl.style.height = `${cellRect.h}px`;
          }
        }
        // The open book: same visibility gate and box as the shelf - its SVG
        // path is drawn with `viewBox="0 0 1 1"` over the whole cell, so it
        // needs no rect of its own.
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
        // whole-cell container with percentage-positioned children as
        // `booksEl`, so one style write covers all of them.
        if (controlsEl) {
          controlsEl.style.display = books ? 'block' : 'none';
          if (books) {
            controlsEl.style.left = `${cellRect.x}px`;
            controlsEl.style.top = `${cellRect.y}px`;
            controlsEl.style.width = `${cellRect.w}px`;
            controlsEl.style.height = `${cellRect.h}px`;
          }
        }
        // The arrow points at the center tile's screen position, not a fixed
        // direction. `cellRect` is in the badge's own coordinate space (both
        // absolute against `#root`), so no conversion is needed. The tile may
        // be entirely off screen - `cellRect` arbitrarily outside the
        // viewport - and the bearing must still be right; that is when the
        // direction matters most. `badgeRect`/`canvasRect` are cached above
        // and refreshed by their own `ResizeObserver`, not read fresh here -
        // reading `getBoundingClientRect` in this callback, right after the
        // style writes above, forced a layout flush on every frame.
        if (arrowEl && badgeRect) {
          const badge = badgeRect;
          const root = canvasRect;
          const fromX = badge.left - root.left + badge.width / 2;
          const fromY = badge.top - root.top + badge.height / 2;
          const toX = cellRect.x + cellRect.w / 2;
          const toY = cellRect.y + cellRect.h / 2;
          // The traced arrow art (`assets/search_arrow.svg`) points up, -90°
          // from atan2's rightward zero, hence the +90 to land on the
          // bearing.
          const deg = (Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI + 90;
          arrowEl.style.transform = `rotate(${deg}deg)`;
        }
      }

      // Three states, and the middle one is why this is not an `if`.
      //
      // While sliding, the rearrangement draws itself - from its own board,
      // at the camera it was planned for. The live camera is not consulted:
      // the board is a finite window and panning off it would show the wrap
      // that makes the illusion affordable.
      //
      // While flying home to start one, the ordinary renderer draws - but the
      // arrangement being flown away from, not the one just computed.
      // `layout` and `order` update the moment a search resolves, before the
      // camera has moved, so drawing them mid-flight would show the new
      // library, fly to it, then slide it in from the old one.
      const running = anim.current;
      const showing = running?.before ?? { layout, order };
      // Both draw paths get a named const, for symmetry between them.
      const slideDrawOpts = {
        ctx, width: w, height: h, dpr, cam: running?.cam as Camera,
        board: running?.board as Board, origin: running?.origin as Point, motions: running?.motions,
        genericIndexAt: layout.genericIndexAt, favorites, sortMode, genericFade: genericFade?.current,
        distillMode, hoveredDistill,
        clearHistoryAvailable: centreSlots?.[BOOK_COUNT - 1]?.action === 'forgetHistory',
      };
      const roomDrawOpts = {
        ctx, width: w, height: h, dpr, cam: cam.current,
        layout: showing.layout, order: showing.order, centreSlots, hoveredBook, spineFontLimits,
        cursor: focusVisible ? cursorCell(cam.current) : null, favorites, hoveredFavorite, sortMode,
        genericFade: genericFade?.current, distillMode, hoveredDistill,
        loadingFrame: loadingAnim?.current?.frame() ?? null,
      };
      // Which of the two rearrangement phases (flight vs. slide) drops
      // frames - see perfProbe.ts. Recorded only while an animation runs
      // (`running` is set by `useRearrangement.ts`); tagging ordinary
      // browsing frames 'flight' would bury the real samples.
      const t0 = PERF && running ? performance.now() : 0;
      const stats: object = running?.board ? slideRenderer.draw(slideDrawOpts) : renderer.draw(roomDrawOpts);
      if (PERF && running) perfRecordFrame(running.board ? 'slide' : 'flight', performance.now() - t0);

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
      } else if (running && hud) {
        // No board yet: still preparing (fetching the plan's tiles) or flying
        // to the overview zoom. The HUD keeps saying "rearranging" across all
        // of it, not just once the board exists - `settled()`
        // (`packages/web/e2e/support.ts`) waits for the text to stop starting
        // with that word, and `prepareRearrangement` (`useRearrangement.ts`)
        // can hold this state for seconds on a cold cache; ordinary HUD text
        // here would read as settled long before the camera ever moves.
        const anim = loadingAnim?.current?.activeName();
        hud.textContent = 'rearranging · preparing…' + (anim ? ` · anim ${anim}` : '');
      } else if (hud) {
        const renderStats = stats as DrawResult;
        const size = pyramidSizeOf(renderStats.level);
        const over = cache.overBudget();
        const favHit = favoriteHitRect(pxPerCell(cam.current), 0, 0, COARSE_POINTER);
        const favHitLabel = favHit
          ? `${favHit.w.toFixed(1)}×${favHit.h.toFixed(1)}px (${COARSE_POINTER ? 'touch-padded' : 'mouse'})`
          : 'untraced';
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
          ` · fav hit ${favHitLabel}` +
          // The dev-panel preview loop (`loadingAnimation.ts`) runs while no
          // rearrangement is in flight, so its current cycle name belongs here.
          (loadingAnim?.current?.activeName() ? ` · anim ${loadingAnim.current.activeName()}` : '');
      }
    };

    draw.current = () => {
      if (pending) return;
      pending = requestAnimationFrame(render);
    };

    render();
    const onResize = () => draw.current();
    // Touching the map ends a rearrangement rather than fighting it.
    const onDown = () => {
      const running = anim.current;
      if (!running) {
        // No rearrangement plan exists yet, but a search may already have
        // claimed the indicator ahead of one (`beginSearchPreload`) -
        // that has nothing else to hand it back.
        cancelSearchPreload?.();
        return;
      }
      // A grab mid-preload ends the whole rearrangement, so the loading
      // indicator stops with it: its `finish()` await in
      // `useRearrangement.ts` resolves off this cancel.
      loadingAnim?.current?.cancel();
      // Mid-slide, the remaining moves land at once - the instant rebuild
      // this animation replaced. Still flying home, there is no slideshow
      // and nothing to finish; dropping the hold is enough, and the next
      // draw shows the new arrangement. `useMapCamera` cancels the flight
      // itself.
      running.show?.advanceTo(running.show.totalMs);
      anim.current = null;
      draw.current();
    };
    window.addEventListener('resize', onResize);
    canvas.addEventListener('pointerdown', onDown);

    // Blur hides the ring outright - an unfocused element cannot be
    // focus-visible. Focus re-checks `:focus-visible` rather than assuming
    // true: a programmatic `.focus()` call and a mouse click both fire the
    // event, and only one of them should light the ring.
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

    // This listener only decides what highlights; the canvas keeps every
    // gesture. The elements it hovers - `centerBookRef` and the `.center-books`
    // buttons - are `pointer-events: none` (style.css), so a pan that starts
    // over them still pans and a click still reaches `main.tsx`'s `onTap` ->
    // `centerBookAtPoint`/`bookAtPoint`. That is also why this path needs no
    // slop/gesture arbitration: a hover is not a candidate for anything.
    //
    // Two hover treatments. The open book's is a DOM `.hover` class because
    // the hotspot paints no text - a CSS overlay is the whole highlight. A
    // shelf book's highlight is painted text: DOM sits above the canvas in
    // paint order, so a DOM glow would cover the composited title instead of
    // sitting behind it. `hoveredBook` instead feeds `composeSpines` (via
    // `render()`), which paints the glow first and the backdrop plate over
    // it, on the title's own canvas layer.
    // A high-poll-rate mouse or trackpad fires `pointermove` well above the
    // display's refresh rate; nothing here needs finer than one read per
    // frame, so only the latest event survives and processing is deferred to
    // a single rAF - `hoverRaf` collapses however many arrived meanwhile into
    // one pass over the hit tests below.
    let pendingMove: PointerEvent | null = null;
    let hoverRaf = 0;
    const processMove = (e: PointerEvent) => {
      // `canvasRect` is the same cache `render()`'s arrow bearing uses,
      // refreshed by `canvasRO` on an actual layout change rather than
      // re-read here - a `getBoundingClientRect` call is a forced-reflow risk
      // on every one of these, same as it is in `render()`.
      const rect = canvasRect;
      const viewportRect = { width: canvas.clientWidth, height: canvas.clientHeight };
      const cellRect = centerCellRect(cam.current, viewportRect);
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      const el = centerBookRef?.current;
      if (el) el.classList.toggle('hover', centerBookAtPoint(px, py, cellRect));

      // The favorites-sort switch and reorder button - DOM `.hover` classes
      // like the open book's: neither paints text, so a CSS overlay is the
      // whole highlight. `shuffleEl`/`mineEl`/`countEl` are cached at effect
      // setup.
      shuffleEl?.classList.toggle('hover', shuffleButtonAtPoint(px, py, cellRect));
      mineEl?.classList.toggle('hover', mineToggleAtPoint(px, py, cellRect));
      countEl?.classList.toggle('hover', countToggleAtPoint(px, py, cellRect));

      // The distill toggle - painted onto the center tile with no element of
      // its own (the `favTooltipRef` situation), so highlight and tooltip are
      // both driven from here, same shape as the favorite badge's handling.
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

      // The on-tile favorite badge - same no-element shape: both the
      // highlight (`hoveredFavorite`, read by `render()`) and the tooltip are
      // driven from here. The hover trigger is the badge's traced silhouette
      // (`favoriteToggleAtPoint`) with no padding - the tap hit test pads out
      // for touch (`favoriteHitRect`), but a mouse hover should track the
      // art exactly. Below `minFavoriteInteractiveWidth`, the badge is too
      // small to fairly hit and hover is skipped.
      let nextFavorite: { x: number; y: number; id: number } | null = null;
      if (favorites) {
        const cellPx = pxPerCell(cam.current);
        const hit = cellPx.x > minFavoriteInteractiveWidth
          ? roomAtPoint(px, py, cam.current, viewportRect, layout, order)
          : null;
        if (hit && !('generic' in hit)) {
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
    const onMove = (e: PointerEvent) => {
      pendingMove = e;
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const move = pendingMove;
        pendingMove = null;
        if (move) processMove(move);
      });
    };
    const onLeave = () => {
      // A leave cancels whatever move was still queued - processing it after
      // would re-set every `hovered*` var this clears right back on.
      if (hoverRaf) {
        cancelAnimationFrame(hoverRaf);
        hoverRaf = 0;
      }
      pendingMove = null;
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
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      canvasRO.disconnect();
      badgeRO?.disconnect();
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
    loadingAnim, cancelSearchPreload,
  ]);
}
