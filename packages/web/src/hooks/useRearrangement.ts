/**
 * The rearrangement animation: sliding the library from one arrangement into
 * another, and the state machine that decides whether a layout/order change
 * gets that treatment or is simply drawn.
 *
 * Split out of `main.jsx` per `docs/state-architecture-plan.md` §3 step 5.
 * What was implicit before this - "the next layout change should animate" and
 * "here is the sentence for it" as two separate ref writes a caller had to
 * remember to make together - is now one call, `requestAnimation(note)`. That
 * also closes the search-error bug the plan names: a flag set before an
 * `await` and stranded when it threw is not expressible once the only way to
 * ask for an animation is to say so, with its note, in one place.
 *
 * `anim` stays a ref owned by `main.jsx` and is passed in rather than created
 * here, because `useMapRenderer` reads it every frame and the render loop
 * must not be rebuilt when it changes.
 */
import { useCallback, useLayoutEffect, useRef } from 'react';
import { buildRearrangement } from '../../../map/board.ts';
import { planMoves, applyMove } from '../../../map/illusion.ts';
import { CELL_ASPECT, overviewZoom, pxPerCell, type Camera } from '../lib/camera.ts';
import { createSlideshow } from '../lib/slide.ts';
import { PYRAMID, PREFETCH } from '../lib/pyramid.ts';
import { prefersReducedMotion } from './useMapCamera.ts';
import { perfSetPhase, perfDump, perfRecordPrepare } from '../lib/perfProbe.ts';
import type { MapLayout } from '../../../map/ordering.ts';
import type { Config } from '../../../config/config.ts';
import type { TileCache } from '../lib/tiles.ts';
import type { Board, Point } from '../../../map/moves.ts';
import type { RunningAnim } from './useMapRenderer.ts';

/**
 * The on-camera rectangle a rearrangement's target zoom implies, and the
 * pyramid level that zoom will actually want there - shared by
 * `prepareRearrangement` (before the flight) and the plan it builds, which
 * previously computed this same geometry again after landing. Correct for
 * exactly the flight `startRearrangement` runs, which only ever changes
 * zoom - never x/y (see the `-0.5`/`+0.5` cancellation there) - so `cam`'s
 * CURRENT position is already the landing position.
 */
