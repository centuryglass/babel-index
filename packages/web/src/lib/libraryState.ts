/**
 * `Library`'s shared state as a pure reducer: a `LibraryState`, the
 * `LibraryAction`s that change it, and `reduce`.
 *
 * Holds state that changes on reader intent, so the rules that tie its
 * pieces together (what a search closes, what "show in the catalog" leaves
 * open) are testable without mounting React. Per-frame camera and animation
 * state stays in the hooks' refs, and anything derived from this state stays
 * a `useMemo` in `main.tsx`.
 *
 * The reducer touches no storage and no url. `main.tsx` reads both once and
 * hands the results to `initLibraryState`, and persists through effects.
 *
 * It covers the open overlay and dialog group. Issue #383 tracks moving
 * the rest of `Library`'s state here.
 */
import type { RoomPick } from './picking.ts';

/** The SSR route hint `app.ts`'s `renderPage` writes as `window.__INITIAL_ROUTE__`. */
export type InitialRoute =
  | { mode: 'catalog' | 'map'; room?: string }
  | { mode: 'help' }
  | { mode: 'about' };

/** A catalog overlay's room, and the rank it was opened at. */
export interface OverlayRoom {
  id: number;
  rank: number;
}

export interface LibraryState {
  /**
   * The map's room card, from right-click, long press, Enter on the cursor
   * or a ranked result. A modal dialog, so it names only the room or
   * generic cell, never an anchor point.
   */
  card: RoomPick | null;
  /**
   * The expanded room (`RoomOverlay`): tile at full size and the whole
   * story, which the catalog's fixed-height rows cannot show. Opened from a
   * catalog row, or at mount by a `/catalog/<slug>` or `/map/<slug>`
   * permalink, so it renders in both readings.
   */
  overlay: OverlayRoom | null;
  /**
   * A one-shot instruction for `CatalogView` to scroll to and mark a row,
   * cleared by `spotlightHandled`. Names a row to jump to, where `overlay`
   * names a room to open.
   */
  catalogSpotlightId: number | null;
  /** The "READ ME" dialog, from a reserved shelf book (`useCenterShelf.ts`'s `CENTER_OVERRIDES`). */
  helpOpen: boolean;
  /**
   * The one-time nudge toward the "READ ME" book. Opening help clears it,
   * and nothing sets it again.
   */
  showHelpHint: boolean;
  /**
   * The artist's statement, from the open book in the shelf's gap: a tap
   * routed through `centerBookAtPoint` on the map, a click in the catalog.
   */
  artistStatementOpen: boolean;
}

export type LibraryAction =
  /** Opens the card on a pick. A null pick (the center cell) closes it. */
  | { type: 'openCard'; card: RoomPick | null }
  | { type: 'closeCard' }
  | { type: 'openOverlay'; room: OverlayRoom }
  | { type: 'closeOverlay' }
  /** Closes the card and the overlay together (the debug runner's `closeCard`). */
  | { type: 'closeRoom' }
  /**
   * A keyword search from a card or overlay. Both close: a search rebuilds
   * the ranking, and each names a position that would then hold another
   * room.
   */
  | { type: 'keywordSearch' }
  /**
   * "Show in the catalog" from the card or the overlay: spotlight the row
   * and close whichever named the room. The caller switches the reading.
   */
  | { type: 'showInCatalog'; id: number }
  | { type: 'spotlightHandled' }
  /** A switch between map and catalog. The card belongs to the map, so it closes. */
  | { type: 'modeChange' }
  | { type: 'openHelp' }
  | { type: 'closeHelp' }
  | { type: 'openArtistStatement' }
  | { type: 'closeArtistStatement' };

export interface LibraryInit {
  /** `window.__INITIAL_ROUTE__`, or null on a plain `/`. */
  route: InitialRoute | null;
  /** The manifest's rooms, to resolve a permalink's file stem to an id. */
  rooms: readonly { id: number; file: string }[];
  /** The map order at mount, which gives a permalinked overlay its rank. */
  order: readonly number[];
  /** Whether the reader has been shown the help hint before (`KEYS.seenHelpHint`). */
  seenHelpHint: boolean;
}

/** The state at mount, from the route hint and what `persist.ts` loaded. */
export function initLibraryState({ route, rooms, order, seenHelpHint }: LibraryInit): LibraryState {
  return {
    card: null,
    overlay: initialOverlay(route, rooms, order),
    catalogSpotlightId: null,
    helpOpen: route?.mode === 'help',
    showHelpHint: !seenHelpHint,
    artistStatementOpen: route?.mode === 'about',
  };
}

/** A permalinked room, at its rank in `order`; rank 0 when the order does not hold it. */
function initialOverlay(
  route: InitialRoute | null,
  rooms: LibraryInit['rooms'],
  order: LibraryInit['order'],
): OverlayRoom | null {
  if ((route?.mode !== 'catalog' && route?.mode !== 'map') || !route.room) return null;
  const room = rooms.find((r) => r.file === route.room);
  if (!room) return null;
  const rank = order.indexOf(room.id);
  return { id: room.id, rank: rank === -1 ? 0 : rank };
}

/**
 * `state` with `changes` applied, or `state` itself when nothing differs, so
 * React skips the re-render for an action that changes nothing.
 */
function patch(state: LibraryState, changes: Partial<LibraryState>): LibraryState {
  const keys = Object.keys(changes) as (keyof LibraryState)[];
  return keys.every((k) => Object.is(state[k], changes[k])) ? state : { ...state, ...changes };
}

export function reduce(state: LibraryState, action: LibraryAction): LibraryState {
  switch (action.type) {
    case 'openCard':
      return patch(state, { card: action.card });
    case 'closeCard':
      return patch(state, { card: null });
    case 'openOverlay':
      return patch(state, { overlay: action.room });
    case 'closeOverlay':
      return patch(state, { overlay: null });
    case 'closeRoom':
    case 'keywordSearch':
      return patch(state, { card: null, overlay: null });
    case 'showInCatalog':
      return patch(state, { card: null, overlay: null, catalogSpotlightId: action.id });
    case 'spotlightHandled':
      return patch(state, { catalogSpotlightId: null });
    case 'modeChange':
      return patch(state, { card: null });
    case 'openHelp':
      return patch(state, { helpOpen: true, showHelpHint: false });
    case 'closeHelp':
      return patch(state, { helpOpen: false });
    case 'openArtistStatement':
      return patch(state, { artistStatementOpen: true });
    case 'closeArtistStatement':
      return patch(state, { artistStatementOpen: false });
  }
}
