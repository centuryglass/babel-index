/**
 * The map, and every control that belongs to it.
 *
 * A presenter, not an owner: every piece of state it renders lives in
 * `main.tsx`'s `Library`, because the catalog reads the same state and two
 * copies would be two chances to disagree. What is here is the markup; the
 * frame loop is `useMapRenderer.ts`/`useMapRendererGL.ts`, the camera is
 * `useMapCamera.ts`, and the search, the ranking and the rearrangement
 * live in `Library` too.
 *
 * ### `display: contents`, and never unmounted
 *
 * The wrapper generates no box when shown, so the canvas and the
 * center-tile overlays position against `#root` as if it were not there -
 * a real box would shift every imperative rect the render loop writes.
 * Hidden, it is `display: none`, which takes the subtree out of the
 * accessibility tree along with the pixels.
 *
 * It is hidden rather than unmounted, and that is load-bearing:
 * `useMapCamera` binds its pointer listeners once, in an effect that
 * depends on the ref object rather than the element, so a canvas that
 * unmounted would come back holding the right camera, reporting the right
 * HUD, and silently never panning again. Keeping it mounted also keeps the
 * tile cache and the pyramid's LRU warm. AGENTS.md's "The catalog, and the
 * two modes" owns the full rule and its e2e guard.
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

/** The ranked list's own rows - `main.tsx`'s `searchResults`, not `SearchResult`. */
type SearchResultsList = { total: number; rooms: { id: number; x: number; y: number; rank: number; name: string }[] } | null;

