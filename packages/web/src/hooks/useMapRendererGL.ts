/**
 * The WebGL counterpart of `useMapRenderer.ts` - see AGENTS.md's "The WebGL
 * renderer (experimental)" for the standing invariants this file exists to
 * uphold, in particular: GL setup happens exactly ONCE per canvas element's
 * lifetime, never per-frame or per-prop-change.
 *
 * Two effects, not one, and that split is the whole point:
 *
 *   - The canvas-lifetime effect (deps `[canvasRef, cache]` only) creates the
 *     GL context, the two renderers, and every pointer/resize/context-loss
 *     listener EXACTLY ONCE per real canvas mount (or after a lost context
 *     restores). `cache` is included because a genuinely new `TileCache`
 *     (a reloaded corpus) really does need a fresh GL runtime bound to it -
 *     unlike `layout`/`order`/`favorites`/etc., which change on almost every
 *     search or toggle and must NOT tear this down.
 *   - Everything that legitimately changes often is read through `latestRef`,
 *     assigned during the render body itself (not inside an effect) so it is
 *     always current before any effect runs this render, regardless of
 *     effect declaration order. A second, tiny effect exists only to call
 *     `draw.current()` when one of those values actually changes - the
 *     redraw trigger a full effect-rebuild used to provide for free.
 *
 * `main.tsx` hands this hook the real `canvasRef` only when `WEBGL` is on
 * and a dummy always-null ref otherwise (see `webglFlag.ts`), the same way
 * `useMapRenderer` gets the dummy ref when `WEBGL` is on - exactly one of
 * the two ever calls `getContext` on the real canvas element, since a
 * canvas can only ever hand out one context type.
 */
import { useEffect, useRef } from 'react';
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
import { createGLContext, type GLContext } from '../lib/gl/context.ts';
import { warmGLTextures } from '../lib/gl/warm.ts';
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
  /**
   * Assigned by this hook (mirroring `draw`'s own "caller owns the ref, hook
   * fills it in" shape) to a function that uploads the given tiles' textures
   * ahead of a rearrangement's flight - see `gl/warm.ts`. `main.tsx` wires
   * this ref into `useRearrangement`'s `onPreparing` callback. A no-op until
   * the GL runtime exists (or after it's lost), same as `draw` before this
   * hook's effect has run.
   */
  warmTexturesRef?: { current: (ids: ReadonlySet<number>, level: number) => void };
  /** Budget for `gl/warm.ts`'s polling loop - `config.slide.prepareTimeoutMs` in practice, matching `prepareRearrangement`'s own budget. */
  warmTimeoutMs?: number;
}

/** Everything `render()`/the pointer handlers need that legitimately changes on almost every search or toggle - see this file's doc. */
interface Latest {
  mode: string;
  layout: MapLayout;
  order: number[];
  centreSlots?: (Slot | null)[] | null;
  spineFontLimits?: SpineFontLimits | null;
  centreOverlay: (w: number, h: number) => CentreOverlay;
  blockedCount: number;
  favorites: { isFavorite: (id: number) => boolean } | null;
  sortMode: SortMode;
  distillMode: boolean;
}

/** Fallback when the caller (a test, or a build predating Phase C) doesn't pass `warmTimeoutMs`. */
const DEFAULT_WARM_TIMEOUT_MS = 1200;

