/**
 * One room (or generic cell), as large as the display allows: the tile at
 * full size and the whole story, with nothing clipped.
 *
 * A full-page modal: scrim, centered dialog, Escape and a backdrop click
 * close it, and Tab is trapped inside. Reached from right-click, long press
 * or Enter on the map, a ranked result, or expanding a catalog row. Only a
 * map pick can name a generic cell (`'generic' in room`).
 *
 * The catalog needs it because its rows are a fixed height
 * (docs/agents/catalog.md, "A fixed row cannot show everything, so the
 * overlay is not optional"). On the map it shows the tile as a real `<img>`
 * at native resolution, so a right-click reaches the browser's "save image".
 *
 * Tile and story scroll as one region (`.overlay`), tile first. The pair
 * moves into two columns only when stacking them would make the dialog
 * scroll, and once split the story grows to fill the tile's height;
 * `decideColumns` and `measureScale` make those two decisions.
 *
 * The focus, Escape and Tab-trap effects are an inline copy of `useDialog`'s,
 * bound to `window` outside its topmost-only stack. They are correct only
 * while no other dialog can open over this one, or one Escape closes both.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useContentZoom } from '../hooks/useContentZoom.ts';
import { useScrimDismiss } from '../hooks/useDialog.ts';
import { ZoomControls } from './ZoomControls.tsx';
import { RoomDetails, FavoriteToggle, Highlight, type FavoriteControl } from './RoomDetails.tsx';
import { roomTitle, type RoomMeta } from '../../../map/metadata.ts';
import { roomPath } from '../../../map/slug.ts';
import { BASE_TILE } from '../lib/pyramid.ts';
import type { Description } from '../../../map/describe.ts';
import type { SearchResult, MatchRange } from '../../../map/searchResult.ts';
import type { Config } from '../../../config/config.ts';

/**
 * Which room (or generic cell) this names. A map pick (`RoomPick`) also
 * carries `x`/`y`, which this file does not read.
 */
type RoomSubject = { id: number; rank?: number } | { generic: true };

/**
 * The permalink: `roomPath`'s relative url resolved against
 * `document.baseURI`, so it is correct under a subpath deployment
 * (docs/agents/deploy.md, "Deployment and the base path").
 *
 * `mode` names which reading the link reopens into.
 */
