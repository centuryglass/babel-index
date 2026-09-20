/**
 * The catalog: the same corpus as one list, alphabetical by default and
 * ranked like the map whenever a search is running - the two views' idle
 * orders are not the same array, since a shuffle is not a list order anyone
 * can read by eye (see `alphabeticalOrder` in `lib/catalog.ts`).
 *
 * The map is where you are standing - one cursor, whatever is around it.
 * The catalog is the ranking - what matched, all of it, every tile unique
 * and nothing repeated. Different questions, which is why both exist, why
 * neither is a fallback for the other, and why this is not the
 * accessibility mode (AGENTS.md, "The catalog, and the two modes").
 *
 * Everything this has to be right about lives in `lib/catalog.ts` and is
 * asserted without a browser: which rooms are on a page, which pages stay
 * mounted, how tall a spacer must be, which pyramid level a thumbnail asks
 * for. What is here is the rendering and the scroll listener; the pixel
 * constants below are the exception - the pieces of the CSS the spacer
 * arithmetic has to mirror.
 *
 * ### Two paging modes, one mount rule
 *
 * Pagination mounts one page; scrolling mounts a window of them and
 * replaces the rest with spacers of exactly the height they would have
 * occupied. That is the only difference: both slice `pageOf`, so a room
 * cannot appear at a different position depending on how the reader pages.
 *
 * ### Why the rows are ordinary DOM and not a listbox
 *
 * The case for `listbox` - native "3 of 511" announcement and type-ahead -
 * holds for the panel's ranked results, which are bare names. It does not
 * carry here: a listbox option cannot contain the keyword chips every row
 * has, and stripping the chips to win the role would cost more than the
 * role is worth. So this is a `<ul>` whose rows each carry a heading and
 * one primary control, and `aria-setsize`/`aria-posinset` on the `<li>` do
 * the "3 of 511" part by hand.
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

/** One slot on the center shelf, as `assignTitles()` (`center.ts`) returns it - or the row/column position it never fills. */
type Slot = CentreSlot | null;

type Highlight = {
  keyword: (text: string) => MatchRange[];
  title: (text: string) => MatchRange[];
  story: (text: string) => MatchRange[];
} | null;

/**
 * Where the row stops having width to spend on anything but the room itself.
 *
 * Measured from the list, not from a media query, because the two layouts
 * do not differ only in CSS: the narrow one gives the title a second line,
 * and that line has to be paid for in `TEXT_MIN` and the chip/story
 * reserves, or the spacer arithmetic every unmounted page rests on is wrong
 * for every row. One flag, read by the class name and by the constants
 * together, is what keeps them from disagreeing - a media query could only
 * move the CSS half.
 *
 * A width rather than an orientation: portrait phones, split-screen
 * landscape phones and narrow desktop windows all produce the same row
 * with the same problem.
 */
const NARROW_PX = 560;

/**
 * Where a row loses the width to show a thumbnail beside any text at all.
 *
 * `NARROW_PX` already drops the map link and lets the title wrap rather
 * than shrink the two columns forever - but a text column a couple dozen
 * characters wide is rubble, not a smaller version of the wide row. Below
 * this, a row is a different shape: rank/title/favorite get their own
 * full-width line, the picture runs full width beneath it, and the
 * keywords and story move behind a "keywords & story" link into the room
 * overlay (`onExpand`).
 *
 * Measured from the list like `NARROW_PX`, for the same reason: the
 * ultra-narrow shape changes what `rowPx` accounts for
 * (`stackedRowHeight` instead of the flow-area sum), not just how the row
 * looks.
 */
const ULTRA_NARROW_PX = 400;

/**
 * How wide an ultra-narrow row's thumbnail is - the row's own width, not a
 * fraction of it like `thumbWidth`, since the picture runs full-bleed
 * beneath the name row rather than sharing the row with a text column.
 *
 * Trimmed by the two nested horizontal insets around it on both sides
 * (`ROW_H_PAD` + `CARD_H_PAD` doubled = `ULTRA_ROW_HPAD`; the padding
 * rules live on `.catalog-row`/`.catalog-row .catalog-body.paper-sheet` in
 * style.css) and by the mat border on both sides, so the image plus its
 * mat lands flush with the card's edges rather than overflowing them.
 * `matPad` is `CatalogView`'s `MAT_PAD` passed in as an argument, keeping
 * this a pure function.
 */
