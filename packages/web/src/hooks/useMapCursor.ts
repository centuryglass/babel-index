/**
 * The keyboard cursor: where it is, what a reader hears about it, and what
 * every key over the map does.
 *
 * Split out of `main.jsx` per `docs/state-architecture-plan.md` §3 step 1. The
 * four pieces this hides - the granularity hysteresis, the boundary-crossing
 * latch, `cursorNow`, and the key switch itself - had no reader anywhere else
 * in that file, which is what made this the seam to cut first.
 *
 * It owns no camera. Everything that moves is `useMapCamera`'s (`flyTo`,
 * `nudgeBy`, `flightTarget`), because the cursor is DERIVED from the camera
 * rather than tracked beside it - see the block comment below, and the dead end
 * in `docs/design-history.md` that made the point the hard way.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cellDistance, type MapLayout } from '../../../map/ordering.ts';
import { describeCell, describeRoom, describeArrangement } from '../../../map/describe.ts';
import { nextRoom, type Cell } from '../../../map/nextRoom.ts';
import {
  CELL_ASPECT,
  pxPerCell,
  cursorCell,
  pickGranularity,
  ZOOM_STEP_FACTOR,
  type Camera,
  type CursorGranularity,
} from '../lib/camera.ts';
import type { RoomMeta } from '../../../map/metadata.ts';
import type { Config } from '../../../config/config.ts';

/** Same shape `roomAtPoint` returns (`picking.ts`'s `RoomPick`) - a real room, or a generic cell. */
type OpenCardArgs = { id: number; rank: number; x: number; y: number } | { generic: true; x: number; y: number };

interface FlyOpts {
  ms?: number;
}

interface UseMapCursorOpts {
  /** the current `createLayout` result */
  layout: MapLayout;
  /** room ids by rank */
  order: number[];
  /** joined per-room keywords and story */
  metadata: (RoomMeta | null)[] | null;
  /** the live camera ref */
  cam: { current: Camera };
  canvasRef: { current: HTMLCanvasElement | null };
  flyTo: (x: number, y: number, zoom?: number, opts?: FlyOpts) => Promise<boolean>;
  nudgeBy: (dx: number, dy: number, opts?: FlyOpts) => Promise<boolean>;
  flightTarget: () => Camera;
  /** `config.camera`, not the whole config */
  camera: Config['camera'];
  /** writes the one live region */
  setStatus: (status: string) => void;
  requestDraw: () => void;
  /** Enter over a room or a generic cell opens its card - only the center is unopenable */
  onOpenCard: (args: OpenCardArgs) => void;
  /** `/` reaches the live search field */
  goToSearch: () => void;
}

