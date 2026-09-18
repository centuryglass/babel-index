/**
 * One room (or generic cell), as large as the display allows: the tile at
 * full size and the whole story, with nothing clipped.
 *
 * A full-page modal - scrim, centered dialog, Escape and a backdrop click
 * both close it, Tab trapped inside while it is open - reached from either
 * side of the app: right-click, long press or Enter on the map, choosing a
 * ranked result, or expanding a catalog row. A map pick can name a generic
 * cell and a catalog row never does; that difference is the one
 * conditional `'generic' in room`.
 *
 * The catalog needs this modal because its rows are a fixed height - a row
 * cannot grow to fit a long story, and growing it in place would turn the
 * spacer arithmetic into estimates (AGENTS.md's "A fixed row cannot show
 * everything, so the overlay is not optional"). The map path needs it
 * because its tile is canvas-painted: here the tile is a real `<img>` at
 * its own native resolution, and a right-click on it reaches the browser's
 * "save image", which the map cannot offer.
 *
 * Tile and story scroll as one region (`.overlay` itself, not a split
 * pane), so a long story and a native-resolution picture share the space -
 * the same tile-then-text order the catalog's rows show before anything is
 * expanded. The pair moves into two columns only when stacking them would
 * make the dialog scroll, and once split, the story is grown to fill the
 * tile's height. `decideColumns` and `measureScale` are those two
 * decisions, measured rather than guessed; their own comments carry the
 * mechanics.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useContentZoom } from '../hooks/useContentZoom.ts';
import { useScrimDismiss } from '../hooks/useDialog.ts';
import { ZoomControls } from './ZoomControls.tsx';
import { RoomDetails, FavoriteToggle, Highlight, type FavoriteControl } from './RoomDetails.tsx';
import { roomTitle, type RoomMeta } from '../../../map/metadata.ts';
import { BASE_TILE } from '../lib/pyramid.ts';
import type { Description } from '../../../map/describe.ts';
import type { SearchResult, MatchRange } from '../../../map/searchResult.ts';
import type { Config } from '../../../config/config.ts';

/**
 * Which room (or generic cell) this names. A map pick (`RoomPick`) carries
 * `x`/`y` too, and a catalog row's `{id, rank}` doesn't - neither field is
 * read here, so both shapes satisfy this without either caller padding out
 * the other's.
 */
type RoomSubject = { id: number; rank?: number } | { generic: true };

/**
 * The permalink itself - relative `catalog/<file>` resolved against
 * `document.baseURI`, the same `<base href>` every other relative fetch in
 * this app resolves against (see AGENTS.md's "Deployment and the base
 * path"), so the copied link is correct under a subpath deployment without
 * this file knowing what that prefix is. `encodeURIComponent` matches
 * `app.ts`'s own `canonicalPath` for this same route.
 */
function buildShareUrl(file: string): string {
  return new URL(`catalog/${encodeURIComponent(file)}`, document.baseURI).href;
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
      <polyline
        points="15 14 19 10 15 6"
        fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
      />
      <path
        d="M20 10H9a4 4 0 0 0-4 4v6"
        fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
      <polyline
        points="4 12 9 17 20 6"
        fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The room permalink, copied to the clipboard rather than navigated to -
 * this dialog is already the destination. Pinned over the page's own
 * corner (see style.css's `.share-button`) rather than a third row in the
 * head, which already carries the favorite toggle, the other reading's
 * link, zoom controls and close.
 *
 * `copied`'s feedback swaps both the icon and the label, not just the
 * label - the label alone disappears at a narrow width (`.share-button-full`
 * in style.css), and a reader relying on the icon still needs to see the
 * press land. `aria-label`/`title` carry the same words regardless of which
 * is visible, so the accessible name never depends on layout.
 */
function ShareButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
  }, []);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // No clipboard permission, or a non-secure context - the browser's own
      // prompt still lets the reader select and copy it by hand.
      window.prompt('Copy this link:', url);
      return;
    }
    setCopied(true);
    if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const label = copied ? 'link copied' : 'copy link to this room';
  return (
    <button
      type="button"
      className={copied ? 'share-button copied' : 'share-button'}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {copied ? <CheckIcon /> : <ShareIcon />}
      <span className="share-button-full" aria-hidden="true">{copied ? 'Copied!' : 'Share'}</span>
    </button>
  );
}

