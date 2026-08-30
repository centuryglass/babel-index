/**
 * The catalog: the same corpus as one list, alphabetical by default and
 * ranked exactly like the map whenever a search is running - the two views'
 * idle orders are deliberately not the same array, since a shuffle is not a
 * list order anyone can read by eye (see `alphabeticalOrder` in catalog.js).
 *
 * The map is where you are STANDING - one cursor, whatever is around it. The
 * catalog is the RANKING - what matched, all of it, every tile unique and
 * nothing repeated. Different questions, which is why both exist and why
 * neither is a fallback for the other (see `docs/catalog-plan.md` §7 for what
 * that obliges, and why this is not the accessibility mode).
 *
 * Everything this has to be right about lives in `catalog.js` and is asserted
 * without a browser: which rooms are on a page, which pages stay mounted, how
 * tall a spacer must be, which pyramid level a thumbnail asks for. What is here
 * is the rendering and the scroll listener.
 *
 * ### Two paging modes, one mount rule
 *
 * Pagination mounts one page; scrolling mounts a window of them and replaces
 * the rest with spacers of exactly the height they would have occupied. That is
 * the ONLY difference - both slice `pageOf`, so a room cannot appear at a
 * different position depending on how the reader is paging.
 *
 * ### Why the rows are ordinary DOM and not a listbox
 *
 * `accessibility-plan.md` §3.7 argues the linear reading of the corpus should
 * be a `listbox` - it announces "3 of 511" natively and supports type-ahead.
 * That argument is about the panel's ranked results, which are bare names, and
 * it does not carry here: a listbox option cannot contain the keyword chips
 * every row has, and stripping the chips to win the role would cost more than
 * the role is worth. So this is a `<ul>` whose rows each carry a heading and one
 * primary control, and `aria-setsize`/`aria-posinset` on the `<li>` do the
 * "3 of 511" part by hand.
 */