export function useMapCursor({
  layout,
  order,
  metadata,
  cam,
  canvasRef,
  flyTo,
  nudgeBy,
  flightTarget,
  camera,
  setStatus,
  requestDraw,
  onOpenCard,
  goToSearch,
}: UseMapCursorOpts) {
  // --- the keyboard cursor ---------------------------------------------------
  //
  // The cell under the camera center (accessibility-plan.md §4.2), and
  // DERIVED rather than separately tracked - that definition is the whole
  // design, so anything that moves the camera moves the cursor with it and
  // there is no second copy that can drift out of step. That includes the
  // edge's own glide easing back after a keyboard press crosses the boundary:
  // the camera moves, so the cursor does too, which is correct rather than a
  // conflict. (An earlier version kept a hand-maintained ref and exempted
  // keyboard landings from the glide to protect it - that got the causality
  // backwards, and disabled the boundary pushback for the whole session.)
  //
  // `cursor` is React state only because JSX needs it - the canvas's
  // `aria-label` and its nested, touch-reachable story/chips. The render loop
  // does NOT read it (see `cursorNow` below), for the same reason `cam` is a
  // ref: a re-render per keypress is fine, a torn-down and rebuilt render
  // EFFECT per keypress is not.
  const [cursor, setCursor] = useState<Cell>(() => cursorCell(cam.current));

  /**
   * Where the cursor is RIGHT NOW, for the keyboard's own next move.
   *
   * `flightTarget()` rather than `cam.current`: mid-flight the latter is the
   * interpolated position, so a second key press arriving in the same tick as
   * the first would compute its move from a camera that has not gone anywhere
   * yet, and the two presses would collapse into one. The flight's resolved
   * target is where the previous press actually put the cursor. Idle - which
   * includes while the glide is easing back from outside the region - it is
   * just the live camera, so the next press builds on where the reader has
   * actually drifted to rather than on where they last aimed.
   */
  const cursorNow = useCallback(() => cursorCell(flightTarget()), [flightTarget]);
  // The ring's position is derived from the live camera in the render loop,
  // and every camera change already requests a draw - `cursor` state exists
  // for JSX (the canvas's nested fallback content, below), not for the ring
  // itself, so this just keeps that content in step with the cell it names.
  // Whether the ring is shown AT ALL is a separate question, gated on canvas
  // focus rather than on keyboard use - see `useMapRenderer.ts`'s
  // `focus`/`blur` listeners.
  useEffect(() => {
    requestDraw();
  }, [cursor, requestDraw]);

  // Carries the announcement's granularity across cursor moves, so a zoom held
  // near the threshold does not flicker between naming a cell and naming a
  // region (the same hysteresis `pickLevel` uses for the pyramid, applied to
  // what is SAID rather than to what is drawn - §3.1).
  const granularityRef = useRef<CursorGranularity>('cell');

  // Whether the cursor is past the ranked content's edge, tracked so the
  // boundary is announced on the move that CROSSES it rather than on every
  // press once already outside - the room name would otherwise be drowned by
  // "edge of the library" on every single step through the far field.
  const wasBeyondBoundary = useRef(false);

  /**
   * Move the cursor to a specific cell, build what a reader should hear about
   * arriving there, and push it into the existing polite live region (Phase
   * A's `.note` status span) - not just the canvas's `aria-label`, because an
   * attribute change on an already-focused element is not reliably announced
   * across screen readers, and this is the one mechanism every AT actually
   * supports.
   *
   * `lead` is anything that happened to bring the cursor here - a search's
   * signals, a rearrangement's outcome. It goes in FRONT of the cell's own
   * name and inside the same live-region write, because two writes a moment
   * apart are two interruptions of whatever the reader was listening to, and
   * a polite region queues them rather than merging them.
   */
  const announceCursorMove = useCallback(
    (cell: Cell, lead = '') => {
      setCursor(cell);

      const canvas = canvasRef.current;
      const cellPxWidth = canvas ? pxPerCell(cam.current).x * (window.devicePixelRatio || 1) : 0;
      granularityRef.current = pickGranularity(cellPxWidth, granularityRef.current);

      const base =
        granularityRef.current === 'region'
          ? `the far field near (${cell.x}, ${cell.y}) - too far out to name a single room`
          : describeCell(cell.x, cell.y, { layout, order, metadata }).name;

      const beyond = cellDistance(cell.x, cell.y, CELL_ASPECT) > layout.boundaryRadius;
      const crossed = beyond !== wasBeyondBoundary.current;
      wasBeyondBoundary.current = beyond;

      const said =
        crossed && beyond
          ? `${base} - edge of the library; beyond here every wall is blank`
          : crossed
            ? `${base} - back within the library`
            : base;

      setStatus(lead ? `${lead}. ${said}` : said);
    },
    [cam, canvasRef, layout, order, metadata, setStatus]
  );

  /**
   * What a reader hears when the library rearranges under them
   * (accessibility-plan.md §4.3, §8 item 4).
   *
   * Three clauses, and each is a different question: what decided the ranking
   * (the search's own note, if a search is what caused this), what the map now
   * looks like as a whole, and what is under the cursor NOW. The third is the
   * one §4.3 promises and Phase C never wired up - standing still while the
   * library reorders around you and hearing nothing about what arrived is not
   * an accessible rearrangement, whatever the animation is doing.
   *
   * Read after the camera has settled rather than before, so the cursor it
   * names is the one the reader actually ends up at: an animated rearrangement
   * parks the camera on the center first, and saying the cell they left would
   * be describing somewhere they are no longer standing.
   *
   * `note` is the caller's, not this hook's: what caused a rearrangement is
   * something the rearrangement knows and the cursor does not, and whether it
   * has been consumed decides whether it survives to the next announcement.
   */
  const announceArrangement = useCallback(
    (note = '') =>
      announceCursorMove(
        cursorNow(),
        [note, describeArrangement(layout)].filter(Boolean).join('. ')
      ),
    [announceCursorMove, cursorNow, layout]
  );

  /** `?` - the screen-reader equivalent of peripheral vision (§4.2a). */
  const announceSurroundings = useCallback(() => {
    setStatus(describeSurroundings(layout, order, metadata, cursor));
  }, [layout, order, metadata, cursor, setStatus]);

  // The cursor's own story and keyword chips, nested inside the canvas as real
  // fallback content (accessibility-plan.md §4.2b, §4.4): "touch users get the
  // DOM... the cursor's contents", which a keyboard-only Enter would not give
  // them, since touch has nothing that corresponds to Enter. `tabIndex={-1}`
  // on the chips keeps them out of the desktop Tab sequence - the map is still
  // exactly one tab stop - while leaving them real, interactive elements a
  // touch screen reader's swipe navigation reaches regardless of tabindex.
  const cursorRoom = layout.roomAt(cursor.x, cursor.y, order);
  const cursorEntry = cursorRoom.center || cursorRoom.generic ? null : (metadata?.[cursorRoom.id] ?? null);
  // Named here rather than in the view, so `describeRoom` has exactly one
  // caller per reading of the corpus and the map cannot drift from the catalog
  // about what a room is called.
  const cursorDesc =
    cursorEntry && !cursorRoom.center && !cursorRoom.generic
      ? describeRoom(cursorRoom.id, cursorRoom.rank, order.length, cursorEntry)
      : null;

  // The canvas's own accessible name - what a reader hears landing on it for
  // the FIRST time, before any move has run `announceCursorMove` and pushed
  // anything into the live region. Always the plain per-cell name, independent
  // of the region/cell granularity split that only matters once movement is
  // in progress.
  const cursorLabel = useMemo(
    () => describeCell(cursor.x, cursor.y, { layout, order, metadata }).name,
    [cursor, layout, order, metadata]
  );

  const onMapKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      const dir = (
        {
          ArrowLeft: { dx: -1, dy: 0 },
          ArrowRight: { dx: 1, dy: 0 },
          ArrowUp: { dx: 0, dy: -1 },
          ArrowDown: { dx: 0, dy: 1 },
        } as Record<string, { dx: number; dy: number }>
      )[e.key];

      if (dir) {
        e.preventDefault();

        if (e.ctrlKey || e.metaKey) {
          const found = nextRoom(layout, cursorNow(), dir);
          if (found) {
            flyTo(found.x, found.y, undefined, { ms: camera.keyboardMoveMs });
            announceCursorMove(found);
          } else {
            setStatus('nothing further in that direction');
          }
          return;
        }

        let { dx, dy } = dir;
        if (e.shiftKey) {
          // A screenful: however many cells actually fit the canvas on that
          // axis, so the jump matches what the reader would otherwise have
          // panned across by hand.
          const canvas = canvasRef.current;
          const per = canvas ? pxPerCell(cam.current) : { x: 1, y: 1 };
          const cellsX = canvas ? Math.max(1, Math.round(canvas.clientWidth / per.x)) : 1;
          const cellsY = canvas ? Math.max(1, Math.round(canvas.clientHeight / per.y)) : 1;
          dx *= cellsX;
          dy *= cellsY;
        }
        // `nudgeBy`, not `flyTo`: this is a PAN, and pans are damped by the
        // map's resistance so pushing outward gets heavier - the same curve a
        // pointer drag gets, for parity. Inside the content region the damping
        // is 1, so this is still exactly one cell per press.
        //
        // The announcement therefore has to come from where the move actually
        // LANDED (`cursorNow()` re-read after the nudge, which sees the new
        // flight's target) rather than from a target computed here: far
        // outside, a press may not advance the cursor a whole cell at all, and
        // announcing the cell the reader aimed at would be describing a room
        // they are not going to reach. When the cell is unchanged the string is
        // identical, React does not re-render, and no live-region update fires
        // - silence being the honest answer to a press that went nowhere.
        //
        // Announced synchronously rather than on the flight landing: the
        // cursor's cell is settled the instant the key is processed, and
        // `keyboardMoveMs` exists to make that motion visible to sighted
        // readers, not to gate anything else. A rapid run of presses each
        // interrupts the previous flight - the same "a second flight replaces
        // the first" `flyTo` already gives Home - so key-repeat chases
        // smoothly rather than queuing animations.
        nudgeBy(dx, dy, { ms: camera.keyboardMoveMs });
        announceCursorMove(cursorNow());
        return;
      }

      // `+`/`-` are aliases for PageUp/PageDown - the convention every other
      // map-like UI uses, and cheap to support since it is the same target
      // math either way. `=` stands in for `+` because that is the bare key
      // under Shift on the layouts where `+` lives, and browsers report
      // whichever one the reader actually pressed.
      if (
        e.key === 'PageUp' || e.key === 'PageDown' ||
        e.key === '+' || e.key === '=' || e.key === '-'
      ) {
        e.preventDefault();
        // Flies to the CURSOR's own cell at a new zoom, which keeps the
        // cursor fixed across the zoom the way the old pixel-anchored
        // `zoomBy` did, and lands the camera exactly cell-centered.
        //
        // The zoom is built off `flightTarget()`, not `cam.current.zoom` -
        // `cam.current` is the INTERPOLATED value, which a flight in progress
        // has not necessarily moved from its start at all yet. Two PageDown
        // presses back to back both reading `cam.current.zoom` would compute
        // the SAME target and the second would silently cancel the first's
        // effect rather than compounding it - `flightTarget()` chains off the
        // fully-resolved target of whatever is already in flight instead.
        const zoomingIn = e.key === 'PageUp' || e.key === '+' || e.key === '=';
        const factor = zoomingIn ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR;
        const zoom = flightTarget().zoom * factor;
        const here = cursorNow();
        flyTo(here.x, here.y, zoom, { ms: camera.keyboardMoveMs });
        // The cursor cell itself does not move, but the granularity might, so
        // re-announce.
        announceCursorMove(here);
        return;
      }

      if (e.key === 'Home') {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const best = layout.cellOfRank(0);
          if (!best) {
            setStatus('no ranked rooms to jump to');
            return;
          }
          flyTo(best.x, best.y, camera.defaultZoom).then(
            (landed) => landed && announceCursorMove(best)
          );
        } else {
          flyTo(0, 0, camera.defaultZoom).then(
            (landed) => landed && announceCursorMove({ x: 0, y: 0 })
          );
        }
        return;
      }

      // The symmetric jump `Ctrl/Cmd+Home` doesn't have on its own: last
      // ranked room rather than first. Plain `End` is left unbound - there is
      // no cell it obviously means the way (0, 0) does for `Home`.
      if (e.key === 'End' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const best = layout.cellOfRank(order.length - 1);
        if (!best) {
          setStatus('no ranked rooms to jump to');
          return;
        }
        flyTo(best.x, best.y, camera.defaultZoom).then(
          (landed) => landed && announceCursorMove(best)
        );
        return;
      }

      if (e.key === 'Enter' || e.key === ' ') {
        // The center is the one cell this never opens - it's the controls,
        // not a room, and has nothing a card could show. A generic cell DOES
        // open: it has real content now (its shared alt caption, and the
        // "this is filler" description), and right-click/long-press already
        // opened it for a pointer - a keyboard-only reader had no way to
        // reach either without this.
        const here = cursorNow();
        const at = layout.roomAt(here.x, here.y, order);
        if (at.center) return;
        e.preventDefault();
        onOpenCard(
          at.generic ? { generic: true, x: here.x, y: here.y } : { id: at.id, rank: at.rank, x: here.x, y: here.y }
        );
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        goToSearch();
        return;
      }

      if (e.key === '?') {
        e.preventDefault();
        announceSurroundings();
      }
    },
    [
      layout, order, flyTo, nudgeBy, flightTarget, cursorNow, camera, canvasRef,
      announceCursorMove, announceSurroundings, cam, onOpenCard, goToSearch,
      setStatus,
    ]
  );
  // The room under the cursor, or null on the center cell and on wallpaper -
  // the two things that have no file to favorite.
  const cursorId = cursorRoom.center || cursorRoom.generic ? null : cursorRoom.id;

  return { cursorLabel, cursorEntry, cursorDesc, cursorId, onMapKeyDown, announceArrangement };
}