const ULTRA_ROW_HPAD = 64;
const ultraThumbWidth = (available: number, matPad: number): number =>
  Math.max(80, available - ULTRA_ROW_HPAD - 2 * matPad);

/**
 * The center row's own outer margin and inner padding, one side each -
 * `.catalog-center.paper-sheet`'s `margin`/`padding` in style.css. JS and
 * CSS must agree on both for the same reason `CARD_PAD` does: together
 * they are what `centreUltraThumbWidth` trims the full-bleed thumbnail by.
 */
const CENTRE_MARGIN = 16;
const CENTRE_PAD = 16;
/**
 * How wide the center row's own thumbnail is under ultra-narrow:
 * full-bleed like `ultraThumbWidth` gives every other row, trimmed by the
 * center sheet's own margin and padding rather than a room row's
 * row-plus-card inset.
 */
const centreUltraThumbWidth = (available: number, matPad: number): number =>
  Math.max(80, available - 2 * CENTRE_MARGIN - 2 * CENTRE_PAD - 2 * matPad);

/**
 * How wide a thumbnail is, from the width the list has to spend.
 *
 * Bounded at both ends rather than a fraction outright: under the floor a
 * wall of books is an unreadable smudge, over the cap the story column
 * beside it is too narrow to read. Between them it tracks the display, so
 * a phone gets a smaller tile and more words.
 *
 * The fraction is bigger under `NARROW_PX`: a narrow row's text column
 * needs a fixed amount of vertical space regardless of the tile (the name
 * row, a line of story, the button), so a tile sized off the wide-row
 * fraction sits far short of that and leaves the row's dark background
 * showing beneath it. The bigger fraction closes half of that gap;
 * trimming the fixed text reserves for narrow (`TEXT_MIN`,
 * `CARD_PAD_NARROW`) is the other half.
 */
const thumbWidth = (available: number): number =>
  Math.round(Math.min(240, Math.max(120, available * (available < NARROW_PX ? 0.34 : 0.26))));

/** A row's vertical padding, both halves - the one number CSS and JS must agree on. */
const ROW_PAD = 14;
/** A row's horizontal padding, one side - `.catalog-row`'s `padding: 7px 16px` in style.css. Used to work out the score strip's real width. */
const ROW_H_PAD = 16;
/** The card's horizontal padding, one side - `.catalog-row .catalog-body.paper-sheet`'s `padding: … 16px`. Same purpose as `ROW_H_PAD`. */
const CARD_H_PAD = 16;

/**
 * The paper card's own vertical padding, both halves -
 * `.catalog-row .catalog-body.paper-sheet` in style.css. The card wraps
 * both of the flow area's columns - the thumbnail floats inside it - so
 * this inset costs height the story would otherwise have, and the fixed
 * row it feeds charges it like `ROW_PAD`. Must match the CSS.
 */
const CARD_PAD = 24;
/**
 * The same inset under `.catalog.narrow` (style.css). A narrow row is
 * already tight on height - small tile, wrapped title, the same fixed
 * chrome as a wide row - so a few pixels of padding back go into the
 * chip/story clamps rather than sitting as whitespace; on a wide row the
 * tile usually sets the height anyway.
 */
const CARD_PAD_NARROW = 16;

/**
 * The thumbnail's paper mat - a thin cream border around every tile
 * image, one side's worth. It is a CSS `border` (`--catalog-mat` below),
 * not padding, so the absolutely-positioned overlays on the center row's
 * thumbnail (the open-book hotspot, the distill toggle) keep landing on
 * the image itself rather than needing their own offset - see the mat's
 * comment in style.css. Priced into the row's height like `CARD_PAD`, so
 * the row still matches the mat's full height and the gap between rows
 * never widens.
 */
const MAT_PAD = 6;

/**
 * What sits above and below the story inside a row, and how tall one line
 * of story is - what `chipLines` works its clamp out against, and what
 * `TEXT_MIN` is built from.
 *
 * `TEXT_CHROME_PX` covers the name row and the "read the rest" button, and
 * it is reserved on every row, including the ones that show no button. A
 * per-row reserve would make the clamp vary per row; skipping the reserve
 * clipped the button out of existence on the narrow displays that need it
 * (AGENTS.md, "A fixed row cannot show everything"). A row without one
 * carries a little slack instead. The chips are not folded into it as a
 * flat line count - `CHIP_LINE_PX` works their clamp out of the row's
 * actual leftover space.
 */
const TEXT_CHROME_PX = 50;
const STORY_LINE_PX = 19;

