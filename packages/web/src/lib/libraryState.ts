/**
 * `Library`'s shared state as a pure reducer: a `LibraryState`, the
 * `LibraryAction`s that change it, and `reduce`.
 *
 * Holds the state that changes on reader intent, so the rules that tie its
 * pieces together (what a search does to the sort, what a reshuffle rerolls,
 * what "show in the catalog" leaves open) are testable without mounting
 * React. State a hook drives stays with that hook or in `main.tsx`: the
 * camera and the animation in the hooks' refs, the live region's text, the
 * rearrangement's preload flag. Anything derived from this state (the map
 * order, the layout, the catalog order) stays a `useMemo` in `main.tsx`.
 *
 * The reducer touches no storage and no url. `main.tsx` reads both once and
 * hands the results to `initLibraryState`, and persists through effects.
 */
import type { SortMode } from '../../../map/favorites.ts';
import type { Config } from '../../../config/config.ts';
import type { RoomPick } from './picking.ts';
import { HISTORY_SLOT_COUNT } from './center.ts';

/** The SSR route hint `app.ts`'s `renderPage` writes as `window.__INITIAL_ROUTE__`. */
export type InitialRoute =
  | { mode: 'catalog' | 'map'; room?: string }
  | { mode: 'help' }
  | { mode: 'about' };

/**
 * The overlay's room. `rank` is the catalog row's rank when a row opened it,
 * and null for a permalink, which names a room but no row; `overlayRank`
 * reads that room's place in the live map order.
 */
export interface OverlayRoom {
  id: number;
  rank: number | null;
}

type Paging = Config['catalog']['paging'];

export interface LibraryState {
  /** How many collection rooms the map places, from the dev panel's slider. `main.tsx` clamps it to the collection size. */
  roomCount: number;
  /**
   * Config's `map.contentRatio` baseline, moved by the dev panel's slider and
   * distill mode's flip (`useDistillMode.ts`).
   */
  contentRatio: number;
  /** Seeds which cells are content slots. */
  seed: number;
  /** Seeds which room lands where while no search runs. */
  orderSeed: number;
  /**
   * Which of the four readings of one ranking is in force. Session-only,
   * unlike favorites: a favorite list is a standing choice about the
   * library, and "sorted by favorites right now" is not.
   */
  sortMode: SortMode;
  /**
   * The permutation `'random'` sorts by (`favorites.ts`). Rerolled only on a
   * switch into `'random'`, so a favorite toggle or a map/catalog switch
   * never reshuffles an order on screen.
   */
  randomSortSeed: number;
  /**
   * Past searches, newest first, one center-shelf book per entry
   * (`persist.ts`'s `KEYS.history`). Capped at `HISTORY_SLOT_COUNT`, since
   * the wall is the only place it is shown.
   */
  history: string[];
  /** Sensitive-content tags the reader has blocked, from `HelpDialog`'s panel (`KEYS.blockedTags`). */
  blockedTags: string[];
  /** How the catalog advances (`KEYS.paging`). */
  paging: Paging;
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
  | { type: 'setRoomCount'; count: number }
  | { type: 'setContentRatio'; ratio: number }
  /**
   * The shuffle button: rerolls both seeds and returns the sort to
   * `'relevance'`, since any other sort would rearrange the new shuffle
   * before it showed (docs/agents/map.md, "Only four things recompute
   * placement"). The caller ends an active search for the same reason.
   */
  | { type: 'reorder' }
  /** Rerolls which cells are content slots, keeping the order. */
  | { type: 'rescatter' }
  /**
   * A switch to `mode`; the mode already in force is no switch. A switch
   * into `'random'` shuffles by `randomSeed`, which every other mode
   * ignores. The caller ends an active search (docs/agents/search.md,
   * "Distance from the center carries one meaning at a time").
   */
  | { type: 'setSort'; mode: SortMode; randomSeed: number }
  /**
   * A real (non-empty) search is about to run. Its term moves to the front
   * of the history, and any sort but `'relevance'` ends: a search and a
   * favorite sort are mutually exclusive (`docs/search_requirements.md`
   * SR-41). Clearing the search box is not this action and leaves the sort
   * alone.
   */
  | { type: 'searchStarted'; term: string }
  /** A "forget searches" control, on the shelf or in either reading: the whole history at once. */
  | { type: 'forgetSearches' }
  | { type: 'toggleBlockedTag'; tag: string }
  | { type: 'setPaging'; paging: Paging }
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
  /** The tile collection size, where the room-count slider starts. */
  total: number;
  /** Config's starting ratio and slot seed. */
  map: Pick<Config['map'], 'contentRatio' | 'slotSeed'>;
  /** The time at mount, which seeds the first room order and the first random sort. */
  now: number;
  /** What `persist.ts` loaded, or each key's fallback. */
  stored: { history: string[]; blockedTags: string[]; paging: Paging; seenHelpHint: boolean };
}

