/**
 * The catalog: the same corpus as one list, in the order the map is showing.
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { describeRoom } from '../../map/describe.js';
import { RoomDetails } from './RoomDetails.jsx';
import { SearchForm } from './SearchForm.jsx';
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
} from './catalog.js';
import { CENTRE } from './tiles.js';

/**
 * How wide a thumbnail is, from the width the list has to spend.
 *
 * Bounded at both ends rather than a fraction outright: below about 120px a
 * wall of books is an unreadable smudge, and above 240 the story beside it gets
 * squeezed into a column too narrow to read. Between those it tracks the
 * display, so a phone gets a smaller tile and more words.
 */
const thumbWidth = (available) => Math.round(Math.min(240, Math.max(120, available * 0.26)));

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
const SCORE_STRIP_PX = 30;

export function CatalogView({
  manifest,
  config,
  urlFor,
  order,
  metadata,
  result,
  highlight,
  query,
  setQuery,
  onSearch,
  paging,
  setPaging,
  onExit,
  onShowOnMap,
  onKeyword,
  centreSlots,
  onBook,
  cellOfRank,
  note,
  scrollRef,
  firstTileRef,
  leaving = false,
}) {
  const hostRef = useRef(null);
  const centreRowRef = useRef(null);
  const [geom, setGeom] = useState({ width: 900, height: 700 });
  const [active, setActive] = useState(0);
  // The centre row's real height. It is the ONE row allowed to size itself -
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

  const onScroll = useCallback(
    (e) => {
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

  const above = spacerHeight(0, first - 1, total, perPage, rowPx);
  const below = spacerHeight(last + 1, pages - 1, total, perPage, rowPx);

  return (
    <div
      className={`catalog${leaving ? ' leaving' : ''}`}
      ref={hostRef}
      style={{
        '--catalog-thumb': `${thumbPx}px`,
        '--catalog-row': `${rowPx}px`,
        '--catalog-out': `${config.catalog.transitionMs}ms`,
      }}
    >
      <div className="catalog-bar">
        <div className="catalog-bar-row">
          <SearchForm
            query={query}
            setQuery={setQuery}
            onSubmit={onSearch}
            className="catalog-search"
          />
          <button className="mode-toggle" onClick={onExit}>
            ← the map
          </button>
        </div>

        <div className="catalog-bar-row sub">
          <p className="catalog-count">
            {result?.term ? (
              <>
                <b>{total}</b> rooms ranked for “{result.term}”
              </>
            ) : (
              <>
                <b>{total}</b> rooms, in the order the map is showing
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
            {[
              ['scroll', 'scroll'],
              ['pages', 'pages'],
            ].map(([value, label]) => (
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
            Row 0 is the centre room, and its right-hand column is the shelf -
            the same forty slots `assignTitles` returns, as ordinary links. This
            is the one view where the whole wall is legible at once, and it is
            the same `onBook` a painted spine runs, so there is no second idea
            of what a book does.
          */}
          <li className="catalog-row catalog-centre" ref={centreRowRef}>
            <img
              ref={firstTileRef}
              className="catalog-tile"
              src={urlFor(CENTRE, 0) ?? ''}
              alt=""
              width={thumbPx}
              height={tileHeight(thumbPx)}
              decoding="async"
            />
            <div className="catalog-body">
              <h2 className="catalog-name">the centre of the library</h2>
              <p className="catalog-sub">
                the shelf, as it is painted on the wall — newest search first
              </p>
              <div className="shelf-links">
                {centreSlots.map((slot, i) =>
                  slot?.text ? (
                    <button
                      key={i}
                      className={`shelf-link ${slot.kind}`}
                      onClick={() => onBook(i)}
                      title={slot.kind === 'history' ? 'repeat this search' : undefined}
                    >
                      {slot.text}
                    </button>
                  ) : null
                )}
              </div>
            </div>
          </li>

          {above > 0 && <li className="catalog-spacer" style={{ height: above }} aria-hidden="true" />}

          {rows.map(({ id, rank }) => {
            const entry = metadata?.[id] ?? null;
            const desc = describeRoom(id, rank, total, entry);
            const cell = cellOfRank(rank);
            return (
              <li
                key={id}
                className="catalog-row"
                aria-setsize={total}
                aria-posinset={rank + 1}
              >
                <img
                  className="catalog-tile"
                  src={urlFor(id, level) ?? urlFor(id, 0) ?? ''}
                  alt=""
                  width={thumbPx}
                  height={tileHeight(thumbPx)}
                  loading="lazy"
                  decoding="async"
                />
                <div className="catalog-body">
                  <h2 className="catalog-name">
                    <span className="catalog-rank">{rank + 1}</span>
                    Room {id}
                    {manifest.rooms[id]?.file && (
                      <span className="catalog-file">{manifest.rooms[id].file}</span>
                    )}
                  </h2>

                  <RoomDetails
                    entry={entry}
                    desc={desc}
                    onKeyword={onKeyword}
                    highlight={highlight}
                    rank={rank}
                    result={result}
                    weights={config.search.weights}
                    scoreLayout="strip"
                  />

                  {/*
                    The bridge back to the map: find it in the list, then go
                    look at it. A room past the "rooms on the map" slider has no
                    cell to fly to, and saying so is more honest than a dead
                    control - it is also the only place that slider's effect is
                    visible as something other than a thinner map.
                  */}
                  {cell ? (
                    <button className="catalog-show" onClick={() => onShowOnMap(cell.x, cell.y)}>
                      show on the map
                    </button>
                  ) : (
                    <p className="catalog-show dim">not placed on the map at this density</p>
                  )}
                </div>
              </li>
            );
          })}

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
