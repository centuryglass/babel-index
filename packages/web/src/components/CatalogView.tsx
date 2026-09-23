/**
 * The catalog: the corpus as one list, alphabetical at rest
 * (`alphabeticalOrder`, `lib/catalog.ts`) and ranked like the map while a
 * search runs. The map shows where the reader stands; the catalog shows the
 * whole ranking, each room once. Neither is a fallback for the other, and
 * this is not the accessibility mode (AGENTS.md, "The catalog, and the two
 * modes").
 *
 * The paging arithmetic - which rooms are on a page, which pages are
 * mounted, how tall a spacer is, which pyramid level a thumbnail asks for -
 * lives in `lib/catalog.ts`, tested without a browser. This file renders the
 * list and listens to its scroll. The exception is the pixel constants
 * below: each mirrors a value in `style.css`, and the fixed row height (and
 * so every spacer) is computed from them. Change one side without the other
 * and the spacers stop matching the rows they stand in for.
 *
 * The list is a `<ul>`, not a listbox, because a listbox option cannot
 * contain the keyword chips every row has. `aria-setsize`/`aria-posinset`
 * on each row's `<li>` supply the "3 of 511" position a listbox would
 * announce natively.
 */
import type { CSSProperties, FormEventHandler, Ref, RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { describeRoom } from '../../../map/describe.ts';
import type { Description } from '../../../map/describe.ts';
import { roomTitle, type RoomMeta } from '../../../map/metadata.ts';
import type { SearchResult, MatchRange } from '../../../map/searchResult.ts';
import type { SortMode } from '../../../map/favorites.ts';
import type { Config } from '../../../config/config.ts';
import type { UrlFor } from '../lib/rooms.ts';
import { describeBook, CENTER_BOOK_PATH, type Slot as CentreSlot } from '../lib/center.ts';
import { RoomDetails, FavoriteToggle, Highlight, ScoreBreakdown, type FavoriteControl } from './RoomDetails.tsx';
import { SearchForm } from './SearchForm.tsx';
import { useContentZoom } from '../hooks/useContentZoom.ts';
import { ZoomControls } from './ZoomControls.tsx';
import {
  pageOf,
  pageCount,
  mountedPages,
  spacerHeight,
  stackedRowHeight,
  tileHeight,
  thumbLevel,
  pageAtScroll,
  windowFor,
  chipLines,
  focusScrollTop,
} from '../lib/catalog.ts';
import { CENTER, DISTILL_OFF, DISTILL_ON } from '../lib/tiles.ts';
import { BASE_TILE } from '../lib/pyramid.ts';

/** One center-shelf slot, as `center.ts`'s `assignTitles()` returns it, or null for an empty one. */
type Slot = CentreSlot | null;

type Highlight = {
  keyword: (text: string) => MatchRange[];
  title: (text: string) => MatchRange[];
  story: (text: string) => MatchRange[];
} | null;

// --- row shapes -------------------------------------------------------------

/**
 * Below this list width a row is narrow: the map link is dropped and the
 * title may wrap to a second line (`TITLE_LINE_PX`).
 *
 * Measured from the list, not a media query, because the second title line
 * changes the row height. One flag sets both the `.narrow` class and the
 * height arithmetic, so the CSS and the spacers cannot disagree.
 */
const NARROW_PX = 560;

/**
 * Below this list width a row has no room for text beside its thumbnail, so
 * it becomes a stack: the name row full width, the picture full width
 * beneath it, and a "keywords & story" link into the room overlay
 * (`onExpand`) in place of the chips and story.
 *
 * Measured from the list for the same reason as `NARROW_PX`: the stack's
 * height is `stackedRowHeight`, not the flow-area sum. Every ultra-narrow
 * row is also narrow.
 */
const ULTRA_NARROW_PX = 400;

// --- thumbnail widths -------------------------------------------------------

/**
 * A room row's horizontal insets, both sides: `2 * (ROW_H_PAD + CARD_H_PAD)`.
 * Mirrors the `.catalog-row` and `.catalog-row .catalog-body.paper-sheet`
 * padding in style.css.
 */
const ULTRA_ROW_HPAD = 64;
/**
 * An ultra-narrow room row's thumbnail width: the list width less the row's
 * insets (`ULTRA_ROW_HPAD`) and the mat on both sides, so the matted image
 * lands flush with the card's edges. `matPad` is the value `CatalogView`
 * derives from `MAT_PAD`.
 */
const ultraThumbWidth = (available: number, matPad: number): number =>
  Math.max(80, available - ULTRA_ROW_HPAD - 2 * matPad);

/**
 * The center row's margin and padding, one side each. Mirrors
 * `.catalog.ultra-narrow .catalog-center.paper-sheet`'s padding and
 * `.catalog-center.paper-sheet`'s horizontal margin in style.css.
 */
const CENTRE_MARGIN = 16;
const CENTRE_PAD = 16;
/**
 * The center row's thumbnail width under ultra-narrow: full-bleed like
 * `ultraThumbWidth`, trimmed by the center sheet's margin and padding
 * instead of a room row's insets.
 */
const centreUltraThumbWidth = (available: number, matPad: number): number =>
  Math.max(80, available - 2 * CENTRE_MARGIN - 2 * CENTRE_PAD - 2 * matPad);

/**
 * A thumbnail's width, from the list width: a fraction of it, clamped.
 *
 * Below the floor a wall of books is an unreadable smudge; above the cap the
 * story column beside it is too narrow to read. The fraction is larger under
 * `NARROW_PX`, because a narrow row's text column needs a fixed height (name
 * row, a story line, the button) and a smaller tile would leave dark
 * background beneath it. `CARD_PAD_NARROW` closes the rest of that gap.
 */
const thumbWidth = (available: number): number =>
  Math.round(Math.min(240, Math.max(120, available * (available < NARROW_PX ? 0.34 : 0.26))));

// --- pixel constants mirrored from style.css --------------------------------
//
// Each constant below must match the style.css rule it names. The fixed row
// height `rowPx` is summed from them, and every spacer is a multiple of
// `rowPx`, so a mismatch misplaces the scroll position of every unmounted
// page.

/** A row's vertical padding, both halves: `.catalog-row`'s `padding: 7px 16px`. */
const ROW_PAD = 14;
/** A row's horizontal padding, one side: `.catalog-row`'s `padding: 7px 16px`. Sets the score strip's width. */
const ROW_H_PAD = 16;
/** The card's horizontal padding, one side: `.catalog-row .catalog-body.paper-sheet`'s `padding`. Sets the score strip's width. */
const CARD_H_PAD = 16;

/**
 * The card's vertical padding, both halves:
 * `.catalog-row .catalog-body.paper-sheet`'s `padding`. The thumbnail floats
 * inside the card, so this inset is charged to the row height like
 * `ROW_PAD`.
 */
const CARD_PAD = 24;
/**
 * `CARD_PAD` under `.catalog.narrow`. A narrow row is tight on height, so the
 * smaller inset goes to the chip and story clamps.
 */
const CARD_PAD_NARROW = 16;

/**
 * The thumbnail's cream mat, one side: the `border` style.css draws from
 * `--catalog-mat`. A border, not padding, so the center thumbnail's
 * absolutely positioned overlays (the open-book hotspot, the distill toggle)
 * stay aligned to the image. Charged to the row height like `CARD_PAD`.
 * `CatalogView`'s `matPad` halves it on wide rows.
 */
const MAT_PAD = 6;

/**
 * The name row plus the "read the rest" button, reserved on every row.
 *
 * Reserved even on rows that show no button: a per-row reserve would make
 * the chip clamp vary per row, and no reserve clips the button away on the
 * narrow displays that need it (AGENTS.md, "A fixed row cannot show
 * everything, so the overlay is not optional").
 */
const TEXT_CHROME_PX = 50;
/** One line of story: `--catalog-line`, the `.catalog-row .story` line height. */
const STORY_LINE_PX = 19;

/**
 * An ultra-narrow row's name row and "keywords & story" link heights, handed
 * to CSS as `--catalog-ultra-head`/`--catalog-ultra-details`. Fixed, not
 * content-sized, because `stackedRowHeight` sums them.
 *
 * The head is one line: style.css overrides `.narrow`'s two-line title clamp
 * for `.ultra-narrow`, where the head has the row's full width.
 */
const ULTRA_HEAD_PX = 32;
const ULTRA_DETAILS_PX = 30;

/**
 * The gap between an ultra-narrow row's picture and its "keywords & story"
 * link: `--catalog-ultra-gap`, the margin on `.catalog-details-link`.
 * Summed into `stackedRowHeight`.
 */
const ULTRA_STACK_GAP = 8;

/**
 * One line of keyword chips, wrap gap included: the per-line cost
 * `chipLines` charges, and the unit of `--catalog-chips-max`
 * (`.catalog-row .chips`'s `max-height`).
 *
 * It is a chip's rendered height plus `.chips`'s 5px gap, rounded up. A
 * budget that undercounts the pitch clips the last allowed line.
 */
const CHIP_LINE_PX = 30;
/**
 * The most chip lines a row shows, however much height it has left over, so
 * a keyword-heavy room's chips cannot become the tallest thing in the row.
 * Narrow gets one more line: its text column is where a single long chip
 * most often takes a line to itself.
 */
const CHIP_LINES_MAX = 2;
const CHIP_LINES_MAX_NARROW = 3;

/**
 * The text column's minimum height: `TEXT_CHROME_PX`, the narrow chip cap,
 * and one story line. The flow area is the taller of this and the tile, so
 * no row is shorter than the chip budget `chipLines` computes against it.
 */
const TEXT_MIN = TEXT_CHROME_PX + CHIP_LINES_MAX_NARROW * CHIP_LINE_PX + STORY_LINE_PX;

/**
 * The score strip's line count, reserved at its worst case on every row while
 * a search runs.
 *
 * The strip sits below the fixed-height flow area, full card width. It holds
 * the composite "match strength" line plus up to `SCORE_DETAIL_LINES`
 * per-axis lines (tag, title, story, clip) flowed into columns. The reserve
 * depends only on the strip's width (`scoreLayoutFor`), never on how many
 * lines a room's score has, because a row height that varied per room would
 * break the spacer arithmetic.
 *
 * `.catalog.score-one-row .score-details` in style.css repeats this count as
 * `repeat(4, max-content)`; change both together.
 */
const SCORE_DETAIL_LINES = 4;
/**
 * The strip's line pitch and its top chrome (border and spacing above the
 * first line). Must match `.score-strip` and `.score-strip p` in style.css,
 * like `CHIP_LINE_PX`.
 */
const SCORE_LINE_PX = 15;
const SCORE_PAD_PX = 8;
/** The gap between score columns: `.score-details`'s `column-gap` and `.score-one-row`'s. */
const SCORE_GAP_PX = 22;
/**
 * A detail column's width cap, and the width the fit math budgets per column.
 * Handed to CSS as `--score-col`, `.score-line`'s `max-width`, so a rare long
 * line ellipsises instead of widening its column past the budget.
 */
const SCORE_DETAIL_COL_PX = 200;
/** The composite "match strength" line's approximate width, as a column in the one-row layout. */
const SCORE_COMPOSITE_PX = 225;
/**
 * How many `colPx`-wide columns fit in `availPx` with `SCORE_GAP_PX` between
 * each. N columns need `N * colPx + (N - 1) * gap`, so the last column's
 * missing gap is credited back.
 */
function columnsFor(availPx: number, colPx: number): number {
  return Math.max(0, Math.floor((availPx + SCORE_GAP_PX) / (colPx + SCORE_GAP_PX)));
}
/**
 * The score strip's layout at a given width: the detail column count, whether
 * the composite joins the details as one more column on a single line
 * (`oneRow`, the `.score-one-row` class), and the total line count the
 * reserve is built from.
 */
function scoreLayoutFor(stripWidthPx: number): { oneRow: boolean; cols: number; lines: number } {
  // One line when every detail column and the composite fit side by side,
  // with a gap between each.
  const oneRowPx = SCORE_DETAIL_LINES * SCORE_DETAIL_COL_PX + SCORE_COMPOSITE_PX + SCORE_DETAIL_LINES * SCORE_GAP_PX;
  if (stripWidthPx >= oneRowPx) return { oneRow: true, cols: SCORE_DETAIL_LINES, lines: 1 };
  // Otherwise the composite takes its own line, and the details flow into as
  // many columns as fit, at least two.
  const cols = Math.min(SCORE_DETAIL_LINES, Math.max(2, columnsFor(stripWidthPx, SCORE_DETAIL_COL_PX)));
  return { oneRow: false, cols, lines: 1 + Math.ceil(SCORE_DETAIL_LINES / cols) };
}
const scoreStripHeight = (lines: number): number => SCORE_PAD_PX + SCORE_LINE_PX * lines;

/**
 * One line of the room's name: `--catalog-title-line`, the line height of
 * `.catalog.narrow`'s two-line title clamp. A narrow row reserves one extra
 * line of it.
 */
const TITLE_LINE_PX = 16;

// --- the center shelf and the spotlight -------------------------------------

/**
 * A shelf link's width bounds, in characters.
 *
 * The shelf is a grid of equal cells, like the wall of identical spines it
 * stands for. `shelfColumnCh` sizes the cell to the longest title on the
 * wall, within these bounds, so one long search term cannot widen every
 * column.
 */
const SHELF_MIN_CH = 9;
const SHELF_MAX_CH = 18;

/**
 * How long "show in the catalog" picks out a row. style.css's
 * `.catalog-row.spotlight` animation (`catalog-spotlight`) runs the same
 * duration; change both together.
 */
const SPOTLIGHT_MS = 1600;
/** The shelf's grid column width, `--shelf-col`: see `SHELF_MIN_CH`. */
const shelfColumnCh = (slots: Slot[]): number =>
  Math.min(
    SHELF_MAX_CH,
    Math.max(SHELF_MIN_CH, ...slots.map((s) => (s?.text ? s.text.length : 0)))
  );

// --- the list ---------------------------------------------------------------

export function CatalogView({
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
  favorites,
  sortMode,
  onSortMode,
  favoriteFor,
  centreSlots,
  onBook,
  onOpenArtistStatement,
  distillMode,
  onToggleDistill,
  cellOfId,
  history,
  onForgetSearches,
  note,
  scrollRef,
  firstTileRef,
  leaving = false,
  spotlightId = null,
  onSpotlightHandled,
}: {
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
  /** whether this deployment records favorites at all - false hides every favorite control */
  favorites: boolean;
  sortMode: SortMode;
  onSortMode: (mode: SortMode) => void;
  favoriteFor: (id: number | null | undefined) => FavoriteControl | null;
  centreSlots: Slot[];
  onBook: (index: number) => void;
  onOpenArtistStatement: () => void;
  /** whether generic rooms are currently hidden - see `useDistillMode.ts` */
  distillMode: boolean;
  onToggleDistill: () => void;
  cellOfId: (id: number) => { x: number; y: number } | null;
  history: string[];
  onForgetSearches: () => void;
  note?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  firstTileRef: Ref<HTMLImageElement>;
  leaving?: boolean;
  /**
   * "Show in the catalog", from the room overlay: a room to scroll to and pick
   * out, once. A one-shot trigger, not a selection: it is `null` otherwise,
   * and the caller must set it again to repeat a visit.
   */
  spotlightId?: number | null;
  /** Fired once `spotlightId` has been acted on or found missing from `order`, so the caller can reset it to `null`. */
  onSpotlightHandled?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const centreRowRef = useRef<HTMLLIElement>(null);
  // The zoom transform applies to the list, not to `.catalog-scroll`
  // (`scrollRef`), so `onScroll`/`pageAtScroll` read an untransformed
  // `scrollTop`. See useContentZoom.ts.
  const contentZoom = useContentZoom(scrollRef);
  const [geom, setGeom] = useState({ width: 900, height: 700 });
  const [active, setActive] = useState(0);
  // The distill toggle art's natural size, reported by its `<img>`'s
  // `onLoad` (see `distillW`). {0, 0} until then, so the button takes no
  // space before the art loads.
  const [distillIconSize, setDistillIconSize] = useState({ w: 0, h: 0 });
  // The center row's grid placement: the cover picture spans `picCols` x
  // `picRows` cells of the grid the spine buttons flow through, so picture
  // and spines share column lines (style.css's `.catalog-center.paper-sheet`).
  // `picNext`/`subStart` are the grid lines the title and index-shelf line
  // start on, precomputed because a grid line cannot take a `calc()`. The
  // grid-fitting layout effect fills these in; the defaults serve the first
  // paint.
  const [centreGrid, setCentreGrid] = useState({
    picCols: 2, picNext: 3, picRows: 4, subStart: 2, subRows: 1, titleRows: 1,
  });
  // The center row's measured height, which `pageAtScroll` and
  // `focusScrollTop` take as `leadPx`. It is the one row that sizes itself,
  // so the whole shelf shows; it sits outside the paged rows, so the spacer
  // arithmetic is unaffected.
  const [leadPx, setLeadPx] = useState(0);
  // The row currently picked out, until `SPOTLIGHT_MS` clears it. The
  // `spotlightId` prop only starts it.
  const [highlightId, setHighlightId] = useState<number | null>(null);
  // The `highlightId` focus has already moved to, so a later `rows` change
  // (a resize) does not pull focus back to it.
  const focusedIdRef = useRef<number | null>(null);

  // The list's size and the center row's height, which the thumbnail width,
  // the row height and the spacers derive from.
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
  // Row shape flags; see `NARROW_PX` and `ULTRA_NARROW_PX`. `ultraNarrow`
  // implies `narrow`.
  const narrow = geom.width < NARROW_PX;
  const ultraNarrow = geom.width < ULTRA_NARROW_PX;
  // The mat width every height sum below charges: `MAT_PAD` on narrow rows,
  // half of it on wide rows, whose larger thumbnail needs less frame.
  const matPad = narrow ? MAT_PAD : MAT_PAD / 2;
  // The center row's thumbnail width. A room row's is `rowThumbPx`.
  const thumbPx = ultraNarrow ? centreUltraThumbWidth(geom.width, matPad) : thumbWidth(geom.width);
  // The distill toggle's size as a percentage of the thumbnail, anchored
  // bottom-right in style.css. The map's canvas overlay
  // (`distillToggle.ts`'s `distillIconScreenRect`) scales the icon by the
  // tile's pixels per `BASE_TILE` pixel, so its share of the tile is
  // `iconSize / BASE_TILE` at any thumbnail size.
  const distillW = distillIconSize.w ? `${(distillIconSize.w / BASE_TILE.w) * 100}%` : '0';
  const distillH = distillIconSize.h ? `${(distillIconSize.h / BASE_TILE.h) * 100}%` : '0';
  // Fits the center row's cover picture to whole grid cells (`centreGrid`),
  // before paint.
  //
  // It reads the grid's resolved tracks, which the browser has already
  // stretched from `minmax(--shelf-col, 1fr)`, so no CSS math is mirrored
  // here. Skipped under `ultraNarrow`, whose single-column grid ignores
  // these vars. `centreGrid` is a dependency because a new `picCols` can
  // reflow the title and index-shelf line to a new height; the second pass
  // settles it, and the equality check in the `setCentreGrid` updater stops
  // the loop.
  useLayoutEffect(() => {
    const el = centreRowRef.current;
    if (!el || ultraNarrow) return;
    const cs = getComputedStyle(el);
    if (cs.display !== 'grid') return;
    const tracks = cs.gridTemplateColumns.split(' ').map(parseFloat).filter((n) => Number.isFinite(n));
    const cols = tracks.length;
    if (cols < 2) return;
    const colW = tracks[0];
    const colGap = parseFloat(cs.columnGap) || 0;
    const rowGap = parseFloat(cs.rowGap) || 0;
    const rowH = parseFloat(cs.gridAutoRows) || 24;
    const rowsFor = (h: number) => Math.max(1, Math.ceil((h + rowGap) / (rowH + rowGap)));
    // Round the span up: the cover picture may grow past `thumbPx` to fill
    // whole columns, but never shrinks below it.
    const picCols = Math.max(1, Math.min(cols - 1, Math.ceil((thumbPx + colGap) / (colW + colGap))));
    // Row spans come from measured heights, which include the mat border.
    // The picture's height is a pass behind when `picCols` just changed;
    // the next pass settles it.
    const wrapEl = el.querySelector('.catalog-tile-wrap');
    const nameEl = el.querySelector('.catalog-name');
    const subEl = el.querySelector('.catalog-sub');
    const picRows = wrapEl ? rowsFor(wrapEl.getBoundingClientRect().height) : 4;
    const titleRows = nameEl ? rowsFor(nameEl.getBoundingClientRect().height) : 1;
    const subRows = subEl ? rowsFor(subEl.getBoundingClientRect().height) : 1;
    const next = { picCols, picNext: picCols + 1, picRows, subStart: titleRows + 1, subRows, titleRows };
    setCentreGrid((prev) =>
      prev.picCols === next.picCols && prev.picNext === next.picNext && prev.picRows === next.picRows &&
      prev.subStart === next.subStart && prev.subRows === next.subRows && prev.titleRows === next.titleRows
        ? prev
        : next,
    );
  }, [ultraNarrow, thumbPx, centreSlots, geom.width, centreGrid]);
  const titleReserve = narrow ? TITLE_LINE_PX : 0;
  const cardPad = narrow ? CARD_PAD_NARROW : CARD_PAD;
  // A room row's thumbnail width. The center row's is `thumbPx`.
  const rowThumbPx = ultraNarrow ? ultraThumbWidth(geom.width, matPad) : thumbWidth(geom.width);
  // The score strip's height, the same on every row while a search runs
  // (see `SCORE_DETAIL_LINES`) and 0 otherwise. Its width is the card's
  // content width.
  const scoring = Boolean(result?.breakdown);
  const stripWidth = Math.max(0, geom.width - 2 * ROW_H_PAD - 2 * CARD_H_PAD);
  const scoreLayout = scoreLayoutFor(stripWidth);
  const scoreH = scoring ? scoreStripHeight(scoreLayout.lines) : 0;
  // The fixed row height every spacer is a multiple of.
  //
  // A floated row is the flow area (`flowH`: the taller of the matted tile
  // and the text minimum) plus the score strip beneath it, plus padding. An
  // ultra-narrow row is its stack (`stackedRowHeight`) and shows no score.
  // A search grows every row by the same `scoreH`, so rows stay uniform.
  const flowH = ultraNarrow ? 0 : Math.max(tileHeight(rowThumbPx) + 2 * matPad, TEXT_MIN + titleReserve);
  const rowPx = ultraNarrow
    ? stackedRowHeight(rowThumbPx, ULTRA_HEAD_PX, ULTRA_DETAILS_PX, ROW_PAD + cardPad, matPad, ULTRA_STACK_GAP)
    : flowH + scoreH + ROW_PAD + cardPad;
  const level = thumbLevel(rowThumbPx, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);

  const total = order.length;
  const pages = pageCount(total, perPage);

  // Pagination mounts one page. Scrolling mounts the larger of the configured
  // budget and what the viewport spans (`windowFor`).
  const window_ = windowFor(paging === 'pages' ? 0 : config.catalog.windowPages, {
    viewportPx: paging === 'pages' ? 0 : geom.height,
    perPage,
    rowPx,
  });
  const { first, last } = mountedPages(active, pages, window_);

  // How many chip lines a row shows: what the flow area leaves after the
  // chrome and one reserved story line (`chipLines`), capped by
  // `CHIP_LINES_MAX`/`CHIP_LINES_MAX_NARROW`. The reserved story line keeps
  // a keyword-heavy room from losing its story. Chips that still do not fit
  // are counted by `CatalogRow` and shown as a `+N` chip.
  const chips = Math.min(
    narrow ? CHIP_LINES_MAX_NARROW : CHIP_LINES_MAX,
    chipLines(flowH, TEXT_CHROME_PX + titleReserve + STORY_LINE_PX, CHIP_LINE_PX)
  );

  const onScroll = useCallback(
    (e: { currentTarget: { scrollTop: number } }) => {
      if (paging === 'pages') return;
      const next = pageAtScroll(e.currentTarget.scrollTop, { perPage, rowPx, leadPx });
      setActive((prev) => (prev === next ? prev : Math.min(next, pages - 1)));
    },
    [paging, perPage, rowPx, leadPx, pages]
  );

  // A new `order` or search result returns to the top: the old page may be
  // past the end of the new list.
  //
  // Keyed on `order`'s identity. `main.tsx`'s `catalogBase` comment covers
  // how a favorite toggle avoids changing it.
  useEffect(() => {
    setActive(0);
    if (scrollRef?.current) scrollRef.current.scrollTop = 0;
  }, [result, order, scrollRef]);

  // Acts on `spotlightId`: jumps to the room's page (pagination) or scrolls
  // its row to center (`focusScrollTop`), then sets `highlightId`.
  //
  // Keyed on `spotlightId` alone. `order`, `paging` and the geometry are read
  // when the trigger fires and not re-applied when they change: this is a
  // jump, not a constraint to keep satisfying.
  useEffect(() => {
    if (spotlightId == null) return;
    const rank = order.indexOf(spotlightId);
    if (rank < 0) {
      // Not in this ranking (a blocked tag, say): clear the trigger.
      onSpotlightHandled?.();
      return;
    }
    if (paging === 'pages') {
      setActive(Math.floor(rank / perPage));
    } else if (scrollRef.current) {
      scrollRef.current.scrollTop = focusScrollTop(rank, { rowPx, leadPx, viewportPx: geom.height });
    }
    setHighlightId(spotlightId);
    onSpotlightHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotlightId]);

  // Clears the highlight after `SPOTLIGHT_MS`. It is an announcement, not a
  // standing marker.
  useEffect(() => {
    if (highlightId == null) return;
    const timer = setTimeout(() => setHighlightId(null), SPOTLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const rows = useMemo(() => {
    const out = [];
    for (let p = first; p <= last; p++) out.push(...pageOf(order, p, perPage));
    return out;
  }, [order, first, last, perPage]);

  // Moves focus to the highlighted row's thumbnail button once the row is
  // mounted.
  //
  // Keyed on `rows` because scrolling to an unmounted row does not mount it
  // synchronously: the `scroll` event must land and `onScroll` must move
  // `active` first. The `spotlightId` effect cannot query the row directly.
  useEffect(() => {
    if (highlightId == null || focusedIdRef.current === highlightId) return;
    if (!rows.some((r) => r.id === highlightId)) return;
    const tile = hostRef.current?.querySelector<HTMLElement>(
      `[data-room-id="${highlightId}"] .catalog-tile-button`
    );
    if (!tile) return;
    focusedIdRef.current = highlightId;
    tile.focus();
  }, [highlightId, rows]);

  // Spacers stand in for unmounted pages in scroll mode only. Paginated, the
  // other pages are behind the pager, and a spacer would be blank screen.
  const scrolls = paging !== 'pages';
  const above = scrolls ? spacerHeight(0, first - 1, total, perPage, rowPx) : 0;
  const below = scrolls ? spacerHeight(last + 1, pages - 1, total, perPage, rowPx) : 0;

  return (
    <div
      className={`catalog${narrow ? ' narrow' : ''}${ultraNarrow ? ' ultra-narrow' : ''}${scoring && scoreLayout.oneRow ? ' score-one-row' : ''}${leaving ? ' leaving' : ''}`}
      ref={hostRef}
      style={{
        '--catalog-thumb': `${thumbPx}px`,
        '--catalog-row-thumb': `${rowThumbPx}px`,
        '--catalog-mat': `${matPad}px`,
        '--catalog-row': `${rowPx}px`,
        '--catalog-chips-max': `${chips * CHIP_LINE_PX}px`,
        '--catalog-flow-h': `${flowH}px`,
        '--catalog-score-h': `${scoreH}px`,
        '--score-cols': scoreLayout.cols,
        '--score-col': `${SCORE_DETAIL_COL_PX}px`,
        '--catalog-ultra-head': `${ULTRA_HEAD_PX}px`,
        '--catalog-ultra-details': `${ULTRA_DETAILS_PX}px`,
        '--catalog-ultra-gap': `${ULTRA_STACK_GAP}px`,
        '--shelf-col': `${shelfColumnCh(centreSlots)}ch`,
        '--catalog-line': `${STORY_LINE_PX}px`,
        '--catalog-title-line': `${TITLE_LINE_PX}px`,
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
          <ZoomControls
            zoomIn={contentZoom.zoomIn}
            zoomOut={contentZoom.zoomOut}
            resetZoom={contentZoom.resetZoom}
            canZoomIn={contentZoom.canZoomIn}
            canZoomOut={contentZoom.canZoomOut}
          />
          {/*
            The same act as the shelf's forget-searches book
            (`useCenterShelf.ts`'s `overrides`) and the debug panel's button.
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
                <b>{total}</b> rooms
                {/*
                  The order clause is dropped on a narrow bar, where it would
                  cost a line and the sort select already names the order.
                */}
                {!narrow && (
                  <>
                    ,{' '}
                    {sortMode === 'mine'
                      ? 'sorted by your favorites'
                      : sortMode === 'count'
                        ? 'sorted by favorite count'
                        : sortMode === 'random'
                          ? 'in random order'
                          : 'in alphabetical order'}
                  </>
                )}
              </>
            )}
            {note && <span className="catalog-note"> · {note}</span>}
          </p>

          {/*
            The sort: exclusive orderings with a default, so a select. Shown
            without `favorites` too, since 'random' needs no favorite data;
            only the 'mine'/'count' options depend on it.

            Picking any mode but 'relevance' while a search runs ends the
            search first (`main.tsx`'s `changeSort`; AGENTS.md, "Distance
            from the center carries one meaning at a time").
          */}
          <label className="catalog-sort">
            {/*
              The label is the select's accessible name, so a narrow bar
              hides it visually (`sr-only`). `display: none` would remove the
              name too.
            */}
            <span className={narrow ? 'sr-only' : 'catalog-sort-label'}>sort</span>
            <select value={sortMode} onChange={(e) => onSortMode(e.target.value as SortMode)}>
              <option value="relevance">{result?.term ? 'by ranking' : 'alphabetically'}</option>
              {favorites && <option value="mine">my favorites first</option>}
              {favorites && <option value="count">most favorited</option>}
              <option value="random">random</option>
            </select>
          </label>

          {/*
            A radiogroup: two states of one setting, announced as such.
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
        <ul
          className={contentZoom.zoomed ? 'catalog-list zoom-scope zoomed' : 'catalog-list zoom-scope'}
          ref={contentZoom.ref}
          style={contentZoom.style}
        >
          {/*
            The center room's row, outside the paged rows: its picture and
            the shelf's slots (`assignTitles`) as buttons, each running the
            same `onBook` a painted spine does. It sizes itself to the whole
            shelf; `leadPx` measures it.
          */}
          <li
            className="catalog-row catalog-center paper-sheet"
            ref={centreRowRef}
            style={{
              '--pic-cols': centreGrid.picCols,
              '--pic-next': centreGrid.picNext,
              '--pic-rows': centreGrid.picRows,
              '--sub-start': centreGrid.subStart,
              '--sub-rows': centreGrid.subRows,
              '--title-rows': centreGrid.titleRows,
            } as CSSProperties}
          >
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
                The open book in the shelf gap: the hotspot the map hit-tests
                with `centerBookAtPoint`, drawn as its traced path
                (`CENTER_BOOK_PATH`) stretched over the thumbnail by
                `viewBox="0 0 1 1"` and `preserveAspectRatio="none"`. The
                thumbnail never moves, so CSS `:hover` does the highlight.
              */}
              {CENTER_BOOK_PATH && (
                <button type="button" className="catalog-center-book" aria-label="an artist's statement" onClick={onOpenArtistStatement}>
                  <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                    <path d={CENTER_BOOK_PATH} />
                  </svg>
                </button>
              )}
              {/*
                The distill toggle, in the lower right corner as on the map
                (`render.ts`'s `drawDistillToggle`), sized by `distillW`/
                `distillH`.
              */}
              <button
                type="button"
                className="catalog-distill-toggle"
                style={{ width: distillW, height: distillH }}
                aria-pressed={distillMode}
                aria-label={distillMode ? 'disable distillation' : 'enable distillation'}
                onClick={onToggleDistill}
              >
                <img
                  src={urlFor(distillMode ? DISTILL_ON : DISTILL_OFF, 0) ?? ''}
                  alt=""
                  decoding="async"
                  onLoad={(e) => {
                    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                    if (!w || !h) return;
                    setDistillIconSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
                  }}
                />
              </button>
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
                      // The visible text may be ellipsised, so the full term is
                      // in the accessible name (`describeBook`, as the painted
                      // spines use) and the tooltip.
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
              entry={metadata?.[id] ?? null}
              src={urlFor(id, level) ?? urlFor(id, 0) ?? ''}
              thumbPx={rowThumbPx}
              cell={cellOfId(id)}
              onShowOnMap={onShowOnMap}
              onKeyword={onKeyword}
              onExpand={onExpand}
              highlight={highlight}
              tagLinks={tagLinks}
              result={result}
              weights={config.search.weights}
              favorite={favoriteFor(id)}
              narrow={narrow}
              ultraNarrow={ultraNarrow}
              spotlit={id === highlightId}
            />
          ))}

          {below > 0 && <li className="catalog-spacer" style={{ height: below }} aria-hidden="true" />}
        </ul>

        {paging === 'pages' && (
          <nav className="pager" aria-label="catalog pages">
            <button disabled={active === 0} onClick={() => setActive(0)}>
              « first
            </button>
            <button disabled={active === 0} onClick={() => setActive((p) => Math.max(0, p - 1))}>
              ← previous
            </button>
            <span className="pager-count">
              page <b>{active + 1}</b> of {pages}
            </span>
            <button
              disabled={active >= pages - 1}
              onClick={() => setActive((p) => Math.min(pages - 1, p + 1))}
            >
              next →
            </button>
            <button disabled={active >= pages - 1} onClick={() => setActive(pages - 1)}>
              last »
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}

// --- one row ----------------------------------------------------------------

/**
 * One room in the list.
 *
 * A component of its own because each row measures itself after layout:
 * whether its story was cut (which shows "read the rest") and how many
 * chips its chip box hides (the `+N` chip). The row height is uniform, but
 * the stories and keyword lists are not, and a character count cannot
 * predict where the font breaks a line.
 */
function CatalogRow({
  id, rank, total, entry, src, thumbPx, cell,
  onShowOnMap, onKeyword, onExpand, highlight, tagLinks, result, weights, favorite,
  narrow = false, ultraNarrow = false, spotlit = false,
}: {
  id: number;
  rank: number;
  total: number;
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
  favorite: FavoriteControl | null;
  /** whether the list is too narrow to carry the map link beside the name - see `NARROW_PX` */
  narrow?: boolean;
  /** whether the row is the ultra-narrow stack, which renders no `RoomDetails` - see `ULTRA_NARROW_PX` */
  ultraNarrow?: boolean;
  /** whether "show in the catalog" just landed here - see `CatalogView`'s `highlightId` */
  spotlit?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const [hiddenChips, setHiddenChips] = useState(0);
  const desc: Description = describeRoom(id, rank, total, entry);

  // Measures what the row could not show, after layout and on every resize:
  // whether the story was cut (`clipped`) and how many chips are hidden.
  //
  // The story's `max-height` is set here to whatever the fixed-height flow
  // area (`--catalog-flow-h`) leaves below the name and chips. Setting it
  // cannot feed back into the measurement: the story's height never moves
  // its own top, and the flow's height is fixed.
  //
  // Ultra-narrow renders no story or chips, but still resets both values,
  // or a row resized into that shape keeps its last floated-shape result.
  useLayoutEffect(() => {
    if (ultraNarrow) {
      setClipped(false);
      setHiddenChips(0);
      return;
    }
    const card = cardRef.current;
    if (!card) return;
    const measure = () => {
      // `offsetTop` is relative to `.catalog-flow`, which is
      // `position: relative`, so `maxH` runs from the story's top to the
      // flow's bottom edge.
      const flow = card.querySelector<HTMLElement>('.catalog-flow');
      const story = card.querySelector<HTMLElement>('.story');
      if (flow && story) {
        const maxH = Math.max(STORY_LINE_PX, flow.clientHeight - story.offsetTop);
        story.style.maxHeight = `${maxH}px`;
        setClipped(story.scrollHeight > maxH + 1);
      } else {
        setClipped(false);
      }

      const chips = card.querySelector<HTMLElement>('.chips');
      if (!chips) {
        setHiddenChips(0);
        return;
      }
      // A chip is hidden if its bottom passes the chip box's bottom, so a
      // half-visible chip counts. Compared as screen rects, since
      // `offsetTop` would change meaning if an ancestor gained a `position`.
      //
      // The `+N` counter (`.chip-more`) must be skipped: it sits at the box's
      // bottom edge, and counting it would add one to its own number.
      const cut = chips.getBoundingClientRect().bottom;
      let hidden = 0;
      for (const chip of chips.children) {
        if (chip.classList.contains('chip-more')) continue;
        if (chip.getBoundingClientRect().bottom > cut + 1) hidden++;
      }
      setHiddenChips(hidden);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(card);
    const chips = card.querySelector('.chips');
    if (chips) ro.observe(chips);
    return () => ro.disconnect();
  }, [desc.description, entry, result, thumbPx, narrow, ultraNarrow]);

  const tile = (
    <button
      className="catalog-tile-button"
      onClick={() => onExpand(id, rank)}
      aria-label={`enlarge room ${id}`}
    >
      {/*
        `alt` is the room's optional caption (`desc.picture`), or empty. The
        button's `aria-label` is the accessible name, but the caption stays
        for anything else that reads `alt`.
      */}
      <img
        className="catalog-tile"
        src={src}
        alt={desc.picture ?? ''}
        width={thumbPx}
        height={tileHeight(thumbPx)}
        loading="lazy"
        decoding="async"
      />
    </button>
  );

  const head = (
    <div className="catalog-head">
      <h2 className="catalog-name">
        <span className="catalog-rank">{rank + 1}</span>
        {/*
          The title is highlighted like the chips and story, since title is
          a ranking axis. Only a real title is marked: the "Room N" fallback
          never scores.
        */}
        <span className="catalog-title">
          <Highlight text={roomTitle(entry, id)} ranges={entry?.title ? highlight?.title(entry.title) : null} />
        </span>
      </h2>
      {/*
        The map link, on wide rows only. On a narrow row it would squeeze
        the name, and `RoomOverlay`, one tap away on the thumbnail, has the
        same link.

        A room past the "rooms on the map" slider has no cell, so it says
        "not on the map" in place of a dead control.
      */}
      {!narrow &&
        (cell ? (
          <button className="catalog-show" onClick={() => onShowOnMap(cell.x, cell.y)}>
            show on the map
          </button>
        ) : (
          <span className="catalog-show dim">not on the map</span>
        ))}
      {/*
        The favorite toggle is in the head, not in `RoomDetails` (AGENTS.md,
        "A relevance sort is a re-rank, and the catalog row's toggle is in
        the head").
      */}
      {favorite && <FavoriteToggle favorite={favorite} />}
    </div>
  );

  return (
    <li
      className={spotlit ? 'catalog-row spotlight' : 'catalog-row'}
      data-room-id={id}
      aria-setsize={total}
      aria-posinset={rank + 1}
    >
      <div className={clipped ? 'catalog-body paper-sheet clipped' : 'catalog-body paper-sheet'} ref={cardRef}>
        {ultraNarrow ? (
          /*
            The ultra-narrow stack (`ULTRA_NARROW_PX`): name row, picture,
            then a "keywords & story" link into the room overlay in place of
            `RoomDetails`.
          */
          <>
            {head}
            {tile}
            <button type="button" className="catalog-details-link" onClick={() => onExpand(id, rank)}>
              keywords &amp; story →
            </button>
          </>
        ) : (
          <>
            {/*
              The floated shape: the fixed-height flow area (`flowH`), then
              the score strip beneath it. The tile floats inside the flow and
              the story wraps around it (AGENTS.md, "A room row's thumbnail
              floats, and the story wraps around it").

              `RoomDetails` gets `weights={null}` so it renders no score; the
              row places `ScoreBreakdown` below the flow instead. "read the
              rest" is absolutely positioned at the flow's bottom edge.
            */}
            <div className="catalog-flow">
              {tile}
              {head}
              <RoomDetails
                entry={entry}
                desc={desc}
                onKeyword={onKeyword}
                highlight={highlight}
                tagLinks={tagLinks}
                rank={rank}
                result={result}
                weights={null}
                chipOverflow={
                  hiddenChips > 0 ? { count: hiddenChips, onClick: () => onExpand(id, rank) } : null
                }
              />
              {clipped && (
                <button className="catalog-more" onClick={() => onExpand(id, rank)}>
                  read the rest →
                </button>
              )}
            </div>

            <ScoreBreakdown rank={rank} result={result} weights={weights} layout="strip" />
          </>
        )}
      </div>
    </li>
  );
}
