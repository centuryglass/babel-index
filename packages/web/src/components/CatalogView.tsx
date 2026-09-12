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
import { roomTitle, type RoomMeta } from '../../../map/metadata.ts';
import type { SearchResult, MatchRange } from '../../../map/searchResult.ts';
import type { SortMode } from '../../../map/favorites.ts';
import type { Config } from '../../../config/config.ts';
import type { UrlFor } from '../lib/rooms.ts';
import { describeBook, CENTER_BOOK_PATH, type Slot as CentreSlot } from '../lib/center.ts';
import { RoomDetails, FavoriteToggle, type FavoriteControl } from './RoomDetails.tsx';
import { SearchForm } from './SearchForm.tsx';
import {
  pageOf,
  pageCount,
  mountedPages,
  spacerHeight,
  rowHeight,
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

type Highlight = { keyword: (text: string) => MatchRange[]; story: (text: string) => MatchRange[] } | null;

/**
 * Where the row stops having width to spend on anything but the room itself.
 *
 * Measured from the list, not from a media query, because the two layouts do
 * not differ only in CSS: the narrow one gives the title a second line, and
 * that line has to be paid for in `TEXT_MIN` and the chip/story reserves or
 * the spacer arithmetic every unmounted page rests on is wrong for every row.
 * One flag, read by the class name and by the constants together, is what
 * keeps them from disagreeing - a media query could only move the CSS half.
 *
 * A width rather than an orientation: a phone in portrait is the case that
 * prompted this, but a split-screen landscape phone and a narrow desktop
 * window are the same row with the same problem.
 */
const NARROW_PX = 560;

/**
 * Where a row loses the width to show a thumbnail BESIDE any text at all.
 *
 * `NARROW_PX` already drops the map link and lets the title wrap rather than
 * shrink the two columns forever - but a text column a couple dozen
 * characters wide is unreadable rubble, not a smaller version of the wide
 * row. Below this, a row is a different SHAPE rather than a smaller one:
 * rank/title/favorite get their own full-width line, the picture runs full
 * width beneath it, and the keywords and story move behind a "keywords &
 * story" link into the room overlay (`onExpand`) that already exists for
 * this, rather than being crushed into a sliver beside the tile.
 *
 * A width below `NARROW_PX`, same reasoning as that constant - measured from
 * the list, not a media query, because the ultra-narrow shape changes what
 * `rowHeight`'s spacer arithmetic has to account for (`stackedRowHeight`
 * instead of `rowHeight`), not just how the row looks.
 */
const ULTRA_NARROW_PX = 400;

/**
 * How wide an ultra-narrow row's thumbnail is - the row's own width, not a
 * fraction of it like `thumbWidth`, since the picture runs full-bleed
 * beneath the name row rather than sharing the row with a text column.
 * Trimmed by the two nested horizontal insets around it (the row's own
 * padding and the card's, 16px a side each - see `.catalog-row`/
 * `.catalog-row .catalog-body.paper-sheet` in style.css) and by the mat
 * border on both sides, so the image (plus its mat) lands flush with the
 * card's edges instead of overflowing them - `matPad` is `CatalogView`'s
 * `MAT_PAD`, passed in rather than read as a module constant here so this
 * stays a pure function of its arguments.
 */
const ULTRA_ROW_HPAD = 64;
const ultraThumbWidth = (available: number, matPad: number): number =>
  Math.max(80, available - ULTRA_ROW_HPAD - 2 * matPad);

/**
 * The center row's own outer margin and inner padding, one side each -
 * `.catalog-center.paper-sheet`'s `margin`/`padding` in style.css. JS and
 * CSS must agree on both for the same reason `CARD_PAD` does: together they
 * are what `centreUltraThumbWidth` trims the full-bleed thumbnail by.
 */
const CENTRE_MARGIN = 16;
const CENTRE_PAD = 16;
/**
 * How wide the center row's own thumbnail is under ultra-narrow - full-bleed
 * across the sheet exactly like `ultraThumbWidth` gives every other row, just
 * trimmed by the center sheet's own margin and padding on both sides
 * (`CENTRE_MARGIN`, `CENTRE_PAD`) rather than a room row's row-plus-card inset.
 */
const centreUltraThumbWidth = (available: number, matPad: number): number =>
  Math.max(80, available - 2 * CENTRE_MARGIN - 2 * CENTRE_PAD - 2 * matPad);

/**
 * How wide a thumbnail is, from the width the list has to spend.
 *
 * Bounded at both ends rather than a fraction outright: below about 120px a
 * wall of books is an unreadable smudge, and above 240 the story beside it gets
 * squeezed into a column too narrow to read. Between those it tracks the
 * display, so a phone gets a smaller tile and more words.
 *
 * The fraction itself is bigger under `NARROW_PX`: a narrow row's text column
 * needs a fixed amount of vertical space regardless of the tile (the name row,
 * a line of story, the button), so a tile sized off the same fraction as a
 * wide row sits far short of that and leaves the row's own dark background
 * showing beneath it. Giving the tile more of a narrow row's width is half of
 * closing that gap - trimming the fixed text reserves for narrow is the other
 * half, in the chip/story accounting below.
 */
const thumbWidth = (available: number): number =>
  Math.round(Math.min(240, Math.max(120, available * (available < NARROW_PX ? 0.34 : 0.26))));

/** A row's vertical padding, both halves - the one number CSS and JS must agree on. */
const ROW_PAD = 14;

/**
 * The paper card's own vertical padding, both halves - a room sits on a cream
 * `.paper-sheet` (see `.catalog-row .catalog-body.paper-sheet` in style.css),
 * and that inset costs height the story would otherwise have. Charged to the
 * row alongside `ROW_PAD`, because the card wraps both of `rowHeight`'s
 * columns - the thumbnail floats inside it. Same fixed-height invariant the
 * spacer arithmetic rests on. Must match the CSS.
 */
const CARD_PAD = 24;
/**
 * The same inset, trimmed for narrow rows - `.catalog.narrow .catalog-row
 * .catalog-body.paper-sheet` in style.css. A narrow row is already tight on
 * height (a small tile, a wrapped title, the same fixed chrome as a wide
 * row), so giving back a few pixels of padding here is real room for the
 * chips/story clamps below rather than wasted whitespace, unlike `CARD_PAD`
 * on a wide row where the tile usually sets the height anyway.
 */
const CARD_PAD_NARROW = 16;

/**
 * The thumbnail's paper mat - a thin cream border around every tile image,
 * one side's worth. It is a CSS `border` (`--catalog-mat` below), not
 * padding, so the absolutely-positioned overlays on the center row's
 * thumbnail (the open-book hotspot, the distill toggle) keep landing on the
 * image itself rather than needing their own offset - see the mat's own
 * comment in style.css. Priced into `rowHeight` exactly like `CARD_PAD`, so
 * the row still matches the mat's full height and the black gap between rows
 * never widens.
 */
const MAT_PAD = 6;

/**
 * What sits above and below the story and the chips inside a row, and how
 * tall one line of story is - what `chipLines` works its clamp out against,
 * and what `TEXT_MIN` is built from.
 *
 * `TEXT_CHROME_PX` covers the name row and the "read the rest" button -
 * INCLUDING on rows that do not show one. Reserving only where the button
 * appears would need the clamp to vary per row, and it is uniform by design;
 * reserving nowhere is what made the button invisible on a phone, which is
 * the display it matters most on. A row without one carries a little slack
 * instead, which is the cheaper mistake. Chips are no longer folded into this
 * as a flat "two lines" - see `CHIP_LINE_PX` below, which is what replaced
 * that guess with the row's actual leftover space.
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
 * `.narrow`'s two-line title clamp is also in force - style.css overrides it
 * back to a single ellipsised line for `.ultra-narrow` specifically, because
 * the head is now the row's own full width rather than a text column beside
 * a floated tile, and has room for the title on one line that the narrow
 * shape never did.
 */
const ULTRA_HEAD_PX = 32;
const ULTRA_DETAILS_PX = 30;

/**
 * The chips' own line height, CSS gap included - the pixel cost `chipLines`
 * charges per line, and what `--catalog-chips-max` below hands to
 * `.catalog-row .chips`'s `max-height` so the two never disagree. Measured
 * against the real rendered chip (24.5px tall) plus `.chips`'s own 5px wrap
 * gap, rounded up rather than down - a budget that undercounts the real
 * pitch clips the last allowed line instead of showing it whole, which is
 * the same bug this whole change exists to fix.
 *
 * Bounded at `CHIP_LINES_MAX`/`_NARROW` rather than left to grow with
 * whatever a tall row leaves over: a corpus room can carry many keywords, and
 * nothing stops the wall of chips from being the tallest thing in the row if
 * the cap were the only budget. Narrow gets one more line than wide because a
 * narrow text column is where a chip is most likely to already be alone on
 * its own line - the case a flat two-line cap silently clipped a third
 * keyword in, with headroom to spare elsewhere in the very same row.
 */
const CHIP_LINE_PX = 30;
const CHIP_LINES_MAX = 2;
const CHIP_LINES_MAX_NARROW = 3;

/**
 * What the text column needs when the tile is too small to set the row's
 * height: the name row and button (`TEXT_CHROME_PX`), the most chip lines a
 * narrow row is ever allowed (`CHIP_LINES_MAX_NARROW`), and one line of
 * story - derived from those rather than a separate guess, so a row is never
 * sized too short for the chip budget `chipLines` is about to compute against
 * it. `rowHeight` takes whichever of the two columns is taller.
 */
const TEXT_MIN = TEXT_CHROME_PX + CHIP_LINES_MAX_NARROW * CHIP_LINE_PX + STORY_LINE_PX;
/**
 * Reserves room for the score strip's full four lines (composite, tag, story,
 * clip) on EVERY row while a search is running, whether or not this room's own
 * ranking found that many - same reasoning as `TEXT_CHROME_PX` reserving
 * the "read the rest" button on rows that don't show one: a height that
 * varied with how much a room matched would make the sliding window's spacer
 * arithmetic wrong for that row.
 */
const SCORE_STRIP_PX = 70;

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
 * The shelf is a GRID of equal cells rather than a wrapped row of pill-shaped
 * buttons sized to their own text: forty tags of forty different lengths read
 * as rubble, and the wall they stand for is a grid of identical spines. So one
 * width, taken from the longest title actually on the wall so nothing is
 * clipped that does not have to be, and bounded - one very long search term
 * should not set the column width for the other thirty-nine.
 */
const SHELF_MIN_CH = 9;
const SHELF_MAX_CH = 18;

/**
 * How long a room's row stays visibly picked out after "show in the catalog"
 * lands it - long enough to find on a page full of identical rows, short
 * enough that it reads as a one-time announcement rather than a persistent
 * marker of anything. `SPOTLIGHT_MS` names the CSS animation's own duration
 * (`catalog-spotlight` in index.html) so the two cannot drift apart.
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
  const [geom, setGeom] = useState({ width: 900, height: 700 });
  const [active, setActive] = useState(0);
  // The distill toggle's own decoded pixel size, read off its `<img>` once it
  // loads rather than hardcoded - see the distill fraction comment below.
  // Starts at {0, 0} so the button has no footprint (but the right corner it
  // anchors to) until the first load reports real numbers.
  const [distillIconSize, setDistillIconSize] = useState({ w: 0, h: 0 });
  // Where the center row's cover picture sits on the shelf's own column grid,
  // when narrow (`.catalog.narrow .catalog-center` in style.css). The picture
  // is a grid item spanning `picCols` columns and `picRows` rows of the SAME
  // grid the spine buttons flow through, so the two columns beside it and the
  // columns beneath it land on one set of grid lines - the alignment the
  // float could not give. `picNext`/`subStart` are the grid LINES the title
  // and index-shelf line start on (CSS grid line numbers take a plain custom
  // property but not a `calc()`, so the addition is done here). Filled by the
  // effect below from the grid's own resolved track sizes; the defaults are a
  // sane first paint before it measures.
  const [centreGrid, setCentreGrid] = useState({
    picCols: 2, picNext: 3, picRows: 4, subStart: 2, subRows: 1, titleRows: 1,
  });
  // The center row's real height. It is the ONE row allowed to size itself -
  // it holds the whole shelf, forty titles that wrap to as many lines as the
  // width needs, and clipping them to a tile's height would hide the newest
  // searches. It can be variable precisely because it sits outside the paging
  // arithmetic: the spacers stand in for PAGED rows, and this is not one. What
  // the arithmetic does need is how tall it actually is, which is measured
  // rather than assumed.
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
  // The center row's own thumbnail - `thumbWidth`'s fixed two-column
  // fraction ordinarily, but full-bleed under ultra-narrow exactly like
  // `ultraThumbWidth` gives every other row, just trimmed by the sheet's own
  // padding (`CENTRE_PAD`, both sides - `.catalog.ultra-narrow
  // .catalog-center.paper-sheet` in style.css) and the mat border instead of
  // a room row's separate row-plus-card inset.
  const thumbPx = ultraNarrow ? centreUltraThumbWidth(geom.width, MAT_PAD) : thumbWidth(geom.width);
  // The distill toggle as FRACTIONS of the thumbnail, not pixels: the map's
  // canvas overlay (`distillIconScreenRect`) scales the icon by the tile's
  // pixels-per-cell-width over `BASE_TILE.w`, so as a share of the tile the
  // icon is a constant `iconSize / BASE_TILE`, independent of how the
  // thumbnail is sized. Percentages let the picture be sized by the grid
  // (see the center-row layout below) without a pixel rect to keep in step -
  // it anchors to the bottom right corner (style.css) at these two sizes.
  // `distillIconSize` starts at {0, 0} (0% - the button has no footprint
  // until the `<img>` reports its decoded size on load), same "read the real
  // art, don't hardcode it" reasoning as `render.ts`'s canvas draw.
  const distillW = distillIconSize.w ? `${(distillIconSize.w / BASE_TILE.w) * 100}%` : '0';
  const distillH = distillIconSize.h ? `${(distillIconSize.h / BASE_TILE.h) * 100}%` : '0';
  // Fit the cover picture to a whole number of the shelf's own grid columns so
  // the spines above and below it share one set of column lines. Read the
  // grid's RESOLVED track sizes rather than mirroring the CSS math in JS - the
  // browser has already stretched `minmax(--shelf-col, 1fr)` to the real
  // column width, and `-1` handles the last line without JS ever counting
  // columns. Both wide and narrow use this one grid (a wide display just fits
  // more columns); only a phone (`ultraNarrow`) stacks into a single column
  // and ignores these vars. Runs pre-paint (`useLayoutEffect`) so the fitted
  // spans are in place before the row is ever shown; `centreGrid` is in the
  // deps so a title or index-line that reflows to a new height (its width
  // changes with `picCols`) settles in a second pass, and the equality guard
  // stops there.
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
    // Round the span UP, never down: the cover picture is allowed to be larger
    // than the spines beneath it, but snapping it smaller than its natural
    // width is not.
    const picCols = Math.max(1, Math.min(cols - 1, Math.ceil((thumbPx + colGap) / (colW + colGap))));
    // The picture's row span comes from its own MEASURED height (its width is
    // now `picCols` columns), not from aspect-and-border arithmetic that would
    // have to track the mat border and box-sizing by hand. It may be a pass
    // behind when `picCols` just changed - `centreGrid` in the deps settles it.
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
  const rowThumbPx = ultraNarrow ? ultraThumbWidth(geom.width, MAT_PAD) : thumbWidth(geom.width);
  // Every row grows together when a search starts, because every row gains the
  // same one-line score strip - so the rows stay uniform and the spacers stay
  // exact, which is the property the sliding window rests on.
  //
  // The card's own inset is charged to the row rather than to the text column,
  // because the thumbnail floats INSIDE the card: the padding wraps the image
  // and the text alike, so both of `rowHeight`'s two columns pay it once.
  const rowPx = ultraNarrow
    ? stackedRowHeight(rowThumbPx, ULTRA_HEAD_PX, ULTRA_DETAILS_PX, ROW_PAD + cardPad, MAT_PAD)
    : rowHeight(
        rowThumbPx,
        ROW_PAD + cardPad,
        TEXT_MIN + titleReserve + (result?.breakdown ? SCORE_STRIP_PX : 0),
        MAT_PAD
      );
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

  // How many lines of chips a row can show, derived from what is actually
  // left rather than a flat two-line guess - see `chipLines`/`CHIP_LINE_PX`.
  // Reserving one story line up front (rather than letting chips claim the
  // whole leftover) is what keeps a room with many keywords from squeezing
  // the story out entirely; the cap (`CHIP_LINES_MAX`/`_NARROW`) is what
  // keeps a very tall row's chip wall from growing without bound. Whatever
  // does not fit is counted and reported by the row itself (`chipOverflow`
  // in `CatalogRow`) rather than disappearing - no reserve can promise that
  // a room's keywords fit at a given width, so the row says so instead.
  const contentPx = rowPx - ROW_PAD - cardPad;
  const chips = Math.min(
    narrow ? CHIP_LINES_MAX_NARROW : CHIP_LINES_MAX,
    chipLines(
      contentPx,
      TEXT_CHROME_PX + titleReserve + (result?.breakdown ? SCORE_STRIP_PX : 0) + STORY_LINE_PX,
      CHIP_LINE_PX
    )
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
  // Deliberately keyed on `spotlightId` alone: everything else this reads
  // (`order`, `paging`, `rowPx`, ...) is read at the moment the trigger fires,
  // not re-applied if one of them changes afterwards - this is a jump, not a
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

  // Spacers stand in for pages the reader can SCROLL to. Paginated, there is
  // nowhere to scroll - the other pages are behind a button - so standing in
  // for them leaves a screenful of nothing between the last row and the pager.
  const scrolls = paging !== 'pages';
  const above = scrolls ? spacerHeight(0, first - 1, total, perPage, rowPx) : 0;
  const below = scrolls ? spacerHeight(last + 1, pages - 1, total, perPage, rowPx) : 0;

  return (
    <div
      className={`catalog${narrow ? ' narrow' : ''}${ultraNarrow ? ' ultra-narrow' : ''}${leaving ? ' leaving' : ''}`}
      ref={hostRef}
      style={{
        '--catalog-thumb': `${thumbPx}px`,
        '--catalog-row-thumb': `${rowThumbPx}px`,
        '--catalog-mat': `${MAT_PAD}px`,
        '--catalog-row': `${rowPx}px`,
        '--catalog-chips-max': `${chips * CHIP_LINE_PX}px`,
        '--catalog-ultra-head': `${ULTRA_HEAD_PX}px`,
        '--catalog-ultra-details': `${ULTRA_DETAILS_PX}px`,
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
            mutually exclusive orderings of the same list, one of which is the
            default, which is exactly what a select says natively - and unlike
            paging, a reader is choosing WHAT they are looking at rather than
            how it advances. Shown regardless of `favorites` - 'random' needs
            no favorite data, only the 'mine'/'count' options do.

            Sorting is a re-rank, not a search: it moves rooms within the
            ranking already in force (see `favoriteOrder`), so a term stays
            searched and the row a room sits in stays the row the map would
            fly to. Picking 'random' while a search is running clears it
            first (`main.tsx`'s `changeSort`) - reshuffling underneath a
            search's own order would otherwise look like the sort did nothing.
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
        <ul className="catalog-list">
          {/*
            Row 0 is the center room, and its right-hand column is the shelf -
            the same forty slots `assignTitles` returns, as ordinary links. This
            is the one view where the whole wall is legible at once, and it is
            the same `onBook` a painted spine runs, so there is no second idea
            of what a book does.
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
                positioned here with plain pixels rather than per-frame
                imperative style writes, since this thumbnail is a fixed size
                and never moves.
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

  // What the row could not show, measured after layout and again whenever the
  // row changes shape. Two answers from one pass, because they are the same
  // question asked of two boxes: the CARD is what cuts the story (which is
  // unclamped, so that it can flow around the floated tile), and the chips box
  // is what cuts the keywords.
  //
  // Both affordances this drives are absolutely positioned, which is what keeps
  // this from feeding back into itself - a "read the rest" or a "+2" that took
  // part in the flow would change the very heights being measured here.
  //
  // Ultra-narrow renders neither the story nor the chips at all - see
  // `RoomDetails` below - so there is nothing here to measure. Both flags
  // still have to be reset rather than just skipped: a row that was clipped
  // in the floated shape and then resizes into this one keeps whatever
  // state that last measurement left behind otherwise, and the fade this
  // drives (`.catalog-body.clipped::after`) would go on covering a button
  // that has nothing to do with a story that no longer renders here.
  useLayoutEffect(() => {
    if (ultraNarrow) {
      setClipped(false);
      setHiddenChips(0);
      return;
    }
    const card = cardRef.current;
    if (!card) return;
    const measure = () => {
      // NOT `scrollHeight > clientHeight`: the card contains the floated tile,
      // and a float plus its margin counts toward `scrollHeight` even when it
      // sits comfortably inside the card - which offered "read the rest" on
      // rows whose story had already finished, on every wide row. What is
      // asked instead is the real question: does any of the text run past the
      // edge the card clips at? The float itself and the absolutely
      // positioned affordances are skipped - neither is text that can be cut.
      const cardBox = card.getBoundingClientRect();
      const visibleBottom = cardBox.bottom - (parseFloat(getComputedStyle(card).borderBottomWidth) || 0);
      let contentBottom = 0;
      for (const child of card.children) {
        if (child.classList.contains('catalog-tile-button')) continue;
        if (child.classList.contains('catalog-more')) continue;
        contentBottom = Math.max(contentBottom, child.getBoundingClientRect().bottom);
      }
      setClipped(contentBottom > visibleBottom + 1);

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
        <span className="catalog-title">{roomTitle(entry, id)}</span>
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
        In the head, NOT inside `RoomDetails` where the card and the
        overlay put it. A row is a fixed height - that is what lets the
        spacers standing in for unmounted pages be arithmetic - so a
        control added to the text column would have to be reserved for in
        `TEXT_MIN`/`TEXT_CHROME_PX` and would eat two lines of story on
        every row to do it. In the head it costs width on a line that
        already exists.
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
            No width left to show the tile beside anything - see
            `ULTRA_NARROW_PX`. The name row comes FIRST and full width (unlike
            the floated-tile shape below, where the head sits beside the
            picture), the picture runs the row's own width beneath it, and the
            keywords/story that `RoomDetails` would otherwise show are not
            rendered at all - a link into the same room overlay every other
            "read more" affordance here already opens (`onExpand`) stands in
            for them, since there is nothing left to fit them beside.
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
              The tile is a button, because pressing it does something - it
              opens the room at whatever size the display allows. A bare
              `<img>` with a click handler is not reachable by keyboard and
              announces as an image, not as a control.

              It sits INSIDE the card and floats, so the story wraps beside it
              and then runs the card's full width once past its bottom edge.
              The height a row does not spend on the picture is the story's,
              rather than dark background under a small thumbnail - which is
              what a phone's row is mostly made of otherwise. The center room
              gets the same effect a different way: its picture is a grid item
              spanning several columns and rows of the shelf's own column grid,
              so the spines flow beside it and then beneath it, aligned to one
              set of columns (see `.catalog-center` in style.css). It uses a
              grid rather than this float because the spines have to LINE UP
              above and below the picture, which a float's two independent runs
              cannot promise.
            */}
            {tile}

            {/*
              The room's identity on the left, the way out to the map on the
              right of the SAME row. It used to sit under the chips, which put
              a link and a row of tags within a thumb's width of each other -
              on a phone that is a coin toss between running a search and
              flying the camera.
            */}
            {head}

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
              chipOverflow={
                hiddenChips > 0 ? { count: hiddenChips, onClick: () => onExpand(id, rank) } : null
              }
            />

            {clipped && (
              <button className="catalog-more" onClick={() => onExpand(id, rank)}>
                read the rest →
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}