/**
 * What an ultra-narrow row reserves above and below its full-width picture -
 * see `ULTRA_NARROW_PX`. Both are fixed heights handed to CSS through
 * `--catalog-ultra-head`/`--catalog-ultra-details` rather than left to the
 * content's own size, for the same reason `TEXT_CHROME_PX` is flat: the row
 * is fixed-height (`stackedRowHeight`), so what CSS renders and what JS
 * reserved for it cannot be allowed to drift.
 *
 * The head stays one line even though `ULTRA_NARROW_PX < NARROW_PX` means
 * `.narrow`'s two-line title clamp is also in force: style.css overrides it
 * back to a single ellipsised line for `.ultra-narrow` specifically, because
 * there the head has the row's own full width rather than a text column
 * beside a floated tile.
 */
const ULTRA_HEAD_PX = 32;
const ULTRA_DETAILS_PX = 30;

/**
 * The gap between the full-bleed picture and the "keywords & story" link
 * beneath it in an ultra-narrow row. Priced into `stackedRowHeight` like every
 * other piece of that stack, so the fixed row height still matches what CSS
 * renders (`--catalog-ultra-gap`, `.catalog-details-link` in style.css).
 */
const ULTRA_STACK_GAP = 8;

/**
 * The chips' own line height, CSS gap included - the pixel cost
 * `chipLines` charges per line, and what `--catalog-chips-max` hands to
 * `.catalog-row .chips`'s `max-height`; the two must never disagree. It is
 * the real chip height (24.5px rendered) plus `.chips`'s 5px wrap gap,
 * rounded up rather than down: a budget that undercounts the pitch clips
 * the last allowed line instead of showing it whole.
 *
 * Bounded at `CHIP_LINES_MAX`/`_NARROW` rather than left to grow with
 * whatever a tall row leaves over: a corpus room can carry many keywords,
 * and nothing stops a chip wall from being the tallest thing in the row if
 * the cap were the only budget. Narrow gets one more line than wide because
 * a narrow text column is where a chip is most likely to already be alone
 * on its own line - the case a flat cap clips silently, with headroom to
 * spare elsewhere in the very same row.
 */
const CHIP_LINE_PX = 30;
const CHIP_LINES_MAX = 2;
const CHIP_LINES_MAX_NARROW = 3;

/**
 * What the text column needs when the tile is too small to set the row's
 * height: the name row and button (`TEXT_CHROME_PX`), the most chip lines a
 * narrow row is ever allowed (`CHIP_LINES_MAX_NARROW`), and one line of
 * story - derived from those rather than a separate guess, so a row is
 * never sized too short for the chip budget `chipLines` is about to compute
 * against it. The row's height is whichever of the two columns is taller.
 */
const TEXT_MIN = TEXT_CHROME_PX + CHIP_LINES_MAX_NARROW * CHIP_LINE_PX + STORY_LINE_PX;
/**
 * The score strip's arithmetic, while a search is running.
 *
 * The strip sits in normal flow below the fixed-height flow area that
 * carries the tile, name, chips and story, so its top rule always lands
 * under the image rather than crossing it, and it always gets the card's
 * full width - no inset stealing room from the columns.
 *
 * It is a full-width "match strength" composite line plus up to
 * `SCORE_DETAIL_LINES` per-axis detail lines (tag, title, story, clip).
 * Those flow into columns that are content-sized and left-aligned (not
 * stretched to fill), and once the row is wide enough to give every detail
 * its own column the composite joins them as one more column (`oneRow`)
 * instead of taking a line to itself. `scoreLayoutFor` derives the column
 * count and the resulting line count purely from the width the strip has,
 * so the reserved height is uniform across every row - reserving the worst
 * case (all `SCORE_DETAIL_LINES` details) the same way `TEXT_CHROME_PX`
 * reserves the "read the rest" button on rows that don't show one: a height
 * that varied per room would make the sliding window's spacer arithmetic
 * wrong for that row.
 *
 * `SCORE_LINE_PX`/`SCORE_PAD_PX` are the rendered line pitch and the
 * strip's own border+padding (`.score-strip` in style.css) - the numbers
 * CSS and this reserve must agree on, same contract as `CHIP_LINE_PX`.
 */
const SCORE_DETAIL_LINES = 4;
const SCORE_LINE_PX = 15;
const SCORE_PAD_PX = 8;
/** The gap between score columns - must match `.score-details`'s `column-gap` in style.css. */
const SCORE_GAP_PX = 22;
/**
 * The most a detail column is allowed to be, in px. The shortened lines render
 * around 135-150px, so this both caps the rare long one (`.score-line`'s
 * `max-width` in style.css, ellipsised past it) and is the width the fit math
 * budgets per column - a real ceiling rather than a guess at the widest
 * possible line.
 */
