/**
 * The map, and every control that belongs to it.
 *
 * A presenter, not an owner: every piece of state it renders lives in
 * `Library`, because the catalog reads the same state and two copies would be
 * two chances to disagree. What is here is the markup and nothing else - the
 * frame loop is `useMapRenderer.js`, the camera is `useMapCamera.ts`, and the
 * search, the ranking and the rearrangement are all still in `main.jsx`.
 *
 * ### `display: contents`, and never unmounted
 *
 * The wrapper generates no box when shown, so the canvas and both center-tile
 * overlays keep positioning against `#root` exactly as they did before there
 * was a wrapper - wrapping has to cost nothing, or every imperative rect the
 * render loop writes shifts. Hidden, it is `display: none`, which takes the
 * subtree out of the accessibility tree along with the pixels.
 *
 * It is HIDDEN rather than unmounted, and that is load-bearing: `useMapCamera`
 * binds its pointer listeners once, in an effect that depends on the ref OBJECT
 * rather than on the element, so a canvas that unmounted would come back
 * holding the right camera, reporting the right HUD, and silently never panning
 * again. Keeping it mounted also keeps the tile cache and the pyramid's LRU
 * warm. See `docs/catalog-plan.md` §2.
 */
import type { FormEventHandler, KeyboardEventHandler, Ref } from 'react';
import { RoomDetails } from './RoomDetails.tsx';
import { SearchForm } from './SearchForm.tsx';
import { describeBook, BOOK_RECTS, CENTER_BOOK_PATH, type Slot as CentreSlot } from '../lib/center.ts';
import { TOUCH_DEBUG } from '../lib/touchDebug.ts';
import { DEBUG } from '../lib/debug.ts';
import { SearchGlyph, SearchOrbitArrow } from './SearchIcon.tsx';
import type { Description } from '../../../map/describe.ts';
import type { RoomMeta } from '../../../map/metadata.ts';
import type { SearchResult, MatchRange } from '../../../map/searchResult.ts';
import type { Manifest } from '../../../map/manifest.ts';

/** One slot on the center shelf, as `assignTitles()` (`center.ts`) returns it - or the row/column position it never fills. */
type Slot = CentreSlot | null;

/** The ranked listbox's own rows - `main.jsx`'s `searchResults`, not `SearchResult`. */
type SearchResultsList = { total: number; rooms: { id: number; x: number; y: number; rank: number; name: string }[] } | null;

/**
 * Each book's position inside the shelf container, as percentages.
 *
 * Computed once at module scope because the fractions never change - the whole
 * point of the container being the thing that moves. Per-axis, like everything
 * that touches this tile: `x`/`w` against the cell's width, `y`/`h` against its
 * height. One divisor for both would put every focus ring on the wrong book,
 * silently, exactly as it would stretch the art.
 */
const BOOK_STYLES = BOOK_RECTS.map((b) => ({
  left: `${b.x * 100}%`,
  top: `${b.y * 100}%`,
  width: `${b.w * 100}%`,
  height: `${b.h * 100}%`,
}));