function landingRectangle(cam: Camera, canvas: HTMLCanvasElement, targetZoom: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
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
   * before the throttled readiness-polling loop starts, so a caller gets it
   * as early as this hook can offer it. This hook stays renderer-agnostic -
   * it doesn't know or care what a caller does with the ids, only that
   * `main.tsx` wires it to the WebGL texture warmer
   * (`gl/warm.ts`) when `?webgl` is active. Optional, and doing nothing
   * when omitted, exactly like `announce`.
   */
  onPreparing?: (ids: ReadonlySet<number>, level: number) => void;
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
}: UseRearrangementOpts) {
  // Set by `requestAnimation` and consumed by the effect below. A slider drag
  // changes the layout too, and must not animate - so a caller has to ask.
  const animateNext = useRef(false);
  // What brought the change about, in the search's own voice - carried
  // alongside `animateNext` because they are one act, not two: see the file
  // comment above.
  const pendingNote = useRef('');
  const arrangement = useRef<{ layout: MapLayout; order: number[] } | null>(null);
  // What to do once the new arrangement has actually landed on screen - after
  // the slide (and, if parked, the fly back) rather than merely launched. Read
  // once by the effect below alongside `pendingNote`, for the same reason: a
  // caller asking for this one animation to be watched for should not also be
  // on the hook for the next one it did not ask about.
  const pendingOnSettledRef = useRef<(() => void) | null>(null);

  const requestAnimation = useCallback(
    (note = '', opts?: { onSettled?: () => void }) => {
      animateNext.current = true;
      pendingNote.current = note;
      pendingOnSettledRef.current = opts?.onSettled ?? null;
    },
    []
  );

  /**
   * Prepare a rearrangement completely - the plan AND every tile the
   * animation will show - before the camera moves at all, rather than
   * fetching mid-flight. The flight is itself the moment of peak contention
   * on a cold cache (§3.1), so fetches issued during it compete for the same
   * network/decode budget with nothing to fall back on; doing the work up
   * front is what keeps them off that critical path.
   *
   * Building the plan HERE rather than after landing also closes §3.7's
   * seam cost for free: the landing rectangle depends only on the camera's
   * CURRENT x/y (this flight never changes position, only zoom - see the
   * `-0.5`/`+0.5` cancellation in `startRearrangement`) and the target zoom,
   * both already known before the flight starts.
   *
   * The id set to fetch is NOT just `before`'s and `after`'s static viewport
   * rectangles. Verified directly against `board.ts`/`illusion.ts`: on a real
   * 2048-room corpus the rooms actually shown during a rearrangement run
   * 27-48% ahead of that static union, because `shiftRow`/`shiftCol` rotate a
   * whole line and the conveyor (`makeParker`/`makeAvailable`) stages a
   * needed value in from wherever it currently sits - which can be well
   * outside either rectangle, and is a real, load-bearing part of the
   * choreography rather than an edge case. So this simulates the actual
   * planned sequence with the real `applyMove`, snapshotting every on-camera
   * cell after each non-`swap` move (a `swap`'s both ends are guaranteed off
   * camera - `moves.ts` - so it can never change what is on-camera, and
   * skipping it is free correctness, not an approximation). Pure array work,
   * cheap regardless of corpus size - confirmed on a 2048-room case.
   *
   * Generic and center cells are skipped entirely: a generic's face is
   * fungible and resolved by POSITION at draw time (`slide.ts`'s "reads the
   * generic index at each tile's home board cell"), and both it and the
   * center tile are already pinned at corpus-load time (`main.tsx`), so
   * neither ever needs fetching here.
   *
   * Returns `null` when `buildRearrangement` declines (not animatable) -
   * before ever starting a flight for it, unlike the old post-landing check,
   * which flew out and back for nothing in exactly this case.
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

      // Issue requests capped at the same concurrency `cache.prefetch` uses
      // in the ordinary render path (`PREFETCH.concurrency`), not all of them
      // at once. Unthrottled, a cold-cache first rearrangement fires many
      // large fetches at the one moment the cache has nothing to fall back on,
      // and they compete for the same network/decode budget - a measured
      // regression on Android Chrome (`docs/performance-research.md` §9).
      // `cache.prefetch` itself can't be reused directly to get the cap: its
      // queue is cleared on every `beginFrame()`,
      // which keeps running for the CURRENT (pre-flight) arrangement while
      // this function awaits, and would drop anything not yet started before
      // its turn came up. So this drives `cache.request` (immediate, not
      // queued) at a capped number in flight instead, polling readiness with
      // `requestAnimationFrame` the same way the old wait loop did.
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

      // How long that took, and how much of it prepare gave up on - the number
      // the "delay before motion" side of the tradeoff lives on (§9).
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
   * The camera zooms out IN PLACE first - eased to `min(current zoom,
   * overviewZoom(...))` at the x/y it already has - rather than flying home to
   * the center. Widening the view is what gives the slide a wall of rooms to
   * work with; recentering was never necessary for that, and it cost every
   * reader their position on the map for every rearrangement, search
   * included. A reader already at or below that zoom gets no zoom flight at
   * all - the slide runs immediately against wherever they are, exactly as it
   * does when a favorite toggled live is asking for the same treatment
   * mid-browse.
   * `buildRearrangement` needs no particular position (the fixed tile - the
   * center room - not being in the on-camera rectangle at all is the ordinary
   * case, see `board.ts`). The guarantee is the same either way - nothing is
   * ever seen to teleport - and it is a guarantee about whatever rectangle the
   * camera is parked on, not about which rectangle that is. Returns false
   * when the change cannot be animated legally or the camera cannot be
   * treated as settled, which is the caller's cue to let it happen at once.
   */
  const startRearrangement = useCallback(
    async (
      before: { layout: MapLayout; order: number[] },
      after: { layout: MapLayout; order: number[] },
      onSettled: (() => void) | null
    ): Promise<boolean> => {
      const canvas = canvasRef.current;
      if (!canvas) return false;

      // Someone who asked for less motion gets the library rebuilt at once.
      // Returning false here is not a special case: it is the same answer
      // `buildRearrangement` gives for a change that cannot be animated
      // legally, and the caller already knows what to do with it. So reduced
      // motion costs one condition and reuses a path that is already written
      // and already tested, rather than adding a branch of its own.
      //
      // Before the flight, deliberately: the zoom-out exists to set up the
      // animation, so with no animation to set up there is no reason to move
      // the camera - and moving it unasked is itself the thing being avoided.
      if (prefersReducedMotion()) return false;

      // Hold the old arrangement on screen for the flight. `layout` and
      // `order` already describe the new one, and without this the map would
      // show it, fly to it, and only then slide it in from the arrangement it
      // had already replaced.
      anim.current = { before };
      // §2.1: tag every frame drawn from here through the flight and the
      // slide, so `perfDump()` can report all three phases apart.
      perfSetPhase('preparing');

      // Remembered so the map can return to it once the slide settles -
      // widening to the default zoom is only there to give the animation a
      // wall of rooms to work with, and leaving the camera at that zoom
      // afterwards fights whatever zoom the reader actually wanted (often
      // the opening view, to keep using the center tile's controls). Moot
      // when the camera never leaves in the first place.
      const returnZoom = cam.current.zoom;
      const target = Math.min(
        returnZoom,
        overviewZoom(canvas, config.camera.minVisibleCells, cam.current)
      );

      // Everything the animation will need - the plan and every tile it will
      // show - computed and fetched now, before the camera moves at all. See
      // `prepareRearrangement`'s own doc for why.
      const prepared = await prepareRearrangement(before, after, canvas, target);
      if (anim.current?.before !== before) return true; // superseded during prepare; not ours to undo
      if (!prepared) {
        // Not animatable - discovered before ever starting a flight for it,
        // unlike the old post-landing check.
        anim.current = null;
        perfSetPhase('idle');
        return false;
      }

      // A reader mid-search keeps their place in the field: the zoom flight
      // and the slide both move focus-stealing content under the browser, and
      // some browsers blur an input whose containing scroll position moves
      // out from under it. Refocus once the map is done moving rather than
      // leaving the reader to click back in.
      const searchInput = searchFormRef.current?.querySelector('input');
      const hadFocus = !!searchInput && document.activeElement === searchInput;

      perfSetPhase('flight');
      if (target !== returnZoom) {
        // Land before rearranging, rather than racing it: two animations
        // competing for the same attention and neither lands. It is also a
        // correctness requirement now that flights ease - the plan is made
        // against exactly the cells on screen, so it cannot be made until the
        // camera has stopped moving.
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
    [flyTo, isFlying, cam, config, requestDraw, canvasRef, searchFormRef, anim, prepareRearrangement]
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

    // In the catalog there is no map on screen to rearrange, and flying a
    // hidden camera to set up a slide nobody can see would be a second of
    // nothing. `layout`/`order` still updated, so returning to the map simply
    // shows the new arrangement at once - which is not a new path but the one
    // `buildRearrangement` already takes when a change cannot be animated
    // legally. `announce` speaks for it in whatever voice the current reading
    // uses.
    if (mode !== 'map') {
      animateNext.current = false;
      const note = pendingNote.current;
      pendingNote.current = '';
      announce(note);
      return;
    }

    if (!animateNext.current || !previous) {
      requestDraw();
      return;
    }
    animateNext.current = false;
    const onSettled = pendingOnSettledRef.current;
    pendingOnSettledRef.current = null;
    startRearrangement(previous, current, onSettled).then((started) => {
      if (!started) {
        // Nothing to watch for - the new arrangement is already on screen,
        // drawn at once rather than slid into. Whatever `onSettled` wanted to
        // do (typically: find where a room landed) is already true.
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
  }, [layout, order, mode, startRearrangement, requestDraw, announce]);

  return { requestAnimation, rearranging: () => anim.current != null };
}