import type { CSSProperties, FormEventHandler, Ref, RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { describeRoom } from '../../../map/describe.ts';
import type { Description } from '../../../map/describe.ts';
import type { RoomMeta } from '../../../map/metadata.ts';
import type { SearchResult, MatchRange } from '../../../map/searchResult.ts';
import type { Manifest } from '../../../map/manifest.ts';
import type { Config } from '../../../config/config.ts';
import type { UrlFor } from '../lib/rooms.ts';
import { describeBook, CENTER_BOOK_PATH, type Slot as CentreSlot } from '../lib/center.ts';
import { RoomDetails } from './RoomDetails.tsx';
import { SearchForm } from './SearchForm.tsx';
import {
  pageOf,
  pageCount,
  mountedPages,
  spacerHeight,
  rowHeight,
  tileHeight,
  thumbLevel,
  pageAtScroll,
  windowFor,
  storyLines,
} from '../lib/catalog.ts';
import { CENTER } from '../lib/tiles.ts';

/** One slot on the center shelf, as `assignTitles()` (`center.ts`) returns it - or the row/column position it never fills. */
type Slot = CentreSlot | null;

type Highlight = { keyword: (text: string) => MatchRange[]; story: (text: string) => MatchRange[] } | null;

/**
 * How wide a thumbnail is, from the width the list has to spend.
 *
 * Bounded at both ends rather than a fraction outright: below about 120px a
 * wall of books is an unreadable smudge, and above 240 the story beside it gets
 * squeezed into a column too narrow to read. Between those it tracks the
 * display, so a phone gets a smaller tile and more words.
 */
const thumbWidth = (available: number): number =>
  Math.round(Math.min(240, Math.max(120, available * 0.26)));

/** A row's vertical padding, both halves - the one number CSS and JS must agree on. */
const ROW_PAD = 22;

/**
 * What the text column needs when the tile is too small to set the row's height.
 *
 * The room's name, its chips, two clamped lines of story and the "show on the
 * map" button, plus the score strip when a search is running. By-feel numbers
 * that exist so a narrow display does not clip the story - `rowHeight` takes
 * whichever of the two columns is taller.
 */
const TEXT_MIN = 132;
/**
 * Reserves room for the score strip's full four lines (composite, tag, story,
 * clip) on EVERY row while a search is running, whether or not this room's own
 * ranking found that many - same reasoning as `STORY_RESERVED_PX` reserving
 * the "read the rest" button on rows that don't show one: a height that
 * varied with how much a room matched would make the sliding window's spacer
 * arithmetic wrong for that row.
 */
const SCORE_STRIP_PX = 70;

/**
 * What sits above and below the story inside a row, and how tall one line of it
 * is - the two numbers `storyLines` needs to work out the clamp.
 *
 * By-feel, and kept next to `TEXT_MIN` because they describe the same layout
 * from the other direction: that one says what the text column needs at
 * minimum, these say what is left for the story once it has it.
 *
 * The reserve covers the name row, up to two lines of chips, and the "read the
 * rest" button - INCLUDING on rows that do not show one. Reserving only where
 * the button appears would need the clamp to vary per row, and it is uniform by
 * design; reserving nowhere is what made the button invisible on a phone, which
 * is the display it matters most on. A row without one carries a little slack
 * instead, which is the cheaper mistake.
 */
const STORY_RESERVED_PX = 98;
const STORY_LINE_PX = 19;

/**
 * How wide a shelf link is, in characters.
 *
 * The shelf is a GRID of equal cells rather than a wrapped row of pill-shaped
 * buttons sized to their own text: forty tags of forty different lengths read
 * as rubble, and the wall they stand for is a grid of identical spines. So one
 * width, taken from the longest title actually on the wall so nothing is
 * clipped that does not have to be, and bounded - one very long search term
 * should not set the column width for the other thirty-nine.
 */
const SHELF_MIN_CH = 9;
const SHELF_MAX_CH = 18;
const shelfColumnCh = (slots: Slot[]): number =>
  Math.min(
    SHELF_MAX_CH,
    Math.max(SHELF_MIN_CH, ...slots.map((s) => (s?.text ? s.text.length : 0)))
  );

export function CatalogView({
  manifest,
  config,
  urlFor,
  order,
  metadata,
  result,
  highlight,
  tagLinks,
  query,
  setQuery,
  onSearch,
  onClearSearch,
  paging,
  setPaging,
  onExit,
  onShowOnMap,
  onKeyword,
  onExpand,
  centreSlots,
  onBook,
  onOpenArtistStatement,
  cellOfId,
  history,
  onForgetSearches,
  note,
  scrollRef,
  firstTileRef,
  leaving = false,
}: {
  manifest: Manifest;
  config: Config;
  urlFor: UrlFor;
  order: number[];
  metadata: (RoomMeta | null)[] | null;
  result: SearchResult | null;
  highlight: Highlight;
  tagLinks: Record<string, string> | null;
  query: string;
  setQuery: (query: string) => void;
  onSearch: FormEventHandler<HTMLFormElement>;
  onClearSearch: () => void;
  paging: 'scroll' | 'pages';
  setPaging: (paging: 'scroll' | 'pages') => void;
  onExit: () => void;
  onShowOnMap: (x: number, y: number) => void;
  onKeyword: (keyword: string) => void;
  onExpand: (id: number, rank: number) => void;
  centreSlots: Slot[];
  onBook: (index: number) => void;
  onOpenArtistStatement: () => void;
  cellOfId: (id: number) => { x: number; y: number } | null;
  history: string[];
  onForgetSearches: () => void;
  note?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  firstTileRef: Ref<HTMLImageElement>;
  leaving?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const centreRowRef = useRef<HTMLLIElement>(null);
  const [geom, setGeom] = useState({ width: 900, height: 700 });
  const [active, setActive] = useState(0);
  // The center row's real height. It is the ONE row allowed to size itself -
  // it holds the whole shelf, forty titles that wrap to as many lines as the
  // width needs, and clipping them to a tile's height would hide the newest
  // searches. It can be variable precisely because it sits outside the paging
  // arithmetic: the spacers stand in for PAGED rows, and this is not one. What
  // the arithmetic does need is how tall it actually is, which is measured
  // rather than assumed.
  const [leadPx, setLeadPx] = useState(0);

  // The list's own size, measured rather than assumed: the thumbnail width and
  // therefore the row height come from it, and so do the spacers.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => {
      setGeom({ width: el.clientWidth, height: el.clientHeight });
      const lead = centreRowRef.current;
      if (lead) setLeadPx(lead.offsetHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (centreRowRef.current) ro.observe(centreRowRef.current);
    return () => ro.disconnect();
  }, []);

  const perPage = config.catalog.perPage;
  const thumbPx = thumbWidth(geom.width);
  // Every row grows together when a search starts, because every row gains the
  // same one-line score strip - so the rows stay uniform and the spacers stay
  // exact, which is the property the sliding window rests on.
  const rowPx = rowHeight(thumbPx, ROW_PAD, TEXT_MIN + (result?.breakdown ? SCORE_STRIP_PX : 0));
  const level = thumbLevel(thumbPx, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);

  const total = order.length;
  const pages = pageCount(total, perPage);

  // Pagination is `windowPages: 0` - one page, whatever the display is doing.
  // Scrolling takes whichever is larger of the configured budget and what the
  // viewport actually spans, so a tall screen cannot reach into a spacer.
  const window_ = windowFor(paging === 'pages' ? 0 : config.catalog.windowPages, {
    viewportPx: paging === 'pages' ? 0 : geom.height,
    perPage,
    rowPx,
  });
  const { first, last } = mountedPages(active, pages, window_);

  // How much of each story fits, derived rather than fixed at two lines. The
  // score strip takes a line's worth when a search is running, so this shrinks
  // with it rather than leaving the story to be cut by `overflow: hidden`.
  const lines = storyLines(
    rowPx,
    STORY_RESERVED_PX + (result?.breakdown ? SCORE_STRIP_PX : 0),
    STORY_LINE_PX
  );

  const onScroll = useCallback(
    (e: { currentTarget: { scrollTop: number } }) => {
      if (paging === 'pages') return;
      const next = pageAtScroll(e.currentTarget.scrollTop, { perPage, rowPx, leadPx });
      setActive((prev) => (prev === next ? prev : Math.min(next, pages - 1)));
    },
    [paging, perPage, rowPx, leadPx, pages]
  );

  // A new ranking is a new list. Staying on page 40 of a search that just
  // returned nine rooms would show an empty screen and read as broken.
  useEffect(() => {
    setActive(0);
    if (scrollRef?.current) scrollRef.current.scrollTop = 0;
  }, [result, order, scrollRef]);

  const rows = useMemo(() => {
    const out = [];
    for (let p = first; p <= last; p++) out.push(...pageOf(order, p, perPage));
    return out;
  }, [order, first, last, perPage]);

  // Spacers stand in for pages the reader can SCROLL to. Paginated, there is
  // nowhere to scroll - the other pages are behind a button - so standing in
  // for them leaves a screenful of nothing between the last row and the pager.
  const scrolls = paging !== 'pages';
  const above = scrolls ? spacerHeight(0, first - 1, total, perPage, rowPx) : 0;
  const below = scrolls ? spacerHeight(last + 1, pages - 1, total, perPage, rowPx) : 0;

  return (
    <div
      className={`catalog${leaving ? ' leaving' : ''}`}
      ref={hostRef}
      style={{
        '--catalog-thumb': `${thumbPx}px`,
        '--catalog-row': `${rowPx}px`,
        '--catalog-lines': lines,
        '--shelf-col': `${shelfColumnCh(centreSlots)}ch`,
        '--catalog-line': `${STORY_LINE_PX}px`,
        '--catalog-out': `${config.catalog.transitionMs}ms`,
      } as CSSProperties}
    >
      <div className="catalog-bar">
        <div className="catalog-bar-row">
          <SearchForm
            query={query}
            setQuery={setQuery}
            onSubmit={onSearch}
            onClear={onClearSearch}
            className="catalog-search"
            maxLength={config.search.maxQueryLength}
          />
          <button className="mode-toggle" onClick={onExit}>
            ← the map
          </button>
          {/*
            The same "forget searches" act the bottom-right book on the shelf
            runs (main.jsx's `CENTER_OVERRIDES`/`onOverride`)
            Absent when there is nothing to forget.
          */}
          {history.length > 0 && (
            <button
              className="forget"
              onClick={onForgetSearches}
              aria-label={`forget ${history.length} remembered ${history.length === 1 ? 'search' : 'searches'}`}
            >
              forget searches ({history.length})
            </button>
          )}
        </div>

        <div className="catalog-bar-row sub">
          <p className="catalog-count">
            {result?.term ? (
              <>
                <b>{total}</b> rooms ranked for “{result.term}”
              </>
            ) : (
              <>
                <b>{total}</b> rooms, in alphabetical order
              </>
            )}
            {note && <span className="catalog-note"> · {note}</span>}
          </p>

          {/*
            A radiogroup rather than two buttons: these are two states of one
            setting, and a reader arrowing between them should hear that rather
            than meeting two unrelated controls.
          */}
          <div className="paging" role="radiogroup" aria-label="how the catalog advances">
            {(
              [
                ['scroll', 'scroll'],
                ['pages', 'pages'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="radio"
                aria-checked={paging === value}
                className={paging === value ? 'on' : ''}
                onClick={() => setPaging(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="catalog-scroll" ref={scrollRef} onScroll={onScroll}>
        <ul className="catalog-list">
          {/*
            Row 0 is the center room, and its right-hand column is the shelf -
            the same forty slots `assignTitles` returns, as ordinary links. This
            is the one view where the whole wall is legible at once, and it is
            the same `onBook` a painted spine runs, so there is no second idea
            of what a book does.
          */}
          <li className="catalog-row catalog-center" ref={centreRowRef}>
            <div className="catalog-tile-wrap">
              <img
                ref={firstTileRef}
                className="catalog-tile"
                src={urlFor(CENTER, 0) ?? ''}
                alt=""
                width={thumbPx}
                height={tileHeight(thumbPx)}
                decoding="async"
              />
              {/*
                The open book painted into a shelf gap - the same hotspot the
                map hovers/opens via `centerBookAtPoint`, drawn here as the
                same traced SVG path (`CENTER_BOOK_PATH`) rather than a
                bounding box, filling the whole thumbnail via
                `viewBox="0 0 1 1"` + `preserveAspectRatio="none"` exactly
                like the map's own overlay. This thumbnail is a fixed size,
                not a moving camera, so there is nothing to reposition per
                frame and a real `:hover` (this is a normal list, not the
                gesture-owning canvas) is simpler than the map's
                pointermove-driven highlight.
              */}
              {CENTER_BOOK_PATH && (
                <button type="button" className="catalog-center-book" aria-label="an artist's statement" onClick={onOpenArtistStatement}>
                  <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                    <path d={CENTER_BOOK_PATH} />
                  </svg>
                </button>
              )}
            </div>
            <div className="catalog-body">
              <h2 className="catalog-name">the center of the library</h2>
              <p className="catalog-sub">
                the index shelf, where searches are recorded
              </p>
              <div className="shelf-links">
                {centreSlots.map((slot, i) =>
                  slot?.text ? (
                    <button
                      key={i}
                      className={`shelf-link ${slot.kind}`}
                      onClick={() => onBook(i)}
                      // The visible text is ellipsised to the column's width, so
                      // the full term has to survive somewhere: the accessible
                      // name carries it (the same `describeBook` the painted
                      // spines use), and the tooltip shows it on hover.
                      aria-label={describeBook(slot)}
                      title={slot.text}
                    >
                      {slot.text}
                    </button>
                  ) : null
                )}
              </div>
            </div>
          </li>

          {above > 0 && <li className="catalog-spacer" style={{ height: above }} aria-hidden="true" />}

          {rows.map(({ id, rank }) => (
            <CatalogRow
              key={id}
              id={id}
              rank={rank}
              total={total}
              file={manifest.rooms[id]?.file}
              entry={metadata?.[id] ?? null}
              src={urlFor(id, level) ?? urlFor(id, 0) ?? ''}
              thumbPx={thumbPx}
              cell={cellOfId(id)}
              onShowOnMap={onShowOnMap}
              onKeyword={onKeyword}
              onExpand={onExpand}
              highlight={highlight}
              tagLinks={tagLinks}
              result={result}
              weights={config.search.weights}
            />
          ))}

          {below > 0 && <li className="catalog-spacer" style={{ height: below }} aria-hidden="true" />}
        </ul>

        {paging === 'pages' && (
          <nav className="pager" aria-label="catalog pages">
            <button disabled={active === 0} onClick={() => setActive((p) => Math.max(0, p - 1))}>
              ← previous
            </button>
            <span>
              page <b>{active + 1}</b> of {pages}
            </span>
            <button
              disabled={active >= pages - 1}
              onClick={() => setActive((p) => Math.min(pages - 1, p + 1))}
            >
              next →
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}

/**
 * One room in the list.
 *
 * Its own component for one reason: it has to know whether its own story got
 * clipped, and that is a measurement, not something the parent can work out.
 * The clamp is uniform across the page but the stories are not - so "is there
 * more to read" is per row, and a "read the rest" button on a story that is
 * already whole would be a lie forty times a screen.
 *
 * Measured rather than estimated from the character count. Where the text
 * actually breaks depends on the font, the column width and the words; counting
 * characters would be wrong exactly at the boundary, which is the only place the
 * answer matters.
 */
function CatalogRow({
  id, rank, total, file, entry, src, thumbPx, cell,
  onShowOnMap, onKeyword, onExpand, highlight, tagLinks, result, weights,
}: {
  id: number;
  rank: number;
  total: number;
  file?: string;
  entry: RoomMeta | null;
  src: string;
  thumbPx: number;
  cell: { x: number; y: number } | null;
  onShowOnMap: (x: number, y: number) => void;
  onKeyword: (keyword: string) => void;
  onExpand: (id: number, rank: number) => void;
  highlight: Highlight;
  tagLinks: Record<string, string> | null;
  result: SearchResult | null;
  weights: Config['search']['weights'];
}) {
  const storyRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const desc: Description = describeRoom(id, rank, total, entry);

  // After layout, and again whenever what is in the row changes: the clamp moves
  // with the row height, so a resize can uncover the rest of a story or bury it.
  useLayoutEffect(() => {
    const el = storyRef.current?.querySelector('.story');
    if (!el) {
      setClipped(false);
      return;
    }
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [desc.description, result, thumbPx]);

  return (
    <li className="catalog-row" aria-setsize={total} aria-posinset={rank + 1}>
      {/*
        The tile is a button, because pressing it does something - it opens the
        room at whatever size the display allows. A bare `<img>` with a click
        handler is not reachable by keyboard and announces as an image, not as a
        control.
      */}
      <button
        className="catalog-tile-button"
        onClick={() => onExpand(id, rank)}
        aria-label={`enlarge room ${id}`}
      >
        <img
          className="catalog-tile"
          src={src}
          alt=""
          width={thumbPx}
          height={tileHeight(thumbPx)}
          loading="lazy"
          decoding="async"
        />
      </button>

      <div className="catalog-body">
        {/*
          The room's identity on the left, the way out to the map on the right of
          the SAME row. It used to sit under the chips, which put a link and a
          row of tags within a thumb's width of each other - on a phone that is a
          coin toss between running a search and flying the camera.
        */}
        <div className="catalog-head">
          <h2 className="catalog-name">
            <span className="catalog-rank">{rank + 1}</span>
            Room {id}
            {file && <span className="catalog-file">{file}</span>}
          </h2>
          {/*
            A room past the "rooms on the map" slider has no cell to fly to, and
            saying so is more honest than a dead control - it is also the only
            place that slider's effect is visible as something other than a
            thinner map.
          */}
          {cell ? (
            <button className="catalog-show" onClick={() => onShowOnMap(cell.x, cell.y)}>
              show on the map
            </button>
          ) : (
            <span className="catalog-show dim">not on the map</span>
          )}
        </div>

        <div ref={storyRef}>
          <RoomDetails
            entry={entry}
            desc={desc}
            onKeyword={onKeyword}
            highlight={highlight}
            tagLinks={tagLinks}
            rank={rank}
            result={result}
            weights={weights}
            scoreLayout="strip"
          />
        </div>

        {clipped && (
          <button className="catalog-more" onClick={() => onExpand(id, rank)}>
            read the rest →
          </button>
        )}
      </div>
    </li>
  );
}