function buildShareUrl(slug: string, mode: 'catalog' | 'map'): string {
  return new URL(roomPath(slug, mode), document.baseURI).href;
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
 * Copies the room permalink to the clipboard. Pinned over the page's corner
 * (style.css's `.share-button`).
 *
 * `copied` swaps the icon as well as the label, because the label is hidden
 * at a narrow width (`.share-button-full` in style.css). `aria-label`/`title`
 * carry the same words either way, so the accessible name never depends on
 * layout.
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
  shareSlug = null,
  shareMode = 'catalog',
}: {
  room: RoomSubject;
  desc: Description;
  entry: RoomMeta | null;
  /** this room's (or generic cell's) tile - null while the manifest can't resolve one */
  src?: string | null;
  /**
   * The tile's pixel dimensions, read at scan time (`scan.ts`'s
   * `imageSize`). Null when there is no reading, and the placeholder falls
   * back to `BASE_TILE` (see `tileSize`).
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
  /** this room's favorite state, rendered in the head beside `view` */
  favorite?: FavoriteControl | null;
  /**
   * The other reading's link to this room: "show on the map" from the
   * catalog, "show in the catalog" from the map. `null` for a room past the
   * map's slider (no cell to fly to) or a generic cell. `shortLabel` is what
   * style.css swaps in on a narrow display
   * (`.room-head .catalog-show-full/short`); `label` stays the accessible
   * name.
   */
  view?: { label: string; shortLabel: string; onClick: () => void } | null;
  /**
   * This room's permalink slug for the copy-link button, which
   * `buildShareUrl` turns into a url. `null` for a generic cell, which has
   * no permalink.
   */
  shareSlug?: string | null;
  /**
   * Which reading `shareSlug`'s link reopens into: the one that opened this
   * overlay. Ignored when `shareSlug` is null.
   */
  shareMode?: 'catalog' | 'map';
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Focus moves in on open and back out on close.
  //
  // Focus is restored only if it is still inside the dialog or has fallen
  // to the body. Otherwise something else claimed it: a click elsewhere
  // that dismissed the dialog, or a `searchKeyword` rearrangement that may
  // have removed the opener.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      // An opener of `body` (a right-click on the canvas) has nothing to
      // restore.
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

  // One scoped pinch-to-zoom for the tile and story together (see
  // useContentZoom.ts). The viewport is `.overlay` (`ref`) and the content
  // is `.overlay-columns`. A new `src` resets it, since the same instance
  // can show a different room without unmounting.
  const contentZoom = useContentZoom(ref, src);
  // Must stay memoized: a new callback ref identity rebuilds
  // `useContentZoom`'s pointer-tracking effect and resets its gesture state,
  // and a drag re-renders through `setCamera` mid-gesture.
  const colsAndZoomRef = useCallback(
    (el: HTMLDivElement | null) => {
      colsRef.current = el;
      contentZoom.ref(el);
    },
    [contentZoom.ref]
  );

  // Sets `columns` when the stacked layout would overflow the scrim. It
  // removes the `columns` class from `.overlay-columns` while measuring,
  // so `scrollHeight` is the stacked height whichever layout is live.
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

    // Measures the whole dialog, including the card head, not only the
    // tile-and-text pair.
    const wasColumns = cols.classList.contains('columns');
    cols.classList.remove('columns');
    const neededHeight = overlayEl.scrollHeight;
    if (wasColumns) cols.classList.add('columns');

    // A feasibility floor, not a tuned threshold: below this width a text
    // column beside the tile is too narrow to read.
    const MIN_COLUMNS_WIDTH = 900;
    setColumns(neededHeight > availableHeight && scrim.clientWidth >= MIN_COLUMNS_WIDTH);
  };

  // Split view only: binary-searches the largest `--split-text-scale` that
  // keeps the whole dialog within the scrim, capped at `MAX_SCALE`. The
  // variable is read by the font-size rules scoped to
  // `.overlay-columns.columns .overlay-body`, which grow the story and score
  // but not the keyword chips.
  //
  // Must run from its own effect keyed on `columns`, not from
  // `decideColumns`. React sets `.overlay`'s `columns` class (its
  // `width: fit-content`) from state, so a measurement right after
  // `setColumns(true)` sees the old, narrower width. The keyed effect runs
  // after that class has landed.
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
    // Re-measure whenever the room being shown changes.
  }, [desc, entry, src]);

  useLayoutEffect(() => {
    measureScale.current();
    if (!columns) return;
    const onResize = () => measureScale.current();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [columns, desc, entry, src]);

  const tileSize = naturalSize ?? BASE_TILE;

  // The dialog's accessible name is `desc.name`, the same string the map's
  // cursor says for this cell.
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
          The head: the name and favorite star on the left, the other
          reading's link, zoom and close grouped at the right
          (`.room-head-end` takes the row's slack). `RoomDetails` renders
          neither the star nor the link (`favorite={null}`).
        */}
        <div className="card-head room-head">
          <div className="room-id">
            <span className="card-id">
              {'generic' in room ? (
                'a library wall'
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
          Two columns only when one would overflow; see `decideColumns`.
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
            The tile at native resolution, never upscaled. `alt` is
            `desc.picture`: the sidecar's optional caption for a real room
            (empty when absent), or the fixed generic sentence
            (`describe.ts`'s generic branch).

            `width`/`height` come from `tileSize`, so the box matches what
            will load. The CSS scales it down to fit (`.overlay-tile` in
            style.css).

            `onLoad` re-measures, since an unloaded `<img>` has no height.
            Both calls are needed: if `decideColumns` flips `columns`, the
            keyed effect re-runs `measureScale`; if `columns` was already
            true, only the direct call picks up the real height.
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

          {shareSlug && <ShareButton url={buildShareUrl(shareSlug, shareMode)} />}
        </div>
      </div>
    </div>
  );
}