export function MapView({
  mode,
  canvasRef,
  searchFormRef,
  booksRef,
  searchArrowRef,
  centerBookRef,
  onOpenArtistStatement,
  manifest,
  total,
  described,
  status,
  query,
  setQuery,
  onSearch,
  onClearSearch,
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
  onRescatter,
  onRecentre,
  history,
  onForgetSearches,
  onEnterCatalog,
}: {
  mode: 'map' | 'catalog';
  canvasRef: Ref<HTMLCanvasElement>;
  searchFormRef: Ref<HTMLFormElement>;
  booksRef: Ref<HTMLDivElement>;
  searchArrowRef: Ref<HTMLSpanElement>;
  centerBookRef: Ref<HTMLButtonElement>;
  onOpenArtistStatement: () => void;
  manifest: Manifest;
  total: number;
  described: number;
  status: string;
  query: string;
  setQuery: (query: string) => void;
  onSearch: FormEventHandler<HTMLFormElement>;
  onClearSearch: () => void;
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
  onRescatter: () => void;
  onRecentre: () => void;
  history: string[];
  onForgetSearches: () => void;
  onEnterCatalog: () => void;
}) {
  return (
    <>
      {/*
        The map, and everything that belongs to it. `display: contents` when
        shown, so wrapping changes no layout at all - the canvas and both
        center-tile overlays keep positioning against `#root` exactly as before
        - and `display: none` when hidden, which takes the whole subtree out of
        the accessibility tree along with the pixels.

        HIDDEN, never unmounted. The camera ref, the tile cache and the
        pyramid's per-level LRU all survive a trip through the catalog, so
        coming back is a repaint rather than a rebuild - and `useMapCamera`
        binds its pointer listeners once, against the ref OBJECT rather than the
        element, so a canvas that unmounted would come back with nothing bound
        at all. See `docs/catalog-plan.md` §2.
      */}
      <div className="map-view" hidden={mode !== 'map'}>
      {/*
        `role="application"`, scoped to exactly this element and nowhere else
        (accessibility-plan.md §4.2b): inside it, a screen reader's own browse-
        mode reading turns off and arrow keys reach the page instead, which is
        what lets them pan. That trade must not creep onto the panel, which is
        why this is the only application region in the document.

        One tab stop for the entire map: `tabIndex={0}` here and nothing else
        keyboard-reachable at the top level of this subtree, so Tab always
        leaves the map in one press. The chips nested below are `tabIndex={-1}`
        for exactly that reason - real, touch-reachable elements that do not
        lengthen the desktop tab sequence.

        `aria-label` is the STATIC name - what a reader hears arriving here for
        the first time. Everything after that arrives through the polite live
        region `announceCursorMove` writes to (`status`, below), because an
        attribute change on an already-focused element is not reliably
        announced across screen readers on its own.
      */}
      <canvas
        ref={canvasRef}
        role="application"
        tabIndex={0}
        aria-label={cursorLabel}
        onKeyDown={onMapKeyDown}
      >
        {/*
          The same component the card and the catalog render, not a second copy
          of the markup - `chipTabIndex={-1}` is the only difference, and it is
          what keeps the map exactly one tab stop while leaving the chips real
          elements a touch screen reader's swipe navigation still reaches.
          No score breakdown here: this is the cursor's contents, and a table
          of numbers read out on every arrow press is not peripheral vision.

          Guarded on `cursorEntry` rather than letting the component render its
          own empty state: the card's "No keywords recorded for this room" is
          right for something a reader deliberately opened, and wrong for a
          cursor that is sitting on wallpaper - which is four cells in five. The
          canvas's own aria-label already says "a blank wall"; saying it again
          in different words is noise on every arrow press.
        */}
        {cursorEntry && (
          <RoomDetails
            entry={cursorEntry}
            desc={cursorDesc}
            onKeyword={onKeyword}
            chipTabIndex={-1}
            highlight={highlight}
            tagLinks={tagLinks}
          />
        )}
      </canvas>
      {/*
        The live search field, on the center tile itself rather than in the
        panel. Always mounted - Playwright's `inputValue()` and React's
        controlled `value` both need it attached - but hidden by the
        stylesheet (`.center-search { display: none }`) until the render loop
        above finds it on screen and legible, at which point it takes over
        `display`/position directly. No `style` prop here on purpose: a React
        re-render (every keystroke touches `query`) would otherwise reapply
        whatever style this component declared and fight the imperative
        positioning every frame.
      */}
      <SearchForm
        formRef={searchFormRef}
        className="center-search"
        query={query}
        setQuery={setQuery}
        onSubmit={onSearch}
        onClear={onClearSearch}
        maxLength={maxQueryLength}
      />
      {/*
        The shelf, as a real control surface (accessibility-plan.md §3.3).
        Until now the center room's forty spines were painted pixels behind a
        hit-test: the application's PRIMARY interface - search history, and a
        browsable index of corpus keywords - reachable only by mouse or finger.
        These are the same forty slots `assignTitles` already returns and
        `composeSpines` already draws, mounted as buttons over the same rects.

        Positioned by the render loop above, in one style write on this
        container; the buttons inside are in percentages of it (BOOK_STYLES),
        so a pan costs one assignment rather than forty. `display: none` in the
        stylesheet is the pre-first-frame default, and the render loop takes it
        over from there - the same arrangement (and the same "no style prop
        here") as `.center-search` above.

        `pointer-events: none`, from the stylesheet, and that is deliberate:
        the canvas keeps every gesture, so a pan that crosses the shelf still
        pans. Focus is not a pointer API, so a keyboard reaches these anyway,
        and a sighted click keeps routing through `onTap` -> `bookAtPoint` ->
        `onBook`, which is the same function this button calls.
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
        The open book painted into a shelf gap - a distinct hotspot from the
        forty lettered spines above, reached the same one `onTap` path
        (`centerBookAtPoint` in main.tsx) for a sighted click and its own
        `onClick` for a keyboard Enter or a screen reader's activate, the same
        two-entry-point shape `.center-books` buttons use. Positioned and
        sized every frame over the WHOLE cell, exactly like `.center-books`
        itself - not its own rect - because the highlight is the traced SVG
        path (`CENTER_BOOK_PATH`, in the same 0-1 cell-fraction space as every
        other rect on this tile), not a box, and a `viewBox="0 0 1 1"` with
        `preserveAspectRatio="none"` is what stretches that per axis onto the
        cell exactly like `render.ts` stretches the tile image.
        `pointer-events: none` for the same reason as the shelf - the canvas
        keeps every gesture, so a pan starting here still pans. The hover
        highlight is a CSS class toggled by the render loop's own pointermove
        listener, since `pointer-events: none` means this element never sees
        `:hover` itself.
      */}
      <button
        ref={centerBookRef}
        type="button"
        className="center-book"
        aria-label="an artist's statement"
        onClick={onOpenArtistStatement}
      >
        {CENTER_BOOK_PATH && (
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
            <path d={CENTER_BOOK_PATH} />
          </svg>
        )}
      </button>
      {/*
        The search affordance - not part of the dev panel below (it has to
        survive `?debug` being off, since the panel does not) and not
        diegetic either; see `SearchIcon.tsx`. The arrow is a separate layer
        so `useMapRenderer` can rotate it every frame to point at wherever the
        center tile actually is on screen, which is why it needs its own ref.
      */}
      <button
        type="button"
        className="search-trigger search-icon-button"
        onClick={onGoToSearch}
        aria-label="search the library"
      >
        <SearchGlyph className="search-icon-glyph" />
        <SearchOrbitArrow ref={searchArrowRef} className="search-icon-arrow" />
      </button>
      {DEBUG && (
      <div className="panel">
        <h1>The Indexing of Babel</h1>
        <p className="sub">
          offline · {total} rooms in {manifest.directory?.split('/').slice(-1)[0]}
          {described > 0 && <> · {described} described</>}
        </p>

        {/*
          The ranked listbox: the lossless reading of a search, next to the map's
          lossy spatial one (accessibility-plan.md §3.2). A plain list of buttons
          rather than `role="listbox"` with arrow-key roving on purpose - that
          widget pattern needs the keyboard model phase C brings, and a listbox
          that does not implement roving is a broken widget, worse than none.
          Every button here is independently reachable by Tab today, which is
          what makes this the phase that ships before the map's keyboard
          interface (§5): it works with no arrow keys at all.

          Absent entirely when there is no search, or when one ran and matched
          nothing worth clustering (`gradedCount === 0`) - the empty state IS the
          uniform map, and a list with nothing ranked in it would be noise.
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
          Both sliders carry an explicit `htmlFor`/`id` pair: the label is a
          SIBLING of its input rather than wrapping it, so without the
          association neither slider has an accessible name and both announce
          as a bare number.

          The LABEL is what has to carry the units, not `aria-valuetext` alone.
          A range reports "42" on its own, which is the one thing about it that
          was never in question - but Chrome 151 ignores `aria-valuetext` on a
          native `input[type=range]` (chromium 1194 honours it; the e2e caught
          the difference the first time CI ran a newer browser than the one it
          was written against). An accessible name is computed the same way
          everywhere, so "of 26" lives in the label and is safe. `aria-valuetext`
          stays for the browsers that do honour it, where it is what a DRAG
          announces - a value change re-reads the value, never the name.
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

        <div className="buttons">
          <button onClick={onReorder}>reorder</button>
          <button onClick={onRescatter}>rescatter</button>
          <button onClick={onRecentre}>center</button>
        </div>

        {/*
          The second way in. The primary one is the first book on the center
          shelf, but a book only exists while the spines are legible - zoomed in
          on the center - so a reader out in the far field, or one who never
          uses a pointer, would otherwise have to fly home before they could
          reach the catalog at all.
        */}
        <div className="buttons">
          <button className="mode-toggle" onClick={onEnterCatalog}>
            the catalog →
          </button>
        </div>

        {/*
          Search history now outlives the session, so there has to be a way to
          end it. Persisting someone's typed input without giving them a way to
          clear it is not a thing to ship - and the shelf is where that input is
          on display, so "forget" is a visible act rather than a settings page.
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
          The hint and the status are two different things and must not share a
          node. `role="status"` announces every change to its subtree, so a
          single node that falls back to the hint would read the instructions
          aloud again each time a status cleared. The hint is static and silent;
          the region below it starts empty and only ever holds what the map just
          did, which is exactly what a polite live region is for.
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