export function useMapRendererGL({
  canvasRef, searchFormRef, booksRef, centerBookRef, controlsRef, searchArrowRef,
  draw, anim, cam, mode, layout, order, cache, centreSlots, spineFontLimits = null,
  centreOverlay, blockedCount = 0, favorites = null, favTooltipRef, sortMode = 'relevance',
  genericFade, distillMode = false, distillTooltipRef, warmTexturesRef,
  warmTimeoutMs = DEFAULT_WARM_TIMEOUT_MS,
}: UseMapRendererGLOpts) {
  // Assigned during the render body, not inside an effect - always correct
  // before EITHER effect below runs this render, regardless of which is
  // declared first. See this file's doc.
  const latestRef = useRef<Latest>({
    mode, layout, order, centreSlots, spineFontLimits, centreOverlay, blockedCount,
    favorites, sortMode, distillMode,
  });
  latestRef.current = {
    mode, layout, order, centreSlots, spineFontLimits, centreOverlay, blockedCount,
    favorites, sortMode, distillMode,
  };

  // The redraw trigger a full effect-rebuild used to provide for free -
  // nothing here touches GL.
  useEffect(() => {
    draw.current();
  }, [
    draw, mode, layout, order, centreSlots, spineFontLimits, centreOverlay,
    blockedCount, favorites, sortMode, distillMode,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let runtime: {
      gl: GLContext;
      renderer: ReturnType<typeof createGLRenderer>;
      slideRenderer: ReturnType<typeof createGLSlideRenderer>;
    } | null = null;

    const setup = () => {
      const gl = createGLContext(canvas);
      if (!gl) return;
      const renderer = createGLRenderer({ cache });
      const slideRenderer = createGLSlideRenderer({ cache, textures: renderer.textures, glowTextures: renderer.glowTextures });
      runtime = { gl, renderer, slideRenderer };
    };

    let pending = 0;
    let hoveredBook: number | null = null;
    let hoveredFavorite: { x: number; y: number } | null = null;
    let hoveredDistill = false;
    // Gates the cursor ring (`glRenderer.ts`) - same `:focus-visible` tracking
    // as `useMapRenderer.ts`'s own, duplicated rather than shared since each
    // hook owns its own canvas-lifetime effect and listener set.
    let focusVisible = document.activeElement === canvas && canvas.matches(':focus-visible');

    const render = () => {
      pending = 0;
      const {
        mode: m, layout: lay, order: ord, centreSlots: slots, spineFontLimits: limits,
        centreOverlay: overlay, blockedCount: blocked, favorites: favs, sortMode: sort,
        distillMode: distill,
      } = latestRef.current;
      if (m !== 'map') return;
      // A lost context (or a device that never got one) draws nothing -
      // never throws. `webglcontextrestored` calls `setup()` again and the
      // next `draw.current()` picks the new runtime back up.
      if (!runtime) return;
      const { gl, renderer, slideRenderer } = runtime;

      const dpr = PERF_FORCE_DPR1 ? 1 : Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      const searchEl = searchFormRef.current;
      const booksEl = booksRef.current;
      const arrowEl = searchArrowRef?.current;
      const bookEl = centerBookRef?.current;
      const controlsEl = controlsRef?.current;
      if (searchEl || booksEl || arrowEl || bookEl || controlsEl) {
        const { box, usable, cellRect, books } = overlay(w, h);
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
      const showing = running?.before ?? { layout: lay, order: ord };

      const t0 = PERF && running ? performance.now() : 0;
      const stats: GLDrawResult | GLSlideDrawResult = running?.board
        ? slideRenderer.draw({
            gl, width: w, height: h, dpr,
            cam: running.cam as Camera,
            board: running.board,
            origin: running.origin as { x: number; y: number },
            motions: running.motions,
            genericIndexAt: lay.genericIndexAt,
            favorites: favs, sortMode: sort, genericFade: genericFade?.current,
            distillMode: distill, hoveredDistill,
            clearHistoryAvailable: slots?.[BOOK_COUNT - 1]?.action === 'forgetHistory',
          })
        : renderer.draw({
            gl, width: w, height: h, dpr,
            cam: cam.current,
            layout: showing.layout, order: showing.order,
            centreSlots: slots, hoveredBook, spineFontLimits: limits,
            favorites: favs, hoveredFavorite, sortMode: sort,
            genericFade: genericFade?.current, distillMode: distill, hoveredDistill,
            cursor: focusVisible ? cursorCell(cam.current) : null,
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
          (blocked ? ` · ${blocked} blocked` : '');
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
          `edge at r=${lay.boundaryRadius.toFixed(1)}` +
          (lay.gradedCount ? ` · ${lay.gradedCount} clustered` : '') +
          (blocked ? ` · ${blocked} blocked` : '') +
          ` · fav hit ${favHitLabel}`;
      }
    };

    draw.current = () => {
      if (pending) return;
      pending = requestAnimationFrame(render);
    };

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

    // Same focus/blur handling as `useMapRenderer.ts`'s own cursor-ring gate -
    // see that file's doc for why `:focus-visible` rather than plain `:focus`.
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

    const onMove = (e: PointerEvent) => {
      const { layout: lay, order: ord, favorites: favs, distillMode: distill } = latestRef.current;
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
        px, py, { x: cellRect.w, y: cellRect.h }, cellRect.x, cellRect.y, distill
      );
      if (nextDistill !== hoveredDistill) {
        hoveredDistill = nextDistill;
        draw.current();
      }
      const distillTooltip = distillTooltipRef?.current;
      if (distillTooltip) {
        if (nextDistill) {
          distillTooltip.textContent = distill ? 'Disable distillation' : 'Enable distillation';
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
      if (favs) {
        const hit = roomAtPoint(px, py, cam.current, viewportRect, lay, ord);
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
        if (nextFavorite && favs) {
          tooltip.textContent = favs.isFavorite(nextFavorite.id)
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

    // A lost context invalidates every GL object this runtime owns -
    // `preventDefault()` is required or the browser never attempts recovery.
    // `restored` just re-runs `setup()`, which builds a fresh GL context,
    // renderers and texture caches from scratch; the old ones are simply
    // dropped rather than reused; there is nothing worth salvaging from a
    // runtime whose every handle is already invalid.
    const onContextLost = (e: Event) => {
      e.preventDefault();
      runtime = null;
    };
    const onContextRestored = () => {
      setup();
      draw.current();
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    setup();
    render();

    // Assigned once, not inside `setup()` - it closes over the `runtime`
    // variable itself (not a snapshot of one object), so a restore's fresh
    // `runtime` is picked up automatically without reassigning this.
    if (warmTexturesRef) {
      warmTexturesRef.current = (ids, level) => {
        if (runtime) warmGLTextures(ids, level, cache, runtime.gl, runtime.renderer.textures, warmTimeoutMs);
      };
    }

    return () => {
      if (pending) cancelAnimationFrame(pending);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('focus', onFocus);
      canvas.removeEventListener('blur', onBlur);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      if (warmTexturesRef) warmTexturesRef.current = () => {};
      if (runtime) {
        runtime.renderer.textures.dispose(runtime.gl.gl);
        runtime.renderer.spineTextures.dispose(runtime.gl.gl);
        runtime.renderer.glowTextures.dispose(runtime.gl.gl);
        runtime.gl.dispose();
      }
    };
    // `latestRef`/`anim`/`cam`/`genericFade` are refs read fresh every call -
    // deliberately excluded so this effect stays canvas-lifetime-only. See
    // this file's doc and AGENTS.md's "The WebGL renderer (experimental)".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef, cache]);
}
