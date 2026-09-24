/**
 * The rearrangement animation: sliding the library from one arrangement into
 * another, and the state machine that decides whether a layout/order change
 * gets that treatment or is simply drawn.
 *
 * A caller asks for an animation with one call, `requestAnimation(note)`,
 * which sets the animate flag and the announcement together. The next
 * layout/order change consumes both, so a flag cannot be left set without its
 * note, or stranded by a throw between two separate writes.
 *
 * `anim` stays a ref owned by `main.tsx` and is passed in rather than created
 * here, because `useMapRenderer` reads it every frame and the render loop
 * must not be rebuilt when it changes.
 */
import { useCallback, useLayoutEffect, useRef } from 'react';
import { buildRearrangement } from '../../../map/board.ts';
import { planMoves, applyMove } from '../../../map/illusion.ts';
import { CELL_ASPECT, overviewZoom, pxPerCell, type Camera } from '../lib/camera.ts';
import { centerCellRect, areSpinesLegible, overlapsViewport } from '../lib/center.ts';
import type { LoadingAnimation } from '../lib/loadingAnimation.ts';
import { createSlideshow } from '../lib/slide.ts';
import { PYRAMID, PREFETCH, DPR_CAP } from '../lib/pyramid.ts';
import { prefersReducedMotion } from './useMapCamera.ts';
import { perfSetPhase, perfDump, perfRecordPrepare } from '../lib/perfProbe.ts';
import type { MapLayout } from '../../../map/ordering.ts';
import type { Config } from '../../../config/config.ts';
import type { TileCache } from '../lib/tiles.ts';
import type { Board, Point } from '../../../map/moves.ts';
import type { RunningAnim } from './useMapRenderer.ts';

/**
 * The on-camera rectangle a rearrangement's target zoom implies, and the
 * pyramid level that zoom will want there. Valid before the flight because
 * `startRearrangement`'s flight changes only zoom, never x/y (see the
 * `-0.5`/`+0.5` cancellation there), so `cam`'s current position is already
 * the landing position.
 */
function landingRectangle(cam: Camera, canvas: HTMLCanvasElement, targetZoom: number) {
  const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
  const cellPx = pxPerCell({ ...cam, zoom: targetZoom });
  const level = PYRAMID.idealLevel({ w: cellPx.x * dpr, h: cellPx.y * dpr });
  const halfW = canvas.clientWidth / 2 / cellPx.x;
  const halfH = canvas.clientHeight / 2 / cellPx.y;
  const view = {
    x0: Math.floor(cam.x - halfW), x1: Math.ceil(cam.x + halfW),
    y0: Math.floor(cam.y - halfH), y1: Math.ceil(cam.y + halfH),
  };
  return { level, view };
}

interface UseRearrangementOpts {
  /** the current `createLayout` result */
  layout: MapLayout;
  /** room ids by rank */
  order: number[];
  mode: 'map' | 'catalog';
  canvasRef: { current: HTMLCanvasElement | null };
  searchFormRef: { current: HTMLFormElement | null };
  /** the live camera ref */
  cam: { current: Camera };
  flyTo: (x: number, y: number, zoom?: number) => Promise<boolean>;
  /** synchronous "is the camera mid-flight right now" - see `useMapCamera.ts` */
  isFlying: () => boolean;
  requestDraw: () => void;
  /** the whole config, not one section */
  config: Config;
  anim: { current: RunningAnim | null };
  /** the tile cache - fetched and awaited for the incoming arrangement before the flight, see `prepareRearrangement` */
  cache: TileCache;
  /**
   * `(note) => void` - what to say once this change has landed, in whatever
   * voice the current reading uses. Map or catalog is the caller's call to
   * make, not this hook's; it only ever hands over the note.
   */
  announce: (note: string) => void;
  /**
   * Fired once per `prepareRearrangement`, with the ids/level it just
   * computed by simulating the plan - see that function's own doc for why
   * that set is not just the static before/after viewport union. Fired
   * before the throttled fetch loop starts. The hook stays renderer-agnostic;
   * `main.tsx` wires this to the WebGL texture warmer (`gl/warm.ts`) when the
   * WebGL renderer is in use. Optional.
   */
  onPreparing?: (ids: ReadonlySet<number>, level: number) => void;
  /**
   * The center-tile loading indicator, or null when none is deployed. Played
   * while `prepareRearrangement` fetches, and held to a full cycle boundary
   * before the flight, but only when the center book is on screen to show
   * it. A ref so it can be cancelled by the map-interrupt path in the
   * render hooks (`useMapRenderer.ts`'s onDown) as well as here.
   */
  loadingAnim?: { current: LoadingAnimation | null };
  /**
   * `(preparing) => void` - toggled around the same preload window as the
   * center-tile indicator (`prepareRearrangement` through the loading
   * indicator's cycle-boundary wait), but unconditionally rather than
   * gated on the center book being on screen - `SearchIcon.tsx`'s
   * `SearchOrbitSpinner`, the search badge's own affordance for the same
   * far-field case. Optional.
   */
  onPreparingChange?: (preparing: boolean) => void;
}

