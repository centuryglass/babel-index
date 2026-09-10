/**
 * Spike: the WebGL counterpart of `useMapRenderer.ts`.
 *
 * A close port of that hook's DOM-overlay positioning, hover tracking,
 * pointerdown-ends-rearrangement handling, HUD text, and perfProbe wiring -
 * forked wholesale rather than factored into a shared helper first (an
 * acceptable shortcut for a spike per the plan; the two files will drift if
 * this goes any further than a spike). The one structural difference is the
 * draw call itself: `glRenderer.ts`/`glSlideRenderer.ts` instead of
 * `render.ts`/`slide.ts`, and no `ctx.setTransform` - see those files' own
 * docs for what they do and do not draw yet (no cursor ring, no
 * favorites-sort switch/distill toggle/clear-history overlay - so this hook
 * still tracks `hoveredDistill`/the switch's hover classes for later, but
 * nothing currently renders for them on the GL canvas itself).
 *
 * `main.tsx` hands this hook the real `canvasRef` only when `WEBGL` is on
 * and a dummy always-null ref otherwise (see `webglFlag.ts`), the same way
 * `useMapRenderer` gets the dummy ref when `WEBGL` is on - exactly one of
 * the two ever calls `getContext` on the real canvas element, since a
 * canvas can only ever hand out one context type.
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
import { sizeOf as pyramidSizeOf } from '../lib/pyramid.ts';
import type { TileCache } from '../lib/tiles.ts';
import type { MapLayout } from '../../../map/ordering.ts';
import type { Slot, SpineFontLimits } from '../lib/center.ts';
import { createGLContext } from '../lib/gl/context.ts';
import { createGLRenderer, type GLDrawResult } from '../lib/glRenderer.ts';
import { createGLSlideRenderer, type GLSlideDrawResult } from '../lib/glSlideRenderer.ts';
import type { RunningAnim } from './useMapRenderer.ts';
import { PERF, PERF_FORCE_DPR1, perfRecordFrame } from '../lib/perfProbe.ts';

const COARSE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

interface CentreOverlay {
  cellRect: { x: number; y: number; w: number; h: number };
  box: { x: number; y: number; w: number; h: number };
  usable: boolean;
  books: boolean;
}

interface UseMapRendererGLOpts {
  canvasRef: { current: HTMLCanvasElement | null };
  searchFormRef: { current: HTMLFormElement | null };
  booksRef: { current: HTMLElement | null };
  centerBookRef?: { current: HTMLElement | null };
  controlsRef?: { current: HTMLElement | null };
  searchArrowRef?: { current: HTMLElement | null };
  draw: { current: () => void };
  anim: { current: RunningAnim | null };
  cam: { current: Camera };
  mode: string;
  layout: MapLayout;
  order: number[];
  cache: TileCache;
  centreSlots?: (Slot | null)[] | null;
  spineFontLimits?: SpineFontLimits | null;
  centreOverlay: (w: number, h: number) => CentreOverlay;
  blockedCount?: number;
  favorites?: { isFavorite: (id: number) => boolean } | null;
  favTooltipRef?: { current: HTMLElement | null };
  sortMode?: SortMode;
  genericFade?: { current: number };
  distillMode?: boolean;
  distillTooltipRef?: { current: HTMLElement | null };
}

export function useMapRendererGL({
  canvasRef, searchFormRef, booksRef, centerBookRef, controlsRef, searchArrowRef,
  draw, anim, cam, mode, layout, order, cache, centreSlots, spineFontLimits = null,
  centreOverlay, blockedCount = 0, favorites = null, favTooltipRef, sortMode = 'relevance',
  genericFade, distillMode = false, distillTooltipRef,
}: UseMapRendererGLOpts) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = createGLContext(canvas);
    if (!gl) return;
    const renderer = createGLRenderer({ cache });
    const slideRenderer = createGLSlideRenderer({ cache, textures: renderer.textures });

    let pending = 0;
    let hoveredBook: number | null = null;
    let hoveredFavorite: { x: number; y: number } | null = null;
    let hoveredDistill = false;

    const render = () => {
      pending = 0;
      if (mode !== 'map') return;
      const dpr = PERF_FORCE_DPR1 ? 1 : Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

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
        if (booksEl) {
          booksEl.style.display = books ? 'block' : 'none';
          if (books) {
            booksEl.style.left = `${cellRect.x}px`;
            booksEl.style.top = `${cellRect.y}px`;
            booksEl.style.width = `${cellRect.w}px`;
            booksEl.style.height = `${cellRect.h}px`;
          }
        }
        if (bookEl) {
          bookEl.style.display = books ? 'block' : 'none';
          if (books) {
            bookEl.style.left = `${cellRect.x}px`;
            bookEl.style.top = `${cellRect.y}px`;
            bookEl.style.width = `${cellRect.w}px`;
            bookEl.style.height = `${cellRect.h}px`;
          }
        }
        if (controlsEl) {
          controlsEl.style.display = books ? 'block' : 'none';
          if (books) {
            controlsEl.style.left = `${cellRect.x}px`;
            controlsEl.style.top = `${cellRect.y}px`;
            controlsEl.style.width = `${cellRect.w}px`;
            controlsEl.style.height = `${cellRect.h}px`;
          }
        }
        if (arrowEl) {
          const badge = arrowEl.getBoundingClientRect();
          const root = canvas.getBoundingClientRect();
          const fromX = badge.left - root.left + badge.width / 2;
          const fromY = badge.top - root.top + badge.height / 2;
          const toX = cellRect.x + cellRect.w / 2;
          const toY = cellRect.y + cellRect.h / 2;
          const deg = (Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI + 90;
          arrowEl.style.transform = `rotate(${deg}deg)`;
        }
      }

      const running = anim.current;
      const showing = running?.before ?? { layout, order };

      const t0 = PERF && running ? performance.now() : 0;
      const stats: GLDrawResult | GLSlideDrawResult = running?.board
        ? slideRenderer.draw({
            gl, width: w, height: h, dpr,
            cam: running.cam as Camera,
            board: running.board,
            origin: running.origin as { x: number; y: number },
            motions: running.motions,
            genericIndexAt: layout.genericIndexAt,
            favorites, sortMode, genericFade: genericFade?.current,
            distillMode, hoveredDistill,
            clearHistoryAvailable: centreSlots?.[BOOK_COUNT - 1]?.action === 'forgetHistory',
          })
        : renderer.draw({
            gl, width: w, height: h, dpr,
            cam: cam.current,
            layout: showing.layout, order: showing.order,
            centreSlots, hoveredBook, spineFontLimits,
            favorites, hoveredFavorite, sortMode,
            genericFade: genericFade?.current, distillMode, hoveredDistill,
          });
      if (PERF && running) perfRecordFrame(running.board ? 'slide' : 'flight', performance.now() - t0);

      const hud = document.getElementById('hud');
      if (running?.board && hud) {
        const slideStats = stats as GLSlideDrawResult;
        const show = running.show as NonNullable<RunningAnim['show']>;
        const t0h = running.t0 as number;
        const motions = running.motions ?? [];
        const pct = Math.round((100 * Math.min(show.totalMs, performance.now() - t0h)) / show.totalMs);
        hud.textContent =
          `[gl] rearranging · ${pct}% · ${motions.length} lines moving · ` +
          `level ${slideStats.level} · ${slideStats.blank} blank · ${cache.size()} cached` +
          (blockedCount ? ` · ${blockedCount} blocked` : '');
      } else if (running && hud) {
        hud.textContent = '[gl] rearranging · preparing…';
      } else if (hud) {
        const renderStats = stats as GLDrawResult;
        const size = pyramidSizeOf(renderStats.level);
        const over = cache.overBudget();
        const favHit = favoriteHitRect(pxPerCell(cam.current), 0, 0, COARSE_POINTER);
        const favHitLabel = favHit
          ? `${favHit.w.toFixed(1)}×${favHit.h.toFixed(1)}px (${COARSE_POINTER ? 'touch-padded' : 'mouse'})`
          : 'untraced';
        hud.textContent =
          `[gl] ${renderStats.cells} cells · ${renderStats.drawn} drawn · ` +
          `level ${renderStats.level} (${size.w}px) · ${renderStats.substituted} substituted · ` +
          `${renderStats.blank} blank · ` +
          `${cache.size()} cached${over ? ` (+${over} over budget)` : ''} · ` +
          `zoom ${Math.round(renderStats.zoom)} · ` +
          `x ${cam.current.x.toFixed(1)} y ${cam.current.y.toFixed(1)} · ` +
          `edge at r=${layout.boundaryRadius.toFixed(1)}` +
          (layout.gradedCount ? ` · ${layout.gradedCount} clustered` : '') +
          (blockedCount ? ` · ${blockedCount} blocked` : '') +
          ` · fav hit ${favHitLabel}`;
      }
    };

    draw.current = () => {
      if (pending) return;
      pending = requestAnimationFrame(render);
    };

    render();
    const onResize = () => draw.current();
    const onDown = () => {
      const running = anim.current;
      if (!running) return;
      running.show?.advanceTo(running.show.totalMs);
      anim.current = null;
      draw.current();
    };
    window.addEventListener('resize', onResize);
    canvas.addEventListener('pointerdown', onDown);

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const viewportRect = { width: canvas.clientWidth, height: canvas.clientHeight };
      const cellRect = centerCellRect(cam.current, viewportRect);
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      const el = centerBookRef?.current;
      if (el) el.classList.toggle('hover', centerBookAtPoint(px, py, cellRect));

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
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [
    canvasRef, searchFormRef, booksRef, centerBookRef, controlsRef, searchArrowRef, draw, anim,
    layout, order, cache, cam, centreSlots, spineFontLimits, centreOverlay, mode,
    blockedCount, favorites, favTooltipRef, sortMode, genericFade, distillMode, distillTooltipRef,
  ]);
}
