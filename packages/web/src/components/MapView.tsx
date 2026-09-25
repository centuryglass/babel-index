/**
 * The map, and every control that belongs to it.
 *
 * A presenter: every piece of state it renders lives in `main.tsx`'s
 * `Library`, which the catalog reads too. The frame loop is
 * `useMapRenderer.ts`/`useMapRendererGL.ts` and the camera is
 * `useMapCamera.ts`.
 *
 * ### `display: contents`, and never unmounted
 *
 * The wrapper generates no box when shown, so the canvas and the
 * center-tile overlays position against `#root`. A real box would shift
 * every imperative rect the render loop writes. Hidden, it is
 * `display: none`, which also takes the subtree out of the accessibility
 * tree.
 *
 * It must be hidden, not unmounted: a remounted canvas gets no pointer
 * listeners and never pans again (docs/agents/catalog.md, "The map is
 * hidden, never unmounted").
 */
import type { FormEventHandler, KeyboardEventHandler, Ref } from 'react';
import { RoomDetails, type FavoriteControl } from './RoomDetails.tsx';
import { SearchForm } from './SearchForm.tsx';
import {
  describeBook, BOOK_RECTS, CENTER_BOOK_PATH,
  CENTER_SHUFFLE_RECT, CENTER_MINE_TOGGLE_RECT, CENTER_COUNT_TOGGLE_RECT,
  type Slot as CentreSlot,
} from '../lib/center.ts';
import { TOUCH_DEBUG } from '../lib/touchDebug.ts';
import { DEBUG } from '../lib/debug.ts';
import { SearchGlyph, SearchOrbitArrow, SearchOrbitSpinner } from './SearchIcon.tsx';
import type { Description } from '../../../map/describe.ts';
import type { RoomMeta } from '../../../map/metadata.ts';
import type { MatchRange } from '../../../map/searchResult.ts';
import type { Manifest } from '../../../map/manifest.ts';
import type { SortMode } from '../../../map/favorites.ts';
import type { CorpusErrorSource } from '../hooks/useCorpus.ts';

/** One slot on the center shelf, as `assignTitles()` (`center.ts`) returns it - or the row/column position it never fills. */
type Slot = CentreSlot | null;

/** The ranked list's rows - `main.tsx`'s `searchResults`, not `SearchResult`. */
type SearchResultsList = { total: number; rooms: { id: number; x: number; y: number; rank: number; name: string }[] } | null;

/**
 * Each book's position inside the shelf container, as percentages.
 *
 * Per-axis, like everything on this tile: `x`/`w` against the cell's width,
 * `y`/`h` against its height. One divisor for both puts every focus ring on
 * the wrong book. The fractions are fixed; the render loop moves the
 * container.
 */
const BOOK_STYLES = BOOK_RECTS.map((b) => ({
  left: `${b.x * 100}%`,
  top: `${b.y * 100}%`,
  width: `${b.w * 100}%`,
  height: `${b.h * 100}%`,
}));