export function RoomOverlay({
  room,
  desc,
  entry,
  src,
  onClose,
  onKeyword,
  highlight,
  tagLinks,
  result,
  weights,
  favorite = null,
  view = null,
  naturalSize = null,
  shareFile = null,
}: {
  room: RoomSubject;
  desc: Description;
  entry: RoomMeta | null;
  /** this room's (or generic cell's) tile - null while the manifest can't resolve one */
  src?: string | null;
  /**
   * The tile's own real pixel dimensions, read at scan time (`scan.ts`'s
   * `imageSize`) - null when the manifest never got a reading (a corpus
   * with an unrecognized image format) or the caller hasn't looked it up,
   * in which case the placeholder falls back to `BASE_TILE`'s shared
   * aspect (see `tileSize` below).
   */
  naturalSize?: { w: number; h: number } | null;
  onClose: () => void;
  onKeyword: (keyword: string) => void;
  highlight?: {
    keyword: (text: string) => MatchRange[];
    title: (text: string) => MatchRange[];
    story: (text: string) => MatchRange[];
  } | null;
  tagLinks?: Record<string, string> | null;
  result?: SearchResult | null;
  weights?: Config['search']['weights'] | null;
  /** this room's favorite state, rendered here rather than left to `RoomDetails` -
   * see `view` below for why */
  favorite?: FavoriteControl | null;
  /**
   * The other reading's own way to reach this same room - "show on the map"
   * from a catalog row's overlay, "show in the catalog" from a map card's -
   * or `null` for a room past the map's slider (no cell to fly to) or a
   * generic cell (in neither reading's list). Rendered beside the favorite
   * toggle rather than inside `RoomDetails`, which has no notion of which
   * reading opened it. `shortLabel` is the abbreviated form style.css swaps
   * in on a narrow display (`.room-head .catalog-show-full/short`); `label`
   * stays the accessible name.
   */
  view?: { label: string; shortLabel: string; onClick: () => void } | null;
  /**
   * This room's filename, for the copy-link button - `null` for a generic
   * cell, which has no permalink (`/catalog/:file` only exists for a real
   * corpus room). The url itself is built from it in `buildShareUrl` rather
   * than passed in whole, so every caller states the one fact it actually
   * knows (which room) instead of each re-deriving the same `catalog/...`
   * path.
   */
  shareFile?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Focus moves in on open and back out on close.
  //
  // The restore is conditional: focus is returned only if it is still
  // inside the dialog or has fallen to the body, because those are the
  // cases where nobody else has claimed it. Two ways it can be claimed:
  // the dialog is dismissed by a click elsewhere, and that click has
  // usually already put focus somewhere the reader chose - stealing it
  // back would undo their own action. Or it is closed because the map is
  // about to rearrange under it (`searchKeyword`), by which point the
  // element that opened it may be gone.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      // The body is not somewhere focus can be "put back" - it is where
      // focus already is when nothing holds it, the ordinary case for a
      // dialog opened by right-clicking the canvas. Nothing to restore.
      if (!opener || opener === document.body || !opener.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !ref.current?.contains(active)) return;
      opener.focus();
    };
    // Mount and unmount only: re-running this on a re-render would drag
    // focus back to the dialog while someone is reading a chip inside it.
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // A dialog over the map or a scrolling list has to hold focus, or Tab
      // walks into whatever is behind the scrim.
      if (e.key !== 'Tab') return;
      const focusable = ref.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const scrimRef = useRef<HTMLDivElement>(null);
  const scrimDismiss = useScrimDismiss(onClose);
  const colsRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(false);

  // See useContentZoom.ts: the tile-and-story pair gets one scoped
  // pinch-to-zoom rather than the browser's page zoom, so `src` (a new
  // tile) is what resets it, not the dialog closing - the same overlay
  // instance can show a different room without unmounting.
  // Viewport = `.overlay` itself (`ref`, already the scroll region for
  // this dialog); content = `.overlay-columns` below, so a pinch magnifies
  // the tile and the text together.
  const contentZoom = useContentZoom(ref, src);
  // A fresh inline arrow function every render would make React tear down
  // and rebuild `contentZoom.ref` - and with it `useContentZoom`'s
  // pointer-tracking effect and its gesture state - on every re-render,
  // including the ones a drag itself triggers via `setCamera`, which would
  // reset mid-gesture. Memoized so its identity only changes if
  // `contentZoom.ref` does; the hook's own `ref` is stable across renders.
  const colsAndZoomRef = useCallback(
    (el: HTMLDivElement | null) => {
      colsRef.current = el;
      contentZoom.ref(el);
    },
    [contentZoom.ref]
  );

  // Whether the tile and text sit in two columns instead of one -
  // `decideColumns` measures it. `columns` on `.overlay-columns` is what
  // actually switches the CSS to a row; toggling it off on the element
  // being measured is what makes `scrollHeight` answer "how tall would
  // this be stacked", regardless of which layout is live right now.
  const decideColumns = useRef(() => {});
  decideColumns.current = () => {
    const scrim = scrimRef.current;
    const overlayEl = ref.current;
    const cols = colsRef.current;
    if (!scrim || !overlayEl || !cols) return;

    const scrimStyle = getComputedStyle(scrim);
    const verticalPadding = parseFloat(scrimStyle.paddingTop) + parseFloat(scrimStyle.paddingBottom);
    // A couple of pixels of slack against subpixel layout rounding: without
    // it, a binary-searched scale that lands on the limit can still trip the
    // scrollbar it was meant to avoid.
    const availableHeight = scrim.clientHeight - verticalPadding - 2;

    // The comparison is against the whole dialog's height, not just the
    // tile-and-text pair - the card head above it takes space too, and a
    // pair that would barely fit on its own can still leave the dialog as a
    // whole needing to scroll.
    const wasColumns = cols.classList.contains('columns');
    cols.classList.remove('columns');
    const neededHeight = overlayEl.scrollHeight;
    if (wasColumns) cols.classList.add('columns');

    // Below this, a second column would be squeezed thinner than the tile is
    // tall enough to be worth reading beside - a feasibility floor, not a
    // tuned layout threshold: "does a text column plus a gap plausibly fit
    // at all".
    const MIN_COLUMNS_WIDTH = 900;
    setColumns(neededHeight > availableHeight && scrim.clientWidth >= MIN_COLUMNS_WIDTH);
  };

  // Split view only: the text page is stretched to the tile's height, so the
  // story usually has slack under it. Binary search the largest
  // `--split-text-scale` (read by the font-size rules scoped to
  // `.overlay-columns.columns .overlay-body`) that still keeps the whole dialog
  // within the room the scrim has - stop scaling where growing the text any
  // further would force a scroll, never before. The keyword chips are held
  // out of the scale: widening every pill pushes a set that fit on one line
  // onto two, and a single row of tags reads better, so only the story and
  // score grow. A generic cell, whose short caption cannot fill a tall tile
  // even at `MAX_SCALE`, leaves a mostly-empty page rather than being blown
  // up to an absurd size.
  //
  // This runs as its own effect, keyed off `columns` rather than folded into
  // `decideColumns` - `.overlay`'s own `columns` class (which is what makes
  // it `width: fit-content` instead of a fixed size) is set by React from
  // state, not by `decideColumns`, so reading widths immediately after a
  // `setColumns(true)` call can still see the old, narrower width React has
  // not repainted yet. Keying this effect on `columns` guarantees it only
  // runs once that class has landed - React re-renders synchronously off a
  // layout effect's own `setState`, so by this effect's turn the DOM already
  // reflects the true split-view width.
  const measureScale = useRef(() => {});
  measureScale.current = () => {
    const scrim = scrimRef.current;
    const overlayEl = ref.current;
    const cols = colsRef.current;
    if (!scrim || !overlayEl || !cols || !cols.classList.contains('columns')) return;

    const scrimStyle = getComputedStyle(scrim);
    const verticalPadding = parseFloat(scrimStyle.paddingTop) + parseFloat(scrimStyle.paddingBottom);
    const availableHeight = scrim.clientHeight - verticalPadding - 2;

    const MAX_SCALE = 2;
    let lo = 1;
    let hi = MAX_SCALE;
    cols.style.setProperty('--split-text-scale', String(hi));
    if (overlayEl.scrollHeight > availableHeight) {
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        cols.style.setProperty('--split-text-scale', String(mid));
        if (overlayEl.scrollHeight <= availableHeight) lo = mid;
        else hi = mid;
      }
      cols.style.setProperty('--split-text-scale', String(lo));
    }
  };

  useLayoutEffect(() => {
    decideColumns.current();
    const onResize = () => decideColumns.current();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // Re-measure whenever the room being shown changes - the tile and the
    // story it's paired with are both new, and their combined height with it.
  }, [desc, entry, src]);

  useLayoutEffect(() => {
    measureScale.current();
    if (!columns) return;
    const onResize = () => measureScale.current();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [columns, desc, entry, src]);

  const tileSize = naturalSize ?? BASE_TILE;

  // The dialog's accessible name is `desc.name` - the same string the map's
  // own cursor says for this cell. The rank and the keywords are the reason
  // to have opened it.
  return (
    <div
      className="overlay-scrim"
      ref={scrimRef}
      {...scrimDismiss}
    >
      <div
        className={columns ? 'overlay columns' : 'overlay'}
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={desc.name}
      >
        {/*
          The favorite toggle and the other reading's link sit in the head
          itself rather than each on a row of their own - the head has the
          horizontal room to spare. The star tucks in right after the name;
          the link and the close button group at the far right
          (`.room-head-end` takes the row's slack), so the free space falls
          between the two groups. `RoomDetails` renders neither (see
          `favorite={null}` below).
        */}
        <div className="card-head room-head">
          <div className="room-id">
            <span className="card-id">
              {'generic' in room ? (
                'a Babel shelf'
              ) : (
                // The visible id leads with the title (`roomTitle` falls
                // back to "Room N" for a room the corpus has not
                // retitled). Highlighted like the catalog row's title -
                // only the corpus's real title, never that fallback, which
                // scored no title match to mark.
                <b>
                  <Highlight
                    text={roomTitle(entry, room.id)}
                    ranges={entry?.title ? highlight?.title(entry.title) : null}
                  />
                </b>
              )}
            </span>
            {favorite && <FavoriteToggle favorite={favorite} />}
          </div>
          <div className="room-head-end">
            {view && (
              <button type="button" className="catalog-show" onClick={view.onClick} aria-label={view.label}>
                <span className="catalog-show-full">{view.label}</span>
                <span className="catalog-show-short" aria-hidden="true">{view.shortLabel}</span>
              </button>
            )}
            <ZoomControls
              zoomIn={contentZoom.zoomIn}
              zoomOut={contentZoom.zoomOut}
              resetZoom={contentZoom.resetZoom}
              canZoomIn={contentZoom.canZoomIn}
              canZoomOut={contentZoom.canZoomOut}
            />
            <button className="card-close" onClick={onClose} aria-label="close">
              ×
            </button>
          </div>
        </div>

        {/*
          Two columns only when one would overflow - see `decideColumns`.
          A short story stays under the tile; only one tall enough to force
          scrolling moves beside it, and only when the dialog is wide enough
          for that to be worth doing.
        */}
        <div
          className={[
            columns ? 'overlay-columns columns' : 'overlay-columns',
            'zoom-scope',
            contentZoom.zoomed ? 'zoomed' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          ref={colsAndZoomRef}
          style={contentZoom.style}
        >
          {/*
            The tile at its own native resolution, never upscaled - the
            same rule the map's opening view follows - and a right-click
            here reaches the browser's own "save image", which a
            canvas-painted map tile cannot offer. `alt` is `desc.picture`:
            for a real room, the sidecar's optional caption, empty when the
            corpus does not carry one; for a generic cell, the one fixed
            sentence every generic tile shares (`describe.ts`'s generic
            branch).

            Intrinsic size from the tile's own reading if the manifest has
            one, else `BASE_TILE`'s shared aspect (`tileSize`) - so the
            picture reserves a box matching what will actually load, not
            just its proportions. The CSS still scales it down to fit a
            narrower dialog (`height: auto`, `max-width: 100%`; see
            `.overlay-tile`'s comment in style.css for why there is no
            `width` rule alongside them).

            `onLoad` re-measures once the browser knows the tile's real
            height: before that an unloaded `<img>` has none, and a
            measurement against zero would never decide to overflow. Both
            calls, in this order: `decideColumns` may flip `columns`, in
            which case its own effect re-measures the scale once React has
            applied the class; if `columns` was already true, that effect
            will not fire again on its own, so the direct `measureScale`
            call here is what picks up the tile's real height.
          */}
          {src && (
            <img
              className="overlay-tile"
              src={src}
              alt={desc.picture ?? ''}
              decoding="async"
              width={tileSize.w}
              height={tileSize.h}
              onLoad={() => {
                decideColumns.current();
                measureScale.current();
              }}
            />
          )}

          <div className="overlay-body paper-sheet">
            <RoomDetails
              entry={entry}
              desc={desc}
              onKeyword={onKeyword}
              highlight={highlight}
              tagLinks={tagLinks}
              rank={'generic' in room ? undefined : room.rank}
              result={result}
              weights={weights}
              favorite={null}
            />
          </div>

          {shareFile && <ShareButton url={buildShareUrl(shareFile)} />}
        </div>
      </div>
    </div>
  );
}
