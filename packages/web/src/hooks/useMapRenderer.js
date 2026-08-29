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
import { cursorCell } from '../lib/camera.ts';
import { sizeOf as pyramidSizeOf } from '../lib/pyramid.ts';

/**
 * @param {object} opts
 * @param {object} opts.canvasRef      the one canvas, mounted for the session
 * @param {object} opts.searchFormRef  the center tile's search field
 * @param {object} opts.booksRef       the center tile's shelf of buttons
 * @param {object} opts.searchArrowRef the search badge's orbiting arrow
 * @param {object} opts.draw           assigned by this hook; called by `requestDraw`
 * @param {object} opts.anim           the running rearrangement, or null
 * @param {object} opts.keyboardUsed   gates the cursor ring - see render.js
 * @param {object} opts.cam            the live camera, a ref
 * @param {string} opts.mode           'map' or 'catalog'; hidden means no frames
 * @param {number} opts.blockedCount   rooms the reader's blocked tags removed, for the HUD
 */
export function useMapRenderer({
  canvasRef,
  searchFormRef,
  booksRef,
  searchArrowRef,
  draw,
  anim,
  keyboardUsed,
  cam,
  mode,
  layout,
  order,
  renderer,
  slideRenderer,
  cache,
  centreSlots,
  centreOverlay,
  blockedCount = 0,
}) {
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    // The pending frame's id, so it can be cancelled - not just a flag. This
    // closure captures `layout` and `order`, so a frame scheduled through it
    // and left to fire after the effect has been rebuilt repaints the state
    // this render pass replaced. That is a real frame of the old map, arriving
    // after the new one and winning, which is what a stale draw looks like.
    let pending = 0;

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
      if (searchEl || booksEl || arrowEl) {
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
      const stats =
        running?.board
          ? slideRenderer.draw({
              ctx, width: w, height: h, dpr, cam: running.cam,
              board: running.board, origin: running.origin, motions: running.motions,
              genericIndexAt: layout.genericIndexAt,
            })
          : renderer.draw({
              ctx, width: w, height: h, dpr, cam: cam.current,
              layout: showing.layout, order: showing.order, centreSlots,
              cursor: keyboardUsed.current ? cursorCell(cam.current) : null,
            });

      const hud = document.getElementById('hud');
      if (running?.board && hud) {
        const pct = Math.round((100 * Math.min(running.show.totalMs, performance.now() - running.t0)) / running.show.totalMs);
        hud.textContent =
          `rearranging · ${pct}% · ${running.motions.length} lines moving · ` +
          `level ${stats.level} · ${stats.blank} blank · ${cache.size()} cached` +
          (blockedCount ? ` · ${blockedCount} blocked` : '');
      } else if (hud) {
        const size = pyramidSizeOf(stats.level);
        const over = cache.overBudget();
        hud.textContent =
          `${stats.cells} cells · ${stats.drawn} drawn · ` +
          `level ${stats.level} (${size.w}px) · ${stats.substituted} substituted · ` +
          `${stats.blank} blank · ` +
          `${cache.size()} cached${over ? ` (+${over} over budget)` : ''} · ` +
          `zoom ${Math.round(stats.zoom)} · ` +
          `x ${cam.current.x.toFixed(1)} y ${cam.current.y.toFixed(1)} · ` +
          `edge at r=${layout.boundaryRadius.toFixed(1)}` +
          (layout.gradedCount ? ` · ${layout.gradedCount} clustered` : '') +
          (blockedCount ? ` · ${blockedCount} blocked` : '');
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
    return () => {
      if (pending) cancelAnimationFrame(pending);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerdown', onDown);
    };
  }, [
    canvasRef, searchFormRef, booksRef, searchArrowRef, draw, anim, keyboardUsed,
    layout, order, renderer, slideRenderer, cache, cam, centreSlots, centreOverlay, mode, blockedCount,
  ]);
}