const SCORE_DETAIL_COL_PX = 200;
/** About how wide the composite "match strength" line is - its own column in the one-row layout. */
const SCORE_COMPOSITE_PX = 225;
/**
 * The score strip's column layout for a given strip width: how many columns the
 * details take, whether the composite line joins them as one more column on a
 * single row, and the total line count that follows (what the reserved height
 * is built from). `columnsFor` answers "how many W-wide columns fit with a gap
 * between each" - N columns need N·W + (N-1)·gap - so it credits back the last
 * column's missing gap instead of charging a full column+gap to every one.
 */
function columnsFor(availPx: number, colPx: number): number {
  return Math.max(0, Math.floor((availPx + SCORE_GAP_PX) / (colPx + SCORE_GAP_PX)));
}
function scoreLayoutFor(stripWidthPx: number): { oneRow: boolean; cols: number; lines: number } {
  // One row when all four detail columns and the composite column fit side
  // by side (five items, four gaps between them).
  const oneRowPx = SCORE_DETAIL_LINES * SCORE_DETAIL_COL_PX + SCORE_COMPOSITE_PX + SCORE_DETAIL_LINES * SCORE_GAP_PX;
  if (stripWidthPx >= oneRowPx) return { oneRow: true, cols: SCORE_DETAIL_LINES, lines: 1 };
  // Otherwise the composite keeps its own full-width line and the details flow
  // into as many columns as fit, floored at two so there is always more than a
  // single stacked list.
  const cols = Math.min(SCORE_DETAIL_LINES, Math.max(2, columnsFor(stripWidthPx, SCORE_DETAIL_COL_PX)));
  return { oneRow: false, cols, lines: 1 + Math.ceil(SCORE_DETAIL_LINES / cols) };
}
const scoreStripHeight = (lines: number): number => SCORE_PAD_PX + SCORE_LINE_PX * lines;

/**
 * One line of the room's name, and what a second one costs.
 *
 * `--catalog-title-line` hands the same number to the clamp in CSS, so the
 * height reserved here and the height the title actually takes are one value.
 */
const TITLE_LINE_PX = 16;

/**
 * How wide a shelf link is, in characters.
 *
 * The shelf is a grid of equal cells rather than a wrapped row of pills
 * sized to their own text: tags of many different lengths read as rubble,
 * and the wall they stand for is a grid of identical spines. So one width,
 * taken from the longest title actually on the wall (`shelfColumnCh`) so
 * nothing is clipped that does not have to be - bounded, so one very long
 * search term cannot set the column width for every other book.
 */
const SHELF_MIN_CH = 9;
const SHELF_MAX_CH = 18;

/**
 * How long a room's row stays visibly picked out after "show in the
 * catalog" lands it - long enough to find on a page full of identical
 * rows, short enough to read as a one-time announcement rather than a
 * standing marker. The CSS animation named `catalog-spotlight` in style.css
 * runs this same duration; the timer here and the animation there have to
 * be changed together.
 */