/**
 * `?`'s sentence: where you are, the nearest ranked room each way, and how far
 * the edge is. Module scope and pure, so it is one function of its arguments
 * rather than something that reads the hook's closure.
 */
function describeSurroundings(
  layout: MapLayout,
  order: number[],
  metadata: (RoomMeta | null)[] | null,
  cursor: Cell
): string {
  const here = describeCell(cursor.x, cursor.y, { layout, order, metadata }).name;

  const nearby = (
    [
      ['east', { dx: 1, dy: 0 }],
      ['west', { dx: -1, dy: 0 }],
      ['south', { dx: 0, dy: 1 }],
      ['north', { dx: 0, dy: -1 }],
    ] as [string, { dx: number; dy: number }][]
  )
    .map(([label, dir]) => {
      const found = nextRoom(layout, cursor, dir);
      if (!found) return null;
      const steps = Math.abs(found.x - cursor.x) + Math.abs(found.y - cursor.y);
      const id = layout.roomAt(found.x, found.y, order).id;
      return `Room ${id} ${steps} ${label}`;
    })
    .filter((s): s is string => Boolean(s));

  const edge = Math.max(0, layout.boundaryRadius - cellDistance(cursor.x, cursor.y, CELL_ASPECT));

  return [
    here,
    nearby.length ? nearby.join('; ') : 'nothing else ranked nearby',
    `the edge of the library is about ${Math.round(edge)} away`,
  ].join('. ');
}
