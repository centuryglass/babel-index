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
import { buildRearrangement } from '../../map/board.js';
import { planMoves, applyMove } from '../../map/illusion.js';
import { CELL_ASPECT, pxPerCell } from './camera.js';
import { createSlideshow } from './slide.js';
import { prefersReducedMotion } from './useMapCamera.js';

/**
 * @param {object} opts
 * @param {object} opts.layout            the current `createLayout` result
 * @param {number[]} opts.order           room ids by rank
 * @param {'map'|'catalog'} opts.mode
 * @param {{current: HTMLCanvasElement|null}} opts.canvasRef
 * @param {{current: HTMLFormElement|null}} opts.searchFormRef
 * @param {{current: object}} opts.cam    the live camera ref
 * @param {Function} opts.flyTo
 * @param {Function} opts.requestDraw
 * @param {object} opts.config            the whole config, not one section
 * @param {{current: object|null}} opts.anim
 * @param {Function} opts.announce
 *   `(note) => void` - what to say once this change has landed, in whatever
 *   voice the current reading uses. Map or catalog is the caller's call to
 *   make, not this hook's; it only ever hands over the note.
 */
export function useRearrangement({
  layout,
  order,
  mode,
  canvasRef,
  searchFormRef,
  cam,
  flyTo,
  requestDraw,
  config,
  anim,
  announce,
}) {
  // Set by `requestAnimation` and consumed by the effect below. A slider drag
  // changes the layout too, and must not animate - so a caller has to ask.
  const animateNext = useRef(false);
  // What brought the change about, in the search's own voice - carried
  // alongside `animateNext` because they are one act, not two: see the file
  // comment above.
  const pendingNote = useRef('');
  const arrangement = useRef(null);

  const requestAnimation = useCallback((note = '') => {
    animateNext.current = true;
    pendingNote.current = note;
  }, []);

  /**
   * Slide the library from one arrangement into another.
   *
   * The camera is parked on the center at the opening zoom first, and stays
   * there: the plan is made against exactly the cells that are on screen, and
   * the guarantee it offers - that nothing is ever seen to teleport - is a
   * guarantee about that rectangle. Returns false when the change cannot be
   * animated legally, which is the caller's cue to let it happen at once.
   */
  const startRearrangement = useCallback(
    async (before, after) => {
      const canvas = canvasRef.current;
      if (!canvas) return false;

      // Someone who asked for less motion gets the library rebuilt at once.
      // Returning false here is not a special case: it is the same answer
      // `buildRearrangement` gives for a change that cannot be animated
      // legally, and the caller already knows what to do with it. So reduced
      // motion costs one condition and reuses a path that is already written
      // and already tested, rather than adding a branch of its own.
      //
      // Before the flight, deliberately: the fly-home exists to set up the
      // animation, so with no animation to set up there is no reason to move
      // the camera - and moving it unasked is itself the thing being avoided.
      if (prefersReducedMotion()) return false;

      // Hold the old arrangement on screen for the flight. `layout` and
      // `order` already describe the new one, and without this the map would
      // show it, fly to it, and only then slide it in from the arrangement it
      // had already replaced.
      anim.current = { before };

      // Remembered so the map can return to it once the slide settles - the
      // fly-home to the default zoom is only there to give the animation a
      // wall of rooms to work with, and leaving the camera parked there
      // afterwards fights whatever zoom the reader actually wanted (often
      // the opening view, to keep using the center tile's controls).
      const returnZoom = cam.current.zoom;

      // A reader mid-search keeps their place in the field: the fly-home and
      // the slide both move focus-stealing content under the browser, and
      // some browsers blur an input whose containing scroll position moves
      // out from under it. Refocus once the map is done moving rather than
      // leaving the reader to click back in.
      const searchInput = searchFormRef.current?.querySelector('input');
      const hadFocus = !!searchInput && document.activeElement === searchInput;

      // Land before rearranging, rather than racing it: two animations
      // competing for the same attention and neither lands. It is also a
      // correctness requirement now that flights ease - the plan is made
      // against exactly the cells on screen, so it cannot be made until the
      // camera has stopped moving.
      const landed = await flyTo(0, 0, config.camera.defaultZoom);
      if (anim.current?.before !== before) return true; // superseded; not ours to undo
      if (!landed) {
        // The reader took the map. Not the moment to rebuild the library.
        anim.current = null;
        return false;
      }

      const parked = { ...cam.current };
      const perCell = pxPerCell(parked);
      const halfW = canvas.clientWidth / 2 / perCell.x;
      const halfH = canvas.clientHeight / 2 / perCell.y;
      const view = {
        x0: Math.floor(parked.x - halfW), x1: Math.ceil(parked.x + halfW),
        y0: Math.floor(parked.y - halfH), y1: Math.ceil(parked.y + halfH),
      };

      const built = buildRearrangement({ before, after, view, aspect: CELL_ASPECT });
      if (!built) {
        anim.current = null;
        return false;
      }

      const board = { width: built.width, height: built.height, cells: built.start.cells.slice() };
      const show = createSlideshow({
        board,
        moves: planMoves(built.start, built.end, built.bounds, built.fixed),
        apply: applyMove,
        timing: config.slide,
      });
      anim.current = {
        before, show, board, origin: built.origin, cam: parked, motions: [], t0: performance.now(),
      };

      const tick = () => {
        const running = anim.current;
        if (!running?.show) return; // interrupted
        const { done, motions } = running.show.advanceTo(performance.now() - running.t0);
        running.motions = motions;
        if (done) {
          anim.current = null;
          if (returnZoom !== config.camera.defaultZoom) {
            flyTo(0, 0, returnZoom).then((landedBack) => {
              if (landedBack && hadFocus) searchInput.focus();
            });
          } else if (hadFocus) {
            searchInput.focus();
          }
        }
        requestDraw();
        if (!done) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    },
    [flyTo, cam, config, requestDraw, canvasRef, searchFormRef, anim]
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
    startRearrangement(previous, current).then((started) => {
      if (!started) requestDraw();
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