const SPOTLIGHT_MS = 1600;
const shelfColumnCh = (slots: Slot[]): number =>
  Math.min(
    SHELF_MAX_CH,
    Math.max(SHELF_MIN_CH, ...slots.map((s) => (s?.text ? s.text.length : 0)))
  );

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
   * "Show in the catalog", from the map card's overlay: a room to scroll to
   * and pick out, once. `null` the rest of the time - this is a one-shot
   * trigger, not a standing "currently selected room," so a second visit to
   * the same room fires again only because the caller sets it again.
   */
  spotlightId?: number | null;
  /** Fired once `spotlightId` has been acted on (or found gone from `order`),
   * so the caller can clear it back to `null` and arm the next one. */
  onSpotlightHandled?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const centreRowRef = useRef<HTMLLIElement>(null);
  // Viewport = `.catalog-scroll` (`scrollRef`) - stays the real native
  // scroll container, so the virtualized window (`onScroll`/`pageAtScroll`
  // below) keeps reading its actual `scrollTop`, untouched by the zoom
  // transform on the list itself. See useContentZoom.ts.
  const contentZoom = useContentZoom(scrollRef);
  const [geom, setGeom] = useState({ width: 900, height: 700 });
  const [active, setActive] = useState(0);
  // The distill toggle's own decoded pixel size, read off its `<img>` once
  // it loads rather than hardcoded - see `distillW`. Starts at {0, 0} so
  // the button has no footprint (but the right corner it anchors to) until
  // the first load reports real numbers.
  const [distillIconSize, setDistillIconSize] = useState({ w: 0, h: 0 });
  // Where the center row's cover picture sits on the shelf's own column
  // grid, when narrow (`.catalog.narrow .catalog-center` in style.css). The
  // picture is a grid item spanning `picCols` columns and `picRows` rows of
  // the same grid the spine buttons flow through, so both column sets land
  // on one set of grid lines - a float cannot share grid lines, and the
  // center row cannot use one (AGENTS.md, "The catalog, and the two modes").
  // `picNext`/`subStart` are grid lines the title and index-shelf line
  // start on: CSS grid line numbers take a plain custom property but not a
  // `calc()`, so the addition happens here. The fitting effect below fills
  // these from the grid's own resolved track sizes; the defaults are a
  // sane first paint before it measures.
  const [centreGrid, setCentreGrid] = useState({
    picCols: 2, picNext: 3, picRows: 4, subStart: 2, subRows: 1, titleRows: 1,
  });
  // The center row's real height. It is the one row allowed to size itself:
  // it holds the whole shelf - every title, wrapping to as many lines as
  // the width needs - and clipping them to a tile's height would hide the
  // newest searches. It can be variable because it sits outside the paging
  // arithmetic: the spacers stand in for paged rows, and this is not one.
  // What the arithmetic does need is how tall it actually is, which is
  // measured rather than assumed.
  const [leadPx, setLeadPx] = useState(0);
  // The row "show in the catalog" is currently picking out - see
  // `spotlightId`'s effect below. Distinct from `spotlightId` itself: this is
  // the standing visual state (until its own timer clears it), the prop is a
  // one-shot instruction to start showing it.
  const [highlightId, setHighlightId] = useState<number | null>(null);
  // Which id the focus-move effect below has already acted on, so a `rows`
  // identity change while the same room is still highlighted (e.g. a resize)
  // does not steal focus back a second time.
  const focusedIdRef = useRef<number | null>(null);

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
  // Narrow rows drop the map link and let the name wrap instead of clipping
  // it - see `NARROW_PX`. Both halves of that trade are priced below.
  const narrow = geom.width < NARROW_PX;
  // Below `ULTRA_NARROW_PX`, a row is a different shape rather than a
  // smaller one - see that constant's own comment. `narrow` still holds
  // (`ULTRA_NARROW_PX < NARROW_PX`), so the map-link/wrapped-title trade
  // above applies underneath it too.
  const ultraNarrow = geom.width < ULTRA_NARROW_PX;
  // The mat is halved on a widescreen row, where the larger thumbnail does
  // not need the full cream frame to read as a plate on the sheet; a narrow
  // row's smaller tile keeps it. Everything the mat is priced into below
  // reads this rather than `MAT_PAD` directly, so the row height stays exact
  // at either width (`ultraNarrow` implies `narrow`, so a phone row keeps
  // the full mat).
  const matPad = narrow ? MAT_PAD : MAT_PAD / 2;
  // The center row's own thumbnail - `thumbWidth`'s fraction ordinarily,
  // full-bleed under ultra-narrow via `centreUltraThumbWidth`.
  const thumbPx = ultraNarrow ? centreUltraThumbWidth(geom.width, matPad) : thumbWidth(geom.width);
  // The distill toggle as fractions of the thumbnail, not pixels: the map's
  // canvas overlay (`distillIconScreenRect`, `distillToggle.ts`) scales the
  // icon by the tile's pixels-per-cell-width over `BASE_TILE.w`, so as a
  // share of the tile the icon is a constant `iconSize / BASE_TILE`,
  // whatever the thumbnail's size. Percentages let the picture be sized by
  // the grid without a pixel rect to keep in step; the anchor is the
  // bottom-right corner (style.css). Like the canvas draw, the real art's
  // size is read at load - the `<img>`'s own `onLoad` reports it - not
  // hardcoded.
  const distillW = distillIconSize.w ? `${(distillIconSize.w / BASE_TILE.w) * 100}%` : '0';
  const distillH = distillIconSize.h ? `${(distillIconSize.h / BASE_TILE.h) * 100}%` : '0';
  // Fit the cover picture to a whole number of the shelf's own grid columns
  // so the spines above and below share one set of column lines. Read the
  // grid's resolved track sizes rather than mirroring the CSS math in JS:
  // the browser has already stretched `minmax(--shelf-col, 1fr)` to the real
  // column width, and `-1` handles the last line without JS ever counting
  // columns. Wide and narrow share this one grid (a wide display just fits
  // more columns); only `ultraNarrow` stacks into a single column and
  // ignores these vars. Runs pre-paint (`useLayoutEffect`) so the fitted
  // spans are in place before the row is ever shown; `centreGrid` is in the
  // deps so a title or index-line that reflows to a new height (its width
  // changes with `picCols`) settles in a second pass, and the equality
  // guard stops there.
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
    // Round the span up, never down: the cover picture is allowed to be
    // larger than the spines beneath it, but snapping it smaller than its
    // natural width is not.
    const picCols = Math.max(1, Math.min(cols - 1, Math.ceil((thumbPx + colGap) / (colW + colGap))));
    // The picture's row span comes from its own measured height (its width
    // is now `picCols` columns), not from aspect-and-border arithmetic that
    // would have to track the mat border and box-sizing by hand. It may be a
    // pass behind when `picCols` just changed - `centreGrid` in the deps
    // settles it.
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
  // A room row's own thumbnail - full-bleed under ultra-narrow, a fraction of
  // the width otherwise. Distinct from the center row's `thumbPx` above,
  // which is trimmed by the center sheet's own padding rather than a room
  // row's row-plus-card inset.
  const rowThumbPx = ultraNarrow ? ultraThumbWidth(geom.width, matPad) : thumbWidth(geom.width);
  // The score strip's column layout and reserved height, while a search is
  // running - a pure function of the width the strip has (the card's content
  // width, both horizontal insets removed), so every row reserves the same
  // band and the spacer arithmetic stays exact. Zero with no search: the strip
  // is absent and the flow area reclaims its whole height.
  const scoring = Boolean(result?.breakdown);
  const stripWidth = Math.max(0, geom.width - 2 * ROW_H_PAD - 2 * CARD_H_PAD);
  const scoreLayout = scoreLayoutFor(stripWidth);
  const scoreH = scoring ? scoreStripHeight(scoreLayout.lines) : 0;
  // The flow area carries the tile, name, chips and story at a fixed height;
  // the score strip sits in normal flow beneath it. Every row grows together
  // when a search starts, because every row gains the same score band under
  // the same flow - so the rows stay uniform and the spacers stay exact,
  // which is the property the sliding window rests on. `flowH` is what the
  // tile (or the text minimum, whichever is taller) needs; the score is
  // added on top rather than competing with the tile for one shared band, so
  // its rule never has to sit beside the image.
  const flowH = ultraNarrow ? 0 : Math.max(tileHeight(rowThumbPx) + 2 * matPad, TEXT_MIN + titleReserve);
  const rowPx = ultraNarrow
    ? stackedRowHeight(rowThumbPx, ULTRA_HEAD_PX, ULTRA_DETAILS_PX, ROW_PAD + cardPad, matPad, ULTRA_STACK_GAP)
    : flowH + scoreH + ROW_PAD + cardPad;
  const level = thumbLevel(rowThumbPx, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);

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

  // How many lines of chips a row can show, derived from the flow area's
  // height (the score sits below the flow, not inside it) - see
  // `chipLines`/`CHIP_LINE_PX`. Reserving one story line up front keeps a
  // keyword-heavy room from squeezing the story out entirely; the cap
  // (`CHIP_LINES_MAX`/`_NARROW`) keeps a very tall row's chip wall from
  // growing without bound. Whatever does not fit is counted and reported by
  // the row itself (`chipOverflow` in `CatalogRow`) rather than
  // disappearing - no reserve can promise that a room's keywords fit at a
  // given width, so the row says so instead.
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

  // A new ranking is a new list. Staying on page 40 of a search that just
  // returned nine rooms would show an empty screen and read as broken.
  useEffect(() => {
    setActive(0);
    if (scrollRef?.current) scrollRef.current.scrollTop = 0;
  }, [result, order, scrollRef]);

  // "Show in the catalog": a one-shot trigger from the map card's overlay (see
  // `spotlightId`'s own doc comment). Jump to the room's page in pagination
  // mode, or scroll straight to its row (`focusScrollTop`) in scroll mode -
  // either way, `highlightId` is what actually picks it out; that happens in
  // its own effect below, once the row exists to pick out.
  //
  // Keyed on `spotlightId` alone: everything else this reads (`order`,
  // `paging`, `rowPx`, ...) is read at the moment the trigger fires, not
  // re-applied if one of them changes afterwards - this is a jump, not a
  // standing constraint to keep re-satisfying.
  useEffect(() => {
    if (spotlightId == null) return;
    const rank = order.indexOf(spotlightId);
    if (rank < 0) {
      // Filtered out (blocked tag) or otherwise gone from this ranking -
      // nowhere to jump to, so just clear the trigger.
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

  // The pulse clears itself on a timer rather than staying until the next
  // trigger - a highlight nobody asked to end reads as "this row means
  // something now," which it doesn't.
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

  // Moves keyboard/screen-reader focus onto the highlighted row, once it is
  // actually mounted. Keyed on `rows` rather than firing straight out of the
  // trigger effect above: scrolling to a row outside the currently mounted
  // window does not mount it synchronously - the browser's own `scroll` event
  // has to land, `onScroll` has to move `active`, and only then does this
  // room show up in `rows`. Querying the DOM before that finds nothing.
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

  // Spacers stand in for pages the reader can scroll to. Paginated, there is
  // nowhere to scroll - the other pages are behind a button - so standing in
  // for them leaves a screenful of nothing between the last row and the pager.
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
            The same "forget searches" act as the shelf's black-spined book
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
                  The order is named here and again by the sort select beside
                  it, and on a narrow bar those two facts cost a whole line of
                  a phone's screen between them. So the clause goes only where
                  the select is there to carry it.
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
            A select rather than the paging radiogroup's shape: these are
            mutually exclusive orderings of the same list, one of which is
            the default - what a select says natively - and, unlike paging,
            the reader is choosing what they are looking at rather than how
            it advances. Shown regardless of `favorites`: 'random' needs no
            favorite data, only the 'mine'/'count' options do.

            Sorting is a re-rank, not a search: it moves rooms within the
            ranking already in force (see `favoriteOrder`), so a term stays
            searched and the row a room sits in stays the row the map would
            fly to. Picking 'random' while a search is running clears it
            first (`main.tsx`'s `changeSort`) - reshuffling underneath a
            search's own order would look like the sort did nothing.
          */}
          <label className="catalog-sort">
            {/*
              The label is the select's accessible name, so a narrow bar
              hides it from sight rather than dropping it - `display: none`
              would take the name with it and leave a select announcing only
              its own value.
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
        <ul
          className={contentZoom.zoomed ? 'catalog-list zoom-scope zoomed' : 'catalog-list zoom-scope'}
          ref={contentZoom.ref}
          style={contentZoom.style}
        >
          {/*
            Row 0 is the center room, and its right-hand column is the shelf -
            the slots `assignTitles` returns, as ordinary links. This is the
            one view where the whole wall is legible at once, and each link
            runs the same `onBook` a painted spine does.
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
              {/*
                The distill toggle - the same lower right corner overlay the
                map's own canvas draws (`render.ts`'s `drawDistillToggle`),
                sized by static percentages here (`distillW`/`distillH`)
                rather than per-frame imperative style writes, since this
                thumbnail is a fixed size and never moves.
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

/**
 * One room in the list.
 *
 * Its own component for one reason: it has to know whether its own story
 * got clipped, and that is a measurement, not something the parent can work
 * out. The clamp is uniform across the page but the stories are not - so
 * "is there more to read" is per row, and a "read the rest" button on a
 * story that is already whole would be a lie on every row that has nothing
 * to expand.
 *
 * Measured rather than estimated from the character count: where the text
 * actually breaks depends on the font, the column width and the words, and
 * a character count is wrong at the boundary - the only place the answer
 * matters.
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
  /**
   * Whether the list has no width left to show keywords or story beside the
   * tile at all - see `ULTRA_NARROW_PX`. The row becomes a stack (name row,
   * full-width picture, a "keywords & story" link into the overlay) instead
   * of the usual floated-tile card, and `RoomDetails` is not rendered at all.
   */
  ultraNarrow?: boolean;
  /** whether "show in the catalog" just landed here - see `CatalogView`'s `highlightId` */
  spotlit?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const [hiddenChips, setHiddenChips] = useState(0);
  const desc: Description = describeRoom(id, rank, total, entry);

  // What the row could not show, measured after layout and again whenever
  // the row changes shape: the story's cut, and the count of keywords the
  // chip box cannot hold.
  //
  // The story's ceiling is measured, not reserved: the flow area is a fixed
  // height (`--catalog-flow-h`), so the story gets exactly what is left under
  // the name and chips, down to the flow's bottom edge. It can fill several
  // more lines than a worst-case reserve would have allowed, and its fade (a
  // mask keyed to `.clipped`) lands on its own cut rather than a guessed
  // offset. Setting the story's `max-height` cannot feed back into this: the
  // story sits below the name and chips, so its own height never moves its
  // top, and the flow (and card) heights are fixed regardless.
  //
  // Ultra-narrow renders neither the story nor the chips - see the
  // `ultraNarrow` prop - so there is nothing here to measure. Both flags
  // still have to be reset rather than just skipped: a row that was clipped
  // in the floated shape and then resizes into this one keeps whatever
  // state that last measurement left behind otherwise.
  useLayoutEffect(() => {
    if (ultraNarrow) {
      setClipped(false);
      setHiddenChips(0);
      return;
    }
    const card = cardRef.current;
    if (!card) return;
    const measure = () => {
      // Fit the story to the flow's leftover height and ask whether it had to
      // cut. `offsetTop` is within `.catalog-flow` (it is `position: relative`),
      // so this is the space between the story's top and the flow's bottom edge.
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
      // Compared as screen rects rather than `offsetTop`, which is measured
      // against whichever ancestor happens to be positioned and would quietly
      // mean something different the day one of them gains a `position`. A
      // chip only half in view counts as hidden: a keyword you cannot read
      // whole is one the row did not show.
      //
      // The counter itself is skipped, and must be: it sits at the bottom edge
      // of the box it is reporting on, so counting it would add one to its own
      // number on every pass.
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
        `alt` is the sidecar's optional caption (`desc.picture`), empty when
        the corpus does not carry one. It is redundant for a screen reader
        here - the wrapping button's `aria-label` wins the accessible name -
        but the attribute is still correct: this is the room's real caption,
        not decoration, for anything else that reads `alt` (view source, an
        image-only crawler, a broken-image fallback).
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
          The title carries search highlighting as the chips and story do -
          a title match is one of the axes the ranking scores (RoomDetails'
          `titleLine`), so a reader sees where in the name it landed. Only
          the corpus's real title is marked; the "Room N" fallback never
          scored a title match, so highlighting it would claim one that did
          not happen.
        */}
        <span className="catalog-title">
          <Highlight text={roomTitle(entry, id)} ranges={entry?.title ? highlight?.title(entry.title) : null} />
        </span>
      </h2>
      {/*
        The map link is the first thing a narrow row gives up. It is the
        widest fixed item on the line the room's own name has to share, and
        a name clipped to "Room" to make space for it loses the thing the
        row exists to show - while `RoomOverlay`, one tap away on the
        thumbnail, carries the same link. Wide rows keep it: there the
        width costs nothing and it saves the tap.

        A room past the "rooms on the map" slider has no cell to fly to, and
        saying so is more honest than a dead control - it is also the only
        place that slider's effect is visible as something other than a
        thinner map.
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
        The row's favorite toggle sits in the head, not inside
        `RoomDetails` where the card and the overlay put it: a fixed-height
        row cannot reserve text-column room for a control without costing
        story lines on every row (AGENTS.md, "the catalog row's toggle is
        in the head"). In the head it costs width on a line that already
        exists.
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
            The ultra-narrow stack - see `ULTRA_NARROW_PX`. The name row
            comes first and full width (in the floated shape below, the head
            sits beside the picture), the picture runs the row's own width
            beneath it, and the keywords and story `RoomDetails` would
            otherwise show are not rendered at all: a "keywords & story"
            link into the same overlay every other "read more" affordance
            here opens (`onExpand`) stands in for them.
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
              The fixed-height flow area (`flowH`), with the score strip in
              normal flow beneath it - the split the score-strip arithmetic
              reserves against, which keeps the strip's top rule below the
              tile and gives its columns the card's full width.

              The tile is a button because pressing it opens the room at
              whatever size the display allows. It floats inside the flow, so
              the story wraps beside it and runs the flow's full width once
              past its bottom edge: height a row does not spend on the
              picture goes to the story rather than dark background under a
              small thumbnail (AGENTS.md, "The catalog, and the two modes").
              `RoomDetails` is called with `weights={null}` here so it renders
              no score of its own - the row places `ScoreBreakdown` below the
              flow instead - and "read the rest" is absolutely positioned at
              the flow's bottom edge, over the story's own cut.
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