/** The state at mount, from the route hint, config and what `persist.ts` loaded. */
export function initLibraryState({ route, rooms, total, map, now, stored }: LibraryInit): LibraryState {
  return {
    roomCount: total,
    contentRatio: map.contentRatio,
    seed: map.slotSeed,
    orderSeed: now,
    sortMode: 'relevance',
    randomSortSeed: now,
    history: stored.history.slice(0, HISTORY_SLOT_COUNT),
    blockedTags: stored.blockedTags,
    paging: stored.paging,
    card: null,
    overlay: initialOverlay(route, rooms),
    catalogSpotlightId: null,
    helpOpen: route?.mode === 'help',
    showHelpHint: !stored.seenHelpHint,
    artistStatementOpen: route?.mode === 'about',
  };
}

/** A permalinked room, with no row rank of its own. */
function initialOverlay(route: InitialRoute | null, rooms: LibraryInit['rooms']): OverlayRoom | null {
  if ((route?.mode !== 'catalog' && route?.mode !== 'map') || !route.room) return null;
  const room = rooms.find((r) => r.file === route.room);
  return room ? { id: room.id, rank: null } : null;
}

/** The rank `overlay` shows: its row's, or a permalinked room's place in `order`, 0 when `order` does not hold it. */
export function overlayRank(overlay: OverlayRoom, order: readonly number[]): number {
  if (overlay.rank !== null) return overlay.rank;
  const rank = order.indexOf(overlay.id);
  return rank === -1 ? 0 : rank;
}

/**
 * `state` with `changes` applied, or `state` itself when nothing differs, so
 * React skips the re-render for an action that changes nothing.
 */
function patch(state: LibraryState, changes: Partial<LibraryState>): LibraryState {
  const keys = Object.keys(changes) as (keyof LibraryState)[];
  return keys.every((k) => Object.is(state[k], changes[k])) ? state : { ...state, ...changes };
}

/** `history` with `term` moved to the front, or `history` itself when it is already there. */
function pushHistory(history: string[], term: string): string[] {
  if (history[0] === term) return history;
  return [term, ...history.filter((t) => t !== term)].slice(0, HISTORY_SLOT_COUNT);
}

export function reduce(state: LibraryState, action: LibraryAction): LibraryState {
  switch (action.type) {
    case 'setRoomCount':
      return patch(state, { roomCount: action.count });
    case 'setContentRatio':
      return patch(state, { contentRatio: action.ratio });
    case 'reorder':
      return patch(state, { seed: state.seed + 1, orderSeed: state.orderSeed + 1, sortMode: 'relevance' });
    case 'rescatter':
      return patch(state, { seed: state.seed + 1 });
    case 'setSort':
      if (action.mode === state.sortMode) return state;
      return patch(state, {
        sortMode: action.mode,
        ...(action.mode === 'random' ? { randomSortSeed: action.randomSeed } : {}),
      });
    case 'searchStarted':
      return patch(state, { history: pushHistory(state.history, action.term), sortMode: 'relevance' });
    case 'forgetSearches':
      return state.history.length ? patch(state, { history: [] }) : state;
    case 'toggleBlockedTag':
      return patch(state, {
        blockedTags: state.blockedTags.includes(action.tag)
          ? state.blockedTags.filter((t) => t !== action.tag)
          : [...state.blockedTags, action.tag],
      });
    case 'setPaging':
      return patch(state, { paging: action.paging });
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
