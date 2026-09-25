/**
 * The keyboard cursor: where it is, what a reader hears about it, and what
 * every key over the map does.
 *
 * It owns no camera. Everything that moves is `useMapCamera`'s (`flyTo`,
 * `nudgeBy`, `flightTarget`), because the cursor is derived from the camera
 * (see the `cursor` state).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cellDistance, type MapLayout } from '../../../map/ordering.ts';
import { describeCell, describeRoom, describeArrangement } from '../../../map/describe.ts';
import { nextRoom, type Cell } from '../../../map/nextRoom.ts';
import {
  CELL_ASPECT,
  overviewZoom,
  pxPerCell,
  cursorCell,
  pickGranularity,
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
  // The cell under the camera center, derived from the camera and never
  // tracked separately, so anything that moves the camera moves the cursor.
  // That includes the edge glide easing back after a keyboard move.
  //
  // `cursor` is React state only for JSX: the canvas's `aria-label` and its
  // nested, touch-reachable story/chips. The render loop derives the ring
  // from the live camera and does not read it, for the same reason `cam` is a
  // ref: a re-render per keypress is fine, rebuilding the render effect per
  // keypress is not.
  const [cursor, setCursor] = useState<Cell>(() => cursorCell(cam.current));

  /**
   * The cursor cell the keyboard's next move builds on: `cursorCell` of
   * `flightTarget()` (see `useMapCamera`'s `flightTarget`). Idle, including
   * while the glide eases back, that is the live camera, so the next press
   * builds on where the reader has drifted to.
   */
  const cursorNow = useCallback(() => cursorCell(flightTarget()), [flightTarget]);
  // The ring is drawn from the live camera, and every camera change already
  // requests a draw; this keeps the canvas's nested fallback content in step
  // with `cursor`. Whether the ring shows at all is gated on canvas focus, in
  // `useMapRenderer.ts`'s `focus`/`blur` listeners.
  useEffect(() => {
    requestDraw();
  }, [cursor, requestDraw]);

  // Carries the announcement's granularity across cursor moves, so a zoom held
  // near the threshold does not flicker between naming a cell and naming a
  // region (the same hysteresis `pickLevel` uses for the pyramid, applied to
  // what is said rather than what is drawn).
  const granularityRef = useRef<CursorGranularity>('cell');

  // Whether the cursor is past the ranked content's edge, tracked so the
  // boundary is announced on the move that crosses it rather than on every
  // press once already outside - the room name would otherwise be drowned by
  // "edge of the library" on every single step through the far field.
  const wasBeyondBoundary = useRef(false);

  /**
   * Move the cursor to a cell and announce the arrival through `setStatus`,
   * the page's one polite live region. The canvas's `aria-label` changes too,
   * but an attribute change on a focused element is not reliably announced
   * across screen readers.
   *
   * `lead` is whatever brought the cursor here - a search's signals, a
   * rearrangement's outcome. It goes in front of the cell's name in the same
   * write, because a polite region queues two writes as two interruptions.
   */
  const announceCursorMove = useCallback(
    (cell: Cell, lead = '') => {
      setCursor(cell);

      const canvas = canvasRef.current;
      const cellPxWidth = canvas ? pxPerCell(cam.current).x * (window.devicePixelRatio || 1) : 0;
      granularityRef.current = pickGranularity(
        cellPxWidth, granularityRef.current, camera.cursorGranularityPx, camera.granularityHysteresis
      );

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
    [cam, canvasRef, layout, order, metadata, setStatus, camera]
  );

  /**
   * What a reader hears when the library rearranges under them.
   *
   * Three clauses, and each is a different question: what decided the ranking
   * (the search's own note, if a search caused this), what the map now
   * looks like as a whole, and what is under the cursor now. The announcement
   * reads after the camera has settled, so the cursor it names is the one the
   * reader ends up at: an animated rearrangement
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

  /** `?` - the screen-reader equivalent of peripheral vision; see `describeSurroundings`. */
  const announceSurroundings = useCallback(() => {
    setStatus(describeSurroundings(layout, order, metadata, cursor));
  }, [layout, order, metadata, cursor, setStatus]);

  // The cursor's own story and keyword chips, nested inside the canvas as real
  // fallback content - touch users get this through the DOM while a
  // keyboard-only Enter would not reach it. `tabIndex={-1}` on the chips keeps
  // them out of the desktop Tab sequence - the map is still one tab stop -
  // while leaving them real, interactive elements a touch screen
  // reader's swipe navigation reaches regardless of tabindex.
  const cursorRoom = layout.roomAt(cursor.x, cursor.y, order);
  const cursorEntry = cursorRoom.center || cursorRoom.generic ? null : (metadata?.[cursorRoom.id] ?? null);
  // Named here, not in the view, so `describeRoom` has one caller per reading of the corpus and the map cannot drift from the catalog
  // about what a room is called.
  const cursorDesc =
    cursorEntry && !cursorRoom.center && !cursorRoom.generic
      ? describeRoom(cursorRoom.id, cursorRoom.rank, order.length, cursorEntry)
      : null;

  // The canvas's own accessible name - what a reader hears landing on it for
  // the first time, before any move has run `announceCursorMove` and pushed
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
        // `nudgeBy`, not `flyTo`: a pan is damped by the map's resistance the
        // same way a pointer drag is. Inside the content region the damping is
        // 1, so a press moves one cell.
        //
        // The announcement reads `cursorNow()` after the nudge, which sees the
        // new flight's target. Far outside, a press may not advance a whole
        // cell, and naming the aimed-at cell would describe a room the reader
        // won't reach. An unchanged cell yields an identical string, so React
        // does not re-render and nothing is re-announced.
        //
        // Announced on the keypress, not the landing: the cell is settled once
        // the key is processed, and `keyboardMoveMs` only makes the motion
        // visible. Each press replaces the previous flight, so key-repeat
        // chases smoothly instead of queuing animations.
        nudgeBy(dx, dy, { ms: camera.keyboardMoveMs });
        announceCursorMove(cursorNow());
        return;
      }

      // `+`/`-` are aliases for PageUp/PageDown. `=` stands in for `+`, since
      // it is the unshifted key on layouts where `+` needs Shift, and browsers
      // report whichever one was pressed.
      if (
        e.key === 'PageUp' || e.key === 'PageDown' ||
        e.key === '+' || e.key === '=' || e.key === '-'
      ) {
        e.preventDefault();
        // Flies to the cursor's own cell at the new zoom, so the cursor stays
        // fixed and the camera lands cell-centered. The zoom chains off
        // `flightTarget()` (see `useMapCamera`'s `flightTarget`).
        const zoomingIn = e.key === 'PageUp' || e.key === '+' || e.key === '=';
        const factor = zoomingIn ? camera.zoomStepFactor : 1 / camera.zoomStepFactor;
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
        const zoom = overviewZoom(canvasRef.current, camera.overviewCellsPerAxis, cam.current);
        if (e.ctrlKey || e.metaKey) {
          const best = layout.cellOfRank(0);
          if (!best) {
            setStatus('no ranked rooms to jump to');
            return;
          }
          flyTo(best.x, best.y, zoom).then(
            (landed) => landed && announceCursorMove(best)
          );
        } else {
          flyTo(0, 0, zoom).then(
            (landed) => landed && announceCursorMove({ x: 0, y: 0 })
          );
        }
        return;
      }

      // `Ctrl/Cmd+End` jumps to the last ranked room, mirroring `Ctrl/Cmd+Home`.
      // Plain `End` is unbound: no cell means to it what (0, 0) means to `Home`.
      if (e.key === 'End' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const best = layout.cellOfRank(order.length - 1);
        if (!best) {
          setStatus('no ranked rooms to jump to');
          return;
        }
        flyTo(best.x, best.y, overviewZoom(canvasRef.current, camera.overviewCellsPerAxis, cam.current)).then(
          (landed) => landed && announceCursorMove(best)
        );
        return;
      }

      if (e.key === 'Enter' || e.key === ' ') {
        // Opens the card for a room or a generic cell, matching right-click
        // and long press. The center never opens: it is the controls, not a
        // room, and a card has nothing to show for it.
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
 * `?`'s sentence: where the cursor is, the nearest ranked room in each
 * cardinal direction (straight-line walks with `nextRoom`), and how far the
 * edge is. Spoken on request, not on every move, so the live region stays
 * quiet.
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