/**
 * Each book's position inside the shelf container, as percentages.
 *
 * Computed once at module scope because the fractions never change; the
 * container is the thing that moves. Per-axis, like everything that
 * touches this tile: `x`/`w` against the cell's width, `y`/`h` against its
 * height. One divisor for both would put every focus ring on the wrong
 * book, as silently as it would stretch the art.
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
  /** the distill toggle's own floating tooltip - the render loop positions it, via `distillTooltipRef` in both map-renderer hooks */
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
      {/* The map view wrapper - `display: contents`/`display: none` per
          `mode`, hidden not unmounted; see the *`display: contents`, and
          never unmounted* section above. */}
      <div className="map-view" hidden={mode !== 'map'}>
      {/*
        `role="application"`, scoped to exactly this element and nowhere
        else: inside it a screen reader's own browse-mode reading turns off
        and arrow keys reach the page, which is what lets them pan. That
        trade must not creep onto the panel below, so this is the only
        application region in the document.

        One tab stop for the entire map: `tabIndex={0}` here and nothing
        else keyboard-reachable at the top level of this subtree, so Tab
        leaves the map in one press. The chips nested below are
        `tabIndex={-1}` - real, touch-reachable elements that do not
        lengthen the desktop tab sequence.

        `aria-label` is the static name - what a reader hears arriving here
        for the first time. Everything after that arrives through the app's
        one live region, fed by `announceCursorMove` (`useMapCursor.ts`)
        and rendered by `main.tsx`: an attribute change on an
        already-focused element is not reliably announced across screen
        readers on its own.
      */}
      <canvas
        ref={canvasRef}
        role="application"
        tabIndex={0}
        aria-label={cursorLabel}
        onKeyDown={onMapKeyDown}
      >
        {/*
          The same component the card and the catalog render, not a second
          copy of the markup - `chipTabIndex={-1}` is the only difference,
          and it keeps the map exactly one tab stop while leaving the chips
          real elements a touch screen reader's swipe navigation reaches.
          No score breakdown here: this is the cursor's contents, and a
          table of numbers read out on every arrow press is not peripheral
          vision.

          Guarded on `cursorEntry` rather than letting `RoomDetails` render
          its own empty state: "No keywords recorded for this room" is
          right for something a reader deliberately opened, and wrong for
          a cursor sitting on wallpaper - the common case, one the canvas's
          own `aria-label` already names (`describeCell`'s generic `name`).
          Saying it again in different words is noise on every arrow press.
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
        The on-tile favorite badge's "add to favorites"/"remove from
        favorites" tooltip - one floating element for the whole map, not a
        `.control-tooltip` per badge, because badges are canvas-painted on
        every tile and none of them carries a DOM element to hold one.
        Positioned and shown imperatively from the render loop's
        `pointermove` listener, the same treatment `searchArrowRef` gets -
        not React state, since it moves on every pointer move rather than
        on a render. `aria-hidden`: it repeats what the badge's own state
        already is, and a room's favorite status is available on the card
        without a mouse.
      */}
      <div ref={favTooltipRef} className="favorite-tooltip" aria-hidden="true" />
      {/*
        The distill toggle's own tooltip - the same one-floating-element
        arrangement as the favorite badge's, for the same reason: the
        toggle is canvas-painted onto the center tile's lower right corner
        and has no DOM element of its own to carry one.
      */}
      <div ref={distillTooltipRef} className="distill-tooltip" aria-hidden="true" />
      {/*
        The live search field, on the center tile itself rather than in the
        panel. Always mounted - Playwright's `inputValue()` and React's
        controlled `value` both need it attached - but hidden by the
        stylesheet (`.center-search { display: none }`) until the render
        loop finds it on screen and legible, at which point the loop takes
        over `display` and position directly. The no-`style`-prop rule is
        `SearchForm`'s own.
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
        The shelf, as a real control surface: the painted spines get DOM
        buttons over the same rects, so the application's primary
        interface - search history, and a browsable index of corpus
        keywords - is reachable without a pointer. These are the slots
        `assignTitles` returns and `composeSpines` draws.

        The render loop positions this container in one style write per
        frame; the buttons inside are percentages of it (`BOOK_STYLES`), so
        a pan costs one assignment, not one per button. `display: none` in
        the stylesheet is the pre-first-frame default, and the loop takes
        it over from there - the same no-`style`-prop arrangement as
        `SearchForm`'s map copy.

        `pointer-events: none`, from the stylesheet: the canvas keeps every
        gesture, so a pan that crosses the shelf still pans. Focus is not a
        pointer API, so the keyboard reaches these anyway, and a sighted
        click routes through `onTap` -> `bookAtPoint` -> `onBook` - the
        same function these buttons call.
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
        The open book painted into a shelf gap - a distinct hotspot from
        the lettered spines above, with the same two entry points: the
        canvas's `onTap` -> `centerBookAtPoint` (`center.ts`) for a sighted
        click, `onClick` for a keyboard Enter or a screen reader's
        activate. Positioned and sized every frame over the whole cell,
        like `.center-books` itself, not its own rect: the highlight is the
        traced SVG path (`CENTER_BOOK_PATH`, in the same 0-1 cell-fraction
        space as every other rect on this tile), not a box, and
        `viewBox="0 0 1 1"` with `preserveAspectRatio="none"` stretches it
        per-axis onto the cell the way `render.ts` stretches the tile
        image. `pointer-events: none` so the canvas keeps every gesture -
        and, since that means this element never sees `:hover`, the render
        loop's pointermove listener toggles the hover highlight as a class.
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
        The favorites-sort switch and the reorder button - diegetic
        controls of the center tile (AGENTS.md's "The center room's controls"), in one
        container sized to the whole cell like `.center-books`, so a pan
        costs one style write regardless of how many buttons are inside.
        Each button is positioned in percentages of that container
        (`rectStyle`), and `pointer-events: none` on the container keeps
        the canvas the gesture owner: a pan starting on a button still
        pans. A sighted click routes through `onTap` ->
        `shuffleButtonAtPoint`/`mineToggleAtPoint`/`countToggleAtPoint`
        (`center.ts`), and `onClick` is the keyboard/screen-reader entry
        point, calling the same handlers. The reorder button needs no
        favorite store and is never hidden; the two switches are
        meaningless without one, so they render only while `favorites` is
        true - the same gate the debug panel's own sort buttons use.

        Each button carries a `title` (which can never pop up here:
        pointer events never reach the button) and a `.control-tooltip`
        child - a CSS bubble shown by the `.hover` class the render loop's
        pointermove listener toggles on the button, so hover feedback
        works despite `pointer-events: none`. It also shows on
        `:focus-visible`, which a `title` alone would not give a keyboard
        user.
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
        The search affordance - not part of the dev panel below (it has to
        survive `?debug` being off, since the panel does not) and not
        diegetic either; see `SearchIcon.tsx`. The arrow is a separate
        layer with its own ref so the render loop can rotate it every frame
        to point at wherever the center tile actually is on screen.
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
          The ranked list: the lossless reading of a search, next to the
          map's lossy spatial one. A plain list of buttons rather than
          `role="listbox"`: the listbox pattern needs arrow-key roving, and
          a listbox that does not implement roving is a broken widget,
          worse than none. Every button here is independently reachable by
          Tab.

          Absent entirely when there is no search, or when one ran and
          matched nothing worth clustering (`gradedCount === 0`) - the
          empty state is the uniform map, and a list with nothing ranked in
          it would be noise.
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
          Both sliders carry an explicit `htmlFor`/`id` pair: the label is
          a sibling of its input rather than wrapping it, so without the
          association neither slider has an accessible name and both
          announce as a bare number.

          The label carries the units, not `aria-valuetext` alone: engines
          disagree on `aria-valuetext` for a native `input[type=range]`
          (the split behind AGENTS.md's "Assert on the accessible name, not
          on raw ARIA attributes" - the e2e first caught it when CI moved
          to a newer Chromium than the test was written against). An
          accessible name is computed the same way everywhere, so the "of
          N" part lives in the label. `aria-valuetext` stays for the
          engines that honour it, where it is what a drag announces - a
          value change re-reads the value, never the name.
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
          Only `rescatter` and `center` remain debug-only; the rest of this
          row's actions have diegetic homes on the center tile (the
          shuffle control, the sort switches).
          Those two stay because neither has a diegetic equivalent:
          `rescatter` reseeds which cells hold a room at all, not the
          ranking, and `center` is a plain camera reset. Distill mode's own
          control is the center tile's lower right corner - see
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
          The second way into the catalog. The primary one is a book on the
          center shelf, but books only exist while the spines are legible -
          zoomed in on the center - so a reader in the far field, or one
          who does not use a pointer, would otherwise have to fly home
          before reaching the catalog at all.
        */}
        <div className="buttons">
          <button className="mode-toggle" onClick={onEnterCatalog}>
            the catalog →
          </button>
        </div>

        {/*
          Search history persists, so there has to be a way to end it:
          recording a reader's typed input with no way to clear it is not a
          thing to ship. The primary control is the shelf's bottom-right
          "forget searches" book (`useCenterShelf.ts`'s `overrides`); this
          button and the catalog bar's are plain copies of it. Absent when
          there is nothing to forget.
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
          The hint and the status are two different things and must not
          share a node: `role="status"` announces every change to its
          subtree, so a node that fell back to the hint would read the
          instructions aloud each time a status cleared. This `.note` shows
          only the static hint, and only while no status is live. The live
          region itself is `main.tsx`'s, outside both views (AGENTS.md's
          "One live region for the whole app").
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