/** Same per-axis percentage treatment as `BOOK_STYLES`, for a traced rect that may be absent. */
const rectStyle = (r: { x: number; y: number; w: number; h: number } | null) =>
  r && { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` };

const SHUFFLE_STYLE = rectStyle(CENTER_SHUFFLE_RECT);
const MINE_TOGGLE_STYLE = rectStyle(CENTER_MINE_TOGGLE_RECT);
const COUNT_TOGGLE_STYLE = rectStyle(CENTER_COUNT_TOGGLE_RECT);

export function MapView({
  mode,
  canvasRef,
  searchFormRef,
  booksRef,
  searchArrowRef,
  centerBookRef,
  controlsRef,
  favTooltipRef,
  onOpenArtistStatement,
  manifest,
  total,
  described,
  corpusErrors,
  status,
  query,
  setQuery,
  onSearch,
  onClearSearch,
  onSearchKeyDown,
  onControlKeyDown,
  onGoToSearch,
  maxQueryLength,
  cursorLabel,
  cursorEntry,
  cursorDesc,
  highlight,
  tagLinks,
  onMapKeyDown,
  onKeyword,
  centreSlots,
  showHelpHint,
  bookFocus,
  setBookFocus,
  onBook,
  onBooksKeyDown,
  searchResults,
  onOpenRoom,
  roomCount,
  setRoomCount,
  contentRatio,
  setContentRatio,
  onReorder,
  favorites,
  sortMode,
  onToggleSort,
  favoriteFor,
  cursorId,
  onRescatter,
  distillTooltipRef,
  onRecentre,
  history,
  onForgetSearches,
  onEnterCatalog,
  hasLoadingAnimation,
  onAnimationPreviewChange,
  preparingRearrangement,
}: {
  mode: 'map' | 'catalog';
  canvasRef: Ref<HTMLCanvasElement>;
  searchFormRef: Ref<HTMLFormElement>;
  booksRef: Ref<HTMLDivElement>;
  searchArrowRef: Ref<HTMLSpanElement>;
  centerBookRef: Ref<HTMLButtonElement>;
  controlsRef: Ref<HTMLDivElement>;
  favTooltipRef: Ref<HTMLDivElement>;
  onOpenArtistStatement: () => void;
  manifest: Manifest;
  total: number;
  described: number;
  corpusErrors: CorpusErrorSource[];
  status: string;
  query: string;
  setQuery: (query: string) => void;
  onSearch: FormEventHandler<HTMLFormElement>;
  onClearSearch: () => void;
  /** `Escape` in the field - back to the canvas, the same jump the shelf's `Escape` makes */
  onSearchKeyDown: KeyboardEventHandler<HTMLInputElement>;
  /** `Escape` on any plain center-tile control button - back to the canvas */
  onControlKeyDown: KeyboardEventHandler<HTMLButtonElement>;
  onGoToSearch: () => void;
  maxQueryLength: number;
  cursorLabel: string;
  cursorEntry: RoomMeta | null;
  cursorDesc: Description | null;
  highlight: { keyword: (text: string) => MatchRange[]; story: (text: string) => MatchRange[] } | null;
  tagLinks: Record<string, string> | null;
  onMapKeyDown: KeyboardEventHandler<HTMLCanvasElement>;
  onKeyword: (keyword: string) => void;
  centreSlots: Slot[];
  /** True until the reader has ever opened the help book - see main.tsx's `showHelpHint`. */
  showHelpHint: boolean;
  bookFocus: number;
  setBookFocus: (index: number) => void;
  onBook: (index: number) => void;
  onBooksKeyDown: KeyboardEventHandler<HTMLDivElement>;
  searchResults: SearchResultsList;
  onOpenRoom: (x: number, y: number, id: number, rank: number) => void;
  roomCount: number;
  setRoomCount: (count: number) => void;
  contentRatio: number;
  setContentRatio: (ratio: number) => void;
  onReorder: () => void;
  /** whether this deployment records favorites at all - false hides every favorite control */
  favorites: boolean;
  sortMode: SortMode;
  /** the center tile's favorites-sort switch: pressing the active mode again returns to 'relevance' */
  onToggleSort: (mode: SortMode) => void;
  /** one room's favorite state, or null for a generic cell or a disabled feature */
  favoriteFor: (id: number | null | undefined) => FavoriteControl | null;
  /** the room under the keyboard cursor, null on the center cell and on wallpaper */
  cursorId: number | null;
  onRescatter: () => void;
  /** the distill toggle's floating tooltip - the render loop positions it, via `distillTooltipRef` in both map-renderer hooks */
  distillTooltipRef: Ref<HTMLDivElement>;
  onRecentre: () => void;
  history: string[];
  onForgetSearches: () => void;
  onEnterCatalog: () => void;
  /** Whether a loading-animation manifest loaded - gates the dev-panel preview checkbox. */
  hasLoadingAnimation: boolean;
  /** Toggle the dev-panel's continuous loading-animation preview loop. */
  onAnimationPreviewChange: (on: boolean) => void;
  /** A rearrangement's preload is running - spins the search badge's ring. */
  preparingRearrangement: boolean;
}) {
  return (
    <>
      {/* `display: contents`/`display: none` per `mode`; see the file
          header's "`display: contents`, and never unmounted". */}
      <div className="map-view" hidden={mode !== 'map'}>
      {/*
        `role="application"` is scoped to this element only. Inside it a
        screen reader's browse mode turns off and arrow keys reach the page,
        which is what lets them pan. That trade must not spread to other
        controls, so this is the only application region in the document.

        The canvas is the map's first tab stop; docs/keyboard-controls.md,
        "Focus states and tab order", lists the rest. The chips nested
        below are `tabIndex={-1}`: real elements a touch screen reader
        reaches, adding no tab stops.

        `aria-label` is what a reader hears on arriving here. Every later
        change arrives through the app's one live region, fed by
        `announceCursorMove` (`useMapCursor.ts`) and rendered by `main.tsx`,
        because an attribute change on an already-focused element is not
        reliably announced.
      */}
      <canvas
        ref={canvasRef}
        role="application"
        tabIndex={0}
        aria-label={cursorLabel}
        onKeyDown={onMapKeyDown}
      >
        {/*
          The keyboard cursor's room, in the same component the card and the
          catalog render. `chipTabIndex={-1}` keeps the chips out of the tab
          sequence. No score breakdown: it would be read out on every arrow
          press.

          Rendered only when `cursorEntry` is set. On wallpaper the canvas's
          `aria-label` already names the cell (`describeCell`'s generic
          `name`), and `RoomDetails`'s empty state would repeat it on every
          arrow press.
        */}
        {cursorEntry && (
          <RoomDetails
            entry={cursorEntry}
            desc={cursorDesc}
            onKeyword={onKeyword}
            chipTabIndex={-1}
            highlight={highlight}
            tagLinks={tagLinks}
            favorite={favoriteFor(cursorId)}
            // The tile here is canvas-painted, not an `<img>` - there is no
            // `alt` to carry the sidecar's optional caption, so this is the
            // one place `RoomDetails` still renders it as text.
            showPicture
          />
        )}
      </canvas>
      {/*
        The on-tile favorite badge's tooltip - one floating element for the
        whole map, since badges are canvas-painted and have no DOM element
        to hold one. The render loop's `pointermove` listener positions and
        shows it imperatively, like `searchArrowRef`. `aria-hidden`: the
        card states a room's favorite status without a mouse.
      */}
      <div ref={favTooltipRef} className="favorite-tooltip" aria-hidden="true" />
      {/*
        The distill toggle's tooltip - one floating element, since the
        toggle is canvas-painted onto the center tile's lower right corner.
      */}
      <div ref={distillTooltipRef} className="distill-tooltip" aria-hidden="true" />
      {/*
        The live search field, on the center tile. Always mounted, since
        Playwright's `inputValue()` and React's controlled `value` both need
        it attached. The stylesheet hides it (`.center-search { display:
        none }`) until the render loop finds it on screen and legible, then
        the loop sets `display` and position directly. `SearchForm` states
        its no-`style`-prop rule.
      */}
      <SearchForm
        formRef={searchFormRef}
        className="center-search"
        query={query}
        setQuery={setQuery}
        onSubmit={onSearch}
        onClear={onClearSearch}
        onKeyDown={onSearchKeyDown}
        maxLength={maxQueryLength}
      />
      {/*
        The shelf's DOM buttons, over the painted spines' rects, so search
        history and the keyword index are reachable without a pointer.
        These are the slots `assignTitles` returns and `composeSpines`
        draws.

        The render loop positions this container in one style write per
        frame, and the buttons are percentages of it (`BOOK_STYLES`).
        `display: none` in the stylesheet is the pre-first-frame default;
        the loop sets it from then on, so this element takes no `style`
        prop.

        `pointer-events: none`, from the stylesheet, so a pan that crosses
        the shelf still pans. The keyboard still focuses these buttons. A
        sighted click routes through `onTap` -> `bookAtPoint` -> `onBook`,
        the same function the buttons call.
      */}
      <div
        ref={booksRef}
        className="center-books"
        role="toolbar"
        aria-label="the center room's shelf"
        onKeyDown={onBooksKeyDown}
      >
        {centreSlots.map((slot, i) =>
          slot?.text ? (
            <button
              key={i}
              type="button"
              data-book={i}
              className={showHelpHint && slot.action === 'help' ? 'hint' : undefined}
              tabIndex={i === bookFocus ? 0 : -1}
              style={BOOK_STYLES[i]}
              aria-label={describeBook(slot)}
              onFocus={() => setBookFocus(i)}
              onClick={() => onBook(i)}
            />
          ) : null
        )}
      </div>
      {/*
        The open book painted into a shelf gap, which opens the artist's
        statement. A sighted click goes through the canvas's `onTap` ->
        `centerBookAtPoint` (`center.ts`); `onClick` serves the keyboard and
        screen readers.

        Positioned and sized every frame over the whole cell, like
        `.center-books`. The highlight is the traced SVG path
        (`CENTER_BOOK_PATH`, in 0-1 cell fractions), and `viewBox="0 0 1 1"`
        with `preserveAspectRatio="none"` stretches it per-axis the way
        `render.ts` stretches the tile image. `pointer-events: none` means
        it never sees `:hover`, so the render loop's pointermove listener
        toggles the hover highlight as a class.
      */}
      <button
        ref={centerBookRef}
        type="button"
        className="center-book"
        aria-label="an artist's statement"
        onClick={onOpenArtistStatement}
        onKeyDown={onControlKeyDown}
      >
        {CENTER_BOOK_PATH && (
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
            <path d={CENTER_BOOK_PATH} />
          </svg>
        )}
      </button>
      {/*
        The reorder button and the favorites-sort switches, diegetic
        controls of the center tile (docs/agents/map.md, "The center room's
        controls"). The container is sized to the whole cell like
        `.center-books`, and each button is a percentage of it
        (`rectStyle`). `pointer-events: none` on the container keeps the
        canvas the gesture owner. A sighted click routes through `onTap` ->
        `shuffleButtonAtPoint`/`mineToggleAtPoint`/`countToggleAtPoint`
        (`center.ts`); `onClick` serves the keyboard and screen readers.
        The two switches render only while `favorites` is true.

        A `title` never pops up here, since pointer events never reach the
        button. The `.control-tooltip` child is the visible tooltip, shown
        by the `.hover` class the render loop's pointermove listener
        toggles, and on `:focus-visible`.
      */}
      <div ref={controlsRef} className="center-controls">
        {SHUFFLE_STYLE && (
          <button
            type="button"
            data-control="shuffle"
            style={SHUFFLE_STYLE}
            title="reorder the library"
            aria-label="reorder the library"
            onClick={onReorder}
            onKeyDown={onControlKeyDown}
          >
            <span className="control-tooltip">reorder the library</span>
          </button>
        )}
        {favorites && MINE_TOGGLE_STYLE && (
          <button
            type="button"
            data-control="mine"
            style={MINE_TOGGLE_STYLE}
            aria-pressed={sortMode === 'mine'}
            title="sort the library by my favorites"
            aria-label="sort the library by my favorites"
            onClick={() => onToggleSort('mine')}
            onKeyDown={onControlKeyDown}
          >
            <span className="control-tooltip">sort by my favorites</span>
          </button>
        )}
        {favorites && COUNT_TOGGLE_STYLE && (
          <button
            type="button"
            data-control="count"
            style={COUNT_TOGGLE_STYLE}
            aria-pressed={sortMode === 'count'}
            title="sort the library by most favorited"
            aria-label="sort the library by most favorited"
            onClick={() => onToggleSort('count')}
            onKeyDown={onControlKeyDown}
          >
            <span className="control-tooltip">sort by most favorited</span>
          </button>
        )}
      </div>
      {/*
        The search affordance, shown with or without `?debug` and not
        diegetic; see `SearchIcon.tsx`. The arrow is a separate layer with
        its own ref, so the render loop can rotate it every frame to point
        at the center tile.
      */}
      <button
        type="button"
        className={preparingRearrangement ? 'search-trigger search-icon-button preparing' : 'search-trigger search-icon-button'}
        onClick={onGoToSearch}
        onKeyDown={onControlKeyDown}
        aria-label="search the library"
      >
        <SearchGlyph className="search-icon-glyph" />
        <SearchOrbitArrow ref={searchArrowRef} className="search-icon-arrow" />
        <SearchOrbitSpinner className="search-icon-spinner" />
      </button>
      {DEBUG && (
      <div className="panel">
        <h1>The Index of Babel</h1>
        <p className="sub">
          offline · {total} rooms in {manifest.directory?.split('/').slice(-1)[0]}
          {described > 0 && <> · {described} described</>}
        </p>
        {corpusErrors.length > 0 && (
          <p className="sub corpus-error">
            failed to load {corpusErrors.join(', ')} - search is running degraded
          </p>
        )}

        {/*
          The ranked results list, the lossless reading of a search. It is
          debug-only, like the rest of this panel; issue #238 tracks giving
          it a reader-facing home. It is a plain list of buttons, each a
          Tab stop, not `role="listbox"`: a listbox needs arrow-key roving.

          Absent when there is no search, or when one matched nothing worth
          clustering (`gradedCount === 0`).
        */}
        {searchResults && searchResults.total > 0 && (
          <div className="row results" role="region" aria-labelledby="results-label">
            <label id="results-label">
              results <b>{searchResults.total}</b>
              {searchResults.total > searchResults.rooms.length &&
                ` (showing ${searchResults.rooms.length})`}
            </label>
            {/*
              `aria-setsize`/`aria-posinset` go on the `<li>`, not the button
              inside it: those two are valid on the `listitem` role (a `<li>`'s
              implicit role inside a `<ul>`) and are not valid on a bare
              `button` - axe's `aria-allowed-attr` rule would flag the wrong
              placement.
            */}
            <ul className="results-list">
              {searchResults.rooms.map((r) => (
                <li key={r.id} aria-setsize={searchResults.total} aria-posinset={r.rank + 1}>
                  <button className="result" onClick={() => onOpenRoom(r.x, r.y, r.id, r.rank)}>
                    {r.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/*
          Both sliders need their `htmlFor`/`id` pair: the label is a
          sibling of its input, so without it neither slider has an
          accessible name.

          The label carries the units, because engines disagree on
          `aria-valuetext` for a native `input[type=range]`
          (docs/agents/testing.md, "Assert on the accessible name, not raw
          ARIA attributes"). `aria-valuetext` stays for the engines that
          honour it, where it is what a drag announces.
        */}
        <div className="row">
          <label htmlFor="rooms-on-map">
            rooms on the map <b>{Math.min(roomCount, total)} of {total}</b>
          </label>
          <input
            id="rooms-on-map"
            type="range" min="1" max={total} value={Math.min(roomCount, total)}
            aria-valuetext={`${Math.min(roomCount, total)} of ${total} rooms`}
            onChange={(e) => setRoomCount(Number(e.target.value))}
          />
        </div>

        <div className="row">
          <label htmlFor="non-generic">
            non-generic <b>{Math.round(contentRatio * 100)}%</b>
          </label>
          <input
            id="non-generic"
            type="range" min="2" max="100" value={Math.round(contentRatio * 100)}
            aria-valuetext={`${Math.round(contentRatio * 100)}% of cells hold a corpus room`}
            onChange={(e) => setContentRatio(Number(e.target.value) / 100)}
          />
        </div>

        {/*
          Debug-only actions with no diegetic equivalent: `rescatter`
          reseeds which cells hold a room, and `center` resets the camera.
          Distill mode's control is on the center tile; see
          `distillToggle.ts`.
        */}
        <div className="buttons">
          <button onClick={onRescatter}>rescatter</button>
          <button onClick={onRecentre}>center</button>
        </div>

        {/*
          Debug-only: loop every loading-animation cycle in order, over the
          center book's page, so each can be eyeballed in place. Off unless a
          manifest actually loaded (`hasLoadingAnimation`). The current cycle's
          name shows in the HUD below - see `loadingAnimation.ts`.
        */}
        {hasLoadingAnimation && (
          <div className="row">
            <label htmlFor="anim-preview">loop loading animations</label>
            <input
              id="anim-preview"
              type="checkbox"
              onChange={(e) => onAnimationPreviewChange(e.currentTarget.checked)}
            />
          </div>
        )}

        {/*
          A way into the catalog from anywhere. The primary one is a book on
          the center shelf, which exists only while the spines are legible.
        */}
        <div className="buttons">
          <button className="mode-toggle" onClick={onEnterCatalog}>
            the catalog →
          </button>
        </div>

        {/*
          Clears the persisted search history. The primary control is the
          shelf's "forget searches" book (`useCenterShelf.ts`'s
          `overrides`); this button and the catalog bar's are copies of it.
          Absent when there is nothing to forget.
        */}
        {history.length > 0 && (
          <div className="buttons">
            <button
              className="forget"
              onClick={onForgetSearches}
              aria-label={`forget ${history.length} remembered ${history.length === 1 ? 'search' : 'searches'}`}
            >
              forget searches ({history.length})
            </button>
          </div>
        )}

        {/*
          The static hint, shown only while no status is live. It must never
          share a node with `role="status"`, or the hint is read aloud each
          time a status clears. The live region is `main.tsx`'s
          (docs/agents/catalog.md, "One live region for the whole app").
        */}
        <div className="note">
          {!status && 'drag to pan, scroll to zoom. right-click a room.'}
        </div>
      </div>
      )}
      {DEBUG && <div className="hud" id="hud" />}
      {TOUCH_DEBUG && <div className="touchlog" id="touchlog" />}
      </div>
    </>
  );
}