export function useRearrangement({
  layout,
  order,
  mode,
  canvasRef,
  searchFormRef,
  cam,
  flyTo,
  isFlying,
  requestDraw,
  config,
  anim,
  announce,
  cache,
  onPreparing,
  loadingAnim,
  onPreparingChange,
}: UseRearrangementOpts) {
  // Set by `requestAnimation` and consumed by the effect below. A slider drag
  // changes the layout too, and must not animate - so a caller has to ask.
  const animateNext = useRef(false);
  // What brought the change about, in the search's own voice. Written
  // together with `animateNext` by `requestAnimation`.
  const pendingNote = useRef('');
  const arrangement = useRef<{ layout: MapLayout; order: number[] } | null>(null);
  // What to do once the new arrangement has landed on screen, after the slide
  // and any zoom back. Consumed once by the layout effect, like `pendingNote`,
  // so it applies only to the animation it was requested with.
  const pendingOnSettledRef = useRef<(() => void) | null>(null);

  const requestAnimation = useCallback(
    (note = '', opts?: { onSettled?: () => void }) => {
      animateNext.current = true;
      pendingNote.current = note;
      pendingOnSettledRef.current = opts?.onSettled ?? null;
    },
    []
  );

  // Whether a search has claimed the indicator ahead of any rearrangement
  // plan existing for it - see `beginSearchPreload`. Distinct from
  // `anim.current`: that only exists once a plan is being prepared, which
  // for a search is after its network fetch and `rankHybrid` have both
  // finished. `startRearrangement` clears this the moment it runs,
  // transferring ownership to its own `playingLoad`/`onPreparingChange`
  // bookkeeping; every path that runs instead is responsible for calling
  // `cancelSearchPreload`.
  const searchPreloading = useRef(false);

  /**
   * Start the center-tile indicator and the search badge's spinner as soon
   * as a real search is submitted (`useSearch.ts`), so the indicator covers
   * the search's fetch and `rankHybrid` as well as the preload. Gated on
   * center-book visibility the same way as
   * `startRearrangement`'s own indicator start is (below); the badge
   * spinner is not, for the same far-field reason `onPreparingChange`'s doc
   * gives.
   */
  const beginSearchPreload = useCallback(() => {
    searchPreloading.current = true;
    const canvas = canvasRef.current;
    if (canvas) {
      const cellRect = centerCellRect(cam.current, { width: canvas.clientWidth, height: canvas.clientHeight });
      if (overlapsViewport(cellRect, canvas.clientWidth, canvas.clientHeight) && areSpinesLegible(cellRect)) {
        loadingAnim?.current?.play(requestDraw);
      }
    }
    onPreparingChange?.(true);
  }, [canvasRef, cam, loadingAnim, requestDraw, onPreparingChange]);

  /**
   * The release valve for every path that does not end in
   * `startRearrangement` claiming `beginSearchPreload`'s indicator: a failed
   * fetch, a search submitted while in catalog mode (whose rearrangement
   * effect never runs), a plan that turns out not to be animatable, or a
   * pointer grab before any of those happen (the render hooks' `onDown`). A
   * no-op once something already has - including once
   * `startRearrangement` itself has claimed it - so every caller can call it
   * unconditionally.
   */
  const cancelSearchPreload = useCallback(() => {
    if (!searchPreloading.current) return;
    searchPreloading.current = false;
    loadingAnim?.current?.cancel();
    onPreparingChange?.(false);
  }, [loadingAnim, onPreparingChange]);

  /**
   * Build the plan and fetch every tile the animation will show, before the
   * camera moves. Fetches issued mid-flight compete for the network/decode
   * budget at the moment a cold cache has nothing to fall back on.
   *
   * The plan can be built now because the landing rectangle depends only on
   * the camera's current x/y and the target zoom (see `landingRectangle`).
   *
   * The id set to fetch is larger than the union of `before`'s and `after`'s
   * viewports. `shiftRow`/`shiftCol` rotate a whole line, and the conveyor
   * (`makeParker`/`makeAvailable`) stages a needed value in from wherever it
   * sits, often outside both rectangles. So this replays the planned moves
   * with `applyMove`, snapshotting every on-camera cell after each non-`swap`
   * move. Skipping a `swap` is exact, since `illusion.ts` keeps both of its
   * ends off camera.
   *
   * Generic and center cells are skipped: a generic's face is resolved by
   * position at draw time (`docs/agents/map.md`), and both it and the center
   * tile are pinned at corpus-load time (`main.tsx`), so neither needs
   * fetching here.
   *
   * Returns `null` when `buildRearrangement` declines (not animatable), so
   * the caller falls back before any flight starts.
   */
  const prepareRearrangement = useCallback(
    async (
      before: { layout: MapLayout; order: number[] },
      after: { layout: MapLayout; order: number[] },
      canvas: HTMLCanvasElement,
      targetZoom: number
    ): Promise<{ board: Board; show: ReturnType<typeof createSlideshow>; origin: Point } | null> => {
      const { level, view } = landingRectangle(cam.current, canvas, targetZoom);

      const built = buildRearrangement({ before, after, view, aspect: CELL_ASPECT });
      if (!built) return null;
      const moves = planMoves(built.start, built.end, built.bounds, built.fixed);

      // Simulate the plan to find every room it will ever put on camera -
      // see this function's own doc for why the static rectangles undercount.
      const { xmin, xmax, ymin, ymax } = built.bounds;
      const ids = new Set<number>();
      const live = { width: built.width, height: built.height, cells: built.start.cells.slice() };
      const snapshot = () => {
        for (let y = ymin; y <= ymax; y++)
          for (let x = xmin; x <= xmax; x++) {
            const v = live.cells[y * built.width + x];
            if (typeof v === 'number') ids.add(v);
          }
      };
      snapshot();
      for (const mv of moves) {
        applyMove(live, mv);
        if (mv.type !== 'swap') snapshot();
      }
      onPreparing?.(ids, level);

      // Keep at most `PREFETCH.concurrency` requests in flight, the cap
      // `cache.prefetch` uses; unthrottled, a cold cache fires every fetch at
      // once and they contend for the same network/decode budget.
      // `cache.prefetch` itself can't be used: its queue is cleared on every
      // `beginFrame()`, which keeps running for the current arrangement while
      // this awaits, and would drop requests not yet started. So this drives
      // `cache.request` directly and polls readiness each animation frame.
      const prepareStart = performance.now();
      const deadline = prepareStart + config.slide.prepareTimeoutMs;
      const pending = [...ids];
      let next = 0;
      const inFlight = new Set<number>();
      if (pending.length > 0) {
        await new Promise<void>((resolve) => {
          const step = () => {
            for (const id of inFlight) if (cache.isReady(id, level)) inFlight.delete(id);
            while (inFlight.size < PREFETCH.concurrency && next < pending.length) {
              const id = pending[next++];
              cache.request(id, level);
              if (!cache.isReady(id, level)) inFlight.add(id);
            }
            if ((next >= pending.length && inFlight.size === 0) || performance.now() >= deadline) {
              resolve();
              return;
            }
            requestAnimationFrame(step);
          };
          step();
        });
      }

      // How long prepare took, and how many tiles it gave up on, for the perf
      // probe.
      let notReady = 0;
      for (const id of ids) if (!cache.isReady(id, level)) notReady++;
      perfRecordPrepare(performance.now() - prepareStart, ids.size, notReady);

      const board = { width: built.width, height: built.height, cells: built.start.cells.slice() };
      const show = createSlideshow({ board, moves, apply: applyMove, timing: config.slide });
      return { board, show, origin: built.origin };
    },
    [cam, cache, config, onPreparing]
  );

  /**
   * Slide the library from one arrangement into another.
   *
   * The camera first zooms out in place, eased to `min(current zoom,
   * overviewZoom(...))` at its current x/y, so the reader keeps their
   * position on the map. The wider view gives the slide a wall of rooms to
   * work with. A reader already at or below that zoom gets no flight, and
   * the slide runs where they are.
   *
   * `buildRearrangement` needs no particular position; the fixed center room
   * is usually outside the on-camera rectangle (see `board.ts`). The
   * no-teleport guarantee holds for whichever rectangle the camera is parked
   * on.
   *
   * Returns false when the change cannot be animated legally or the camera
   * cannot be treated as settled, which is the caller's cue to apply it at
   * once.
   */
  const startRearrangement = useCallback(
    async (
      before: { layout: MapLayout; order: number[] },
      after: { layout: MapLayout; order: number[] },
      onSettled: (() => void) | null
    ): Promise<boolean> => {
      const canvas = canvasRef.current;
      if (!canvas) {
        cancelSearchPreload();
        return false;
      }

      // Reduced motion rebuilds the library at once, through the same false
      // return as an unanimatable change. Checked before the flight, so the
      // camera does not move either.
      if (prefersReducedMotion()) {
        cancelSearchPreload();
        return false;
      }

      // Hold the old arrangement on screen for the flight. `layout` and
      // `order` already describe the new one, and without this the map would
      // show it, fly to it, and only then slide it in from the arrangement it
      // had already replaced.
      anim.current = { before };
      // Tag every frame drawn from here through the flight and the slide,
      // so `perfDump()` can report all three phases apart.
      perfSetPhase('preparing');

      // The zoom to return to once the slide settles, so the reader gets back
      // the view they had (often the opening view, to keep using the center
      // tile's controls). Unused when the camera never zooms out.
      const returnZoom = cam.current.zoom;
      const target = Math.min(
        returnZoom,
        overviewZoom(canvas, config.camera.overviewCellsPerAxis, cam.current)
      );

      // The center-tile indicator plays over the book's page while the
      // preload runs, only when that page is on screen and legible (the gate
      // the shelf's own titles use). The search badge's spinner
      // (`onPreparingChange`) is ungated: it covers the case where the center
      // book isn't visible.
      // If a search already claimed the indicator (`beginSearchPreload`),
      // ownership transfers here without calling `play()` again, which would
      // reset the cycle the reader is partway through.
      const alreadyLoading = searchPreloading.current;
      searchPreloading.current = false;
      const cellRect = centerCellRect(cam.current, {
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      });
      const showLoading =
        overlapsViewport(cellRect, canvas.clientWidth, canvas.clientHeight) &&
        areSpinesLegible(cellRect);
      const playingLoad = alreadyLoading || (showLoading ? loadingAnim?.current?.play(requestDraw) ?? false : false);
      onPreparingChange?.(true);

      // The plan and every tile it will show, before the camera moves (see
      // `prepareRearrangement`).
      const prepared = await prepareRearrangement(before, after, canvas, target);
      if (anim.current?.before !== before) {
        if (playingLoad) loadingAnim?.current?.cancel();
        onPreparingChange?.(false);
        return true; // superseded during prepare; not ours to undo
      }
      if (!prepared) {
        // Not animatable; discovered before any flight.
        if (playingLoad) loadingAnim?.current?.cancel();
        onPreparingChange?.(false);
        anim.current = null;
        perfSetPhase('idle');
        return false;
      }

      // Hold the flight until the indicator has played at least one full cycle
      // and reached a cycle boundary. It started when prepare did, so on a cold
      // cache it has been running the whole fetch; on a warm one this is the
      // minimum the reader sees it for. A grab mid-cycle cancels it
      // (the render hooks' onDown) and resolves this wait, which also ends the
      // rearrangement - re-checked below before the camera moves.
      if (playingLoad) {
        await loadingAnim?.current?.finish();
        if (anim.current?.before !== before) {
          onPreparingChange?.(false);
          return true;
        }
      }
      onPreparingChange?.(false);

      // A reader mid-search keeps their place in the field: the zoom flight
      // and the slide both move focus-stealing content under the browser, and
      // some browsers blur an input whose containing scroll position moves
      // out from under it. Refocus once the map is done moving rather than
      // leaving the reader to click back in.
      const searchInput = searchFormRef.current?.querySelector('input');
      const hadFocus = !!searchInput && document.activeElement === searchInput;

      perfSetPhase('flight');
      if (target !== returnZoom) {
        // Land before sliding. The plan is made against the cells on screen
        // at the landing zoom, so the slide cannot start while the camera is
        // still moving.
        const landed = await flyTo(cam.current.x - 0.5, cam.current.y - 0.5, target);
        if (anim.current?.before !== before) return true; // superseded; not ours to undo
        if (!landed) {
          // The reader took the map. Not the moment to rebuild the library.
          anim.current = null;
          perfSetPhase('idle');
          return false;
        }
      } else if (isFlying()) {
        // Something else already has the camera in the air (a flight from a
        // search, say). Not this call's place to fight it or wait it out -
        // the caller gets the same answer a legal-but-declined plan would.
        anim.current = null;
        perfSetPhase('idle');
        return false;
      }

      const parked = { ...cam.current };
      anim.current = {
        before, show: prepared.show, board: prepared.board, origin: prepared.origin,
        cam: parked, motions: [], t0: performance.now(),
      };
      perfSetPhase('slide');

      const tick = () => {
        const running = anim.current;
        if (!running?.show) return; // interrupted
        const { done, motions } = running.show.advanceTo(performance.now() - running.t0!);
        running.motions = motions;
        if (done) {
          anim.current = null;
          perfSetPhase('idle');
          perfDump();
          if (target !== returnZoom) {
            flyTo(parked.x - 0.5, parked.y - 0.5, returnZoom).then((landedBack) => {
              if (landedBack && hadFocus) searchInput.focus();
              onSettled?.();
            });
          } else {
            if (hadFocus) searchInput.focus();
            onSettled?.();
          }
        }
        requestDraw();
        if (!done) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    },
    [flyTo, isFlying, cam, config, requestDraw, canvasRef, searchFormRef, anim, prepareRearrangement, loadingAnim, onPreparingChange, cancelSearchPreload]
  );

  // Every change to what is on the map arrives here. Only the ones a control
  // asked to be animated are: the sliders change the layout on every drag, and
  // a rearrangement per frame would be neither legible nor affordable.
  //
  // `useLayoutEffect` so the hold is in place before the first paint of the new
  // arrangement. The drawing effect in `useMapRenderer` calls `render()` when
  // it is set up, and effects of the same kind run in declaration order - so an
  // ordinary effect here would paint one frame of the new library before the
  // hold could stop it.
  useLayoutEffect(() => {
    const current = { layout, order };
    const previous = arrangement.current;
    arrangement.current = current;

    // In the catalog there is no map on screen to rearrange. `layout`/`order`
    // still update, so returning to the map shows the new arrangement at once.
    // `announce` speaks in whatever voice the current reading uses.
    if (mode !== 'map') {
      // No map on screen to rearrange, so nothing below will ever claim a
      // preload a search already started.
      cancelSearchPreload();
      animateNext.current = false;
      const note = pendingNote.current;
      pendingNote.current = '';
      announce(note);
      return;
    }

    if (!animateNext.current || !previous) {
      cancelSearchPreload();
      requestDraw();
      return;
    }
    animateNext.current = false;
    const onSettled = pendingOnSettledRef.current;
    pendingOnSettledRef.current = null;
    startRearrangement(previous, current, onSettled).then((started) => {
      if (!started) {
        // Nothing to watch for: the new arrangement is already drawn on
        // screen, so whatever `onSettled` wanted to do (typically: find where
        // a room landed) can run now.
        requestDraw();
        onSettled?.();
      }
      // Announce the arrangement this effect was for, and only if it is still
      // the one on the map: `startRearrangement` reports true for a run that
      // was superseded mid-flight as well as for one that got going, and the
      // effect for the newer arrangement will announce that one itself.
      if (arrangement.current === current) {
        const note = pendingNote.current;
        pendingNote.current = '';
        announce(note);
      }
    });
  }, [layout, order, mode, startRearrangement, requestDraw, announce, cancelSearchPreload]);

  return { requestAnimation, beginSearchPreload, cancelSearchPreload, rearranging: () => anim.current != null };
}
