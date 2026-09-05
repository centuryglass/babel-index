/**
 * One room (or generic cell), as large as the display allows: the tile at
 * full size and the whole story, with nothing clipped.
 *
 * A full-page modal - a scrim, a centered dialog, Escape and a backdrop click
 * both close it, Tab trapped inside while it is open - reached from either
 * side of the app: right-click, long press or Enter on the map, choosing a
 * result from the ranked listbox, or expanding a catalog row. All of those
 * used to reach two different components (`RoomCard` for the map paths, this
 * one for the catalog's), anchored and styled differently, but a comparison
 * once RoomCard also became a modal turned up no remaining reason for the
 * split - same dialog chrome, same focus/Tab/Escape handling, same
 * `RoomDetails` body. The one real difference, that a map pick can name a
 * generic cell and a catalog row never does, is a three-line conditional
 * (`'generic' in room`), not a reason for a second file.
 *
 * The catalog row's own reason for a modal at all still holds: its rows are a
 * fixed height (what lets the spacers standing in for unmounted pages be
 * arithmetic rather than estimates), so a row cannot grow to fit a long story
 * and the thumbnail in it is a thumbnail. Pressing the tile opens it, and so
 * does the "read the rest" button a clipped story ends with - the alternative
 * was expanding the story in place, which would make row heights vary. The
 * trade is deliberate: rows stay uniform, and the full thing is one press
 * away rather than zero.
 *
 * The tile is sized to its own native resolution by default - `max-width:
 * 100%; width: auto` on `.overlay-tile` never blows it up past that, only
 * shrinking it to fit a narrower dialog - and a right-click on it reaches the
 * browser's own "save image", which a canvas-painted map tile could never
 * offer. It scrolls as part of the same region as the text below it
 * (`.overlay` itself, not a split pane): a long story and a native-resolution
 * picture compete for the same space rather than each getting a fixed share,
 * which is the plain, unsurprising behavior the catalog's own tile-then-text
 * rows already give a reader before anything is expanded.
 *
 * The tile-and-text pair only moves into two columns when stacking them
 * would make the dialog scroll - a short story stays under the tile exactly
 * as it always has, because there's nothing wrong with that layout when it
 * fits. `decideColumns` below answers that by measuring, not guessing: force
 * the pair back to a single block column, read its natural height, and
 * compare against the room the scrim actually has (its own height minus
 * padding, read live off the scrim rather than assumed). Only when that
 * natural height would overflow, and the dialog is wide enough for a second
 * column to be worth it, does `.overlay-columns` get the class that turns it
 * into a row.
 *
 * Once it has, the tile is usually the taller of the two - the text was
 * only ever sized to fit under it, not beside it, so there's slack even for
 * a long story. `measureScale` spends that slack on size rather than
 * whitespace: it binary-searches `--split-text-scale` up from 1 until
 * growing the text any further would force the dialog to scroll, and stops
 * exactly there. Scoped to the split view alone (`.overlay-columns.columns
 * .overlay-body`'s font-size rules) - the stacked layout, the card, and the
 * catalog row all read `.story`/`.chip`/`.score` at their ordinary size.
 * It runs as its own effect, keyed off the `columns` state rather than
 * folded into the same pass as `decideColumns` - see that effect's own
 * comment for why the ordering matters.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RoomDetails, FavoriteToggle, type FavoriteControl } from './RoomDetails.tsx';
import { roomTitle, type RoomMeta } from '../../../map/metadata.ts';
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
}: {
  room: RoomSubject;
  desc: Description;
  entry: RoomMeta | null;
  /** this room's (or generic cell's) tile - null while the manifest can't resolve one */
  src?: string | null;
  onClose: () => void;
  onKeyword: (keyword: string) => void;
  highlight?: { keyword: (text: string) => MatchRange[]; story: (text: string) => MatchRange[] } | null;
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
   * reading opened it.
   */
  view?: { label: string; onClick: () => void } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Focus moves in on open and goes back where it came from on close.
  //
  // The restore is conditional rather than unconditional for two reasons. The
  // dialog is dismissed by clicking *anywhere else*, and that click has
  // usually already put focus somewhere the reader chose - stealing it back
  // would undo their own action. And it may be closed because the map is
  // about to rearrange under it (`searchKeyword`), by which point the element
  // that opened it may be gone. So: restore only if focus is still inside the
  // dialog or has fallen to the body, which are exactly the cases where
  // nobody else has claimed it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      // The body is not somewhere focus can be "put back" - it is where focus
      // already is when nothing holds it, which is the ordinary case for a
      // dialog opened by right-clicking the canvas. Nothing to restore.
      if (!opener || opener === document.body || !opener.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !ref.current?.contains(active)) return;
      opener.focus();
    };
    // Mount and unmount only: re-running this on a re-render would drag focus
    // back to the dialog while someone is reading a chip inside it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const colsRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(false);

  // Whether the tile and text sit in two columns instead of one - see the
  // file doc comment. `columns` on `.overlay-columns` is what actually
  // switches the CSS to a row; toggling it off on the element being measured
  // is what makes `scrollHeight` answer "how tall would this be stacked",
  // regardless of which layout is live right now.
  const decideColumns = useRef(() => {});
  decideColumns.current = () => {
    const scrim = scrimRef.current;
    const overlayEl = ref.current;
    const cols = colsRef.current;
    if (!scrim || !overlayEl || !cols) return;

    const scrimStyle = getComputedStyle(scrim);
    const verticalPadding = parseFloat(scrimStyle.paddingTop) + parseFloat(scrimStyle.paddingBottom);
    // A couple of pixels of slack against subpixel layout rounding - without
    // it, a binary-searched scale that lands exactly on the limit can still
    // trip the scrollbar it was meant to avoid.
    const availableHeight = scrim.clientHeight - verticalPadding - 2;

    // The comparison is against the WHOLE dialog's height, not just the
    // tile-and-text pair - the head and the actions row above it take space
    // too, and a pair that would juuust fit on its own can still leave the
    // dialog as a whole needing to scroll.
    const wasColumns = cols.classList.contains('columns');
    cols.classList.remove('columns');
    const neededHeight = overlayEl.scrollHeight;
    if (wasColumns) cols.classList.add('columns');

    // Below this, a second column would be squeezed thinner than the tile
    // is tall enough to be worth reading beside - not a tuned constant,
    // just "does a text column plus a gap plausibly fit at all".
    const MIN_COLUMNS_WIDTH = 900;
    setColumns(neededHeight > availableHeight && scrim.clientWidth >= MIN_COLUMNS_WIDTH);
  };

  // Split view only: the tile is usually the taller of the pair, which
  // leaves the text sized for a stacked column it's no longer in. Binary
  // search the largest `--split-text-scale` (read by the font-size rules
  // scoped to `.overlay-columns.columns .overlay-body`) that still keeps the
  // whole dialog within the room the scrim has - stop scaling exactly where
  // growing the text any further would force a scroll, never before.
  //
  // This has to run as ITS OWN effect, keyed off `columns` rather than
  // folded into `decideColumns` above - `.overlay`'s own `columns` class
  // (which is what makes it `width: fit-content` instead of a fixed size)
  // is set by React from state, not by this function, so reading widths
  // here immediately after calling `setColumns(true)` can still see the
  // OLD, narrower width React hasn't repainted yet. Keying this effect on
  // `columns` guarantees it only ever runs once that class has actually
  // landed - React re-renders synchronously off a layout effect's own
  // `setState`, so by the time this effect's turn comes the DOM already
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

  // Named by `desc.name` - the same string a listbox option and the map's own
  // cursor say for this cell. The rank and the keywords are the reason to
  // have opened it.
  //
  // The visible id, unlike `desc.name`, leads with the title (`roomTitle`
  // falls back to "Room {id}" for a room the corpus hasn't retitled). The
  // filename used to trail it, but a reader who cares about "001.jpg" can
  // already get to it by right-clicking the tile and saving it - showing it
  // to everyone else was cosmetic clutter with no upside.
  return (
    <div
      className="overlay-scrim"
      ref={scrimRef}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={columns ? 'overlay columns' : 'overlay'}
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={desc.name}
      >
        <div className="card-head">
          <span className="card-id">
            {'generic' in room ? 'a Babel shelf' : <b>{roomTitle(entry, room.id)}</b>}
          </span>
          <button className="card-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>

        {/*
          The favorite toggle and the other reading's link, one row, the link
          right-aligned - the same pairing a catalog row makes in its head for
          the same reason: two ways of *acting* on this room belong beside its
          name, not folded into `RoomDetails`'s body alongside its chips and
          story. `RoomDetails` renders neither (see `favorite={null}` below).
        */}
        {(favorite || view) && (
          <div className="overlay-actions">
            {favorite && <FavoriteToggle favorite={favorite} />}
            {view && (
              <button type="button" className="catalog-show" onClick={view.onClick}>
                {view.label}
              </button>
            )}
          </div>
        )}

        {/*
          Two columns only when one would overflow - see `measureColumns`
          above. A short story stays under the tile exactly as it always has;
          only a story tall enough to force scrolling moves beside it, and
          only when the dialog is wide enough for that to be worth doing.
        */}
        <div className={columns ? 'overlay-columns columns' : 'overlay-columns'} ref={colsRef}>
          {/*
            The tile at its own native resolution by default, never upscaled
            past it - the same rule the map's opening view follows - and a
            right-click here reaches the browser's own "save image", which a
            canvas-painted map tile could never offer. `alt` is `desc.picture` -
            for a real room, the sidecar's optional caption, empty when the
            corpus does not carry one; for a generic cell, the one fixed
            sentence every generic tile shares (`describe.ts`'s generic
            branch) - the only case where this file invents a caption rather
            than reading one.

            `onLoad` re-measures once the browser knows the tile's real
            height - before that, an unloaded `<img>` has none, and a
            measurement taken against zero would never decide to overflow.
            Both calls, in this order: `decideColumns` may flip `columns`,
            in which case its own effect above re-measures the scale once
            React has actually applied the class; if `columns` was already
            true, that effect won't fire again on its own, so the direct
            `measureScale` call here is what picks up the tile's real
            (rather than zero) height in that case.
          */}
          {src && (
            <img
              className="overlay-tile"
              src={src}
              alt={desc.picture ?? ''}
              decoding="async"
              onLoad={() => {
                decideColumns.current();
                measureScale.current();
              }}
            />
          )}

          <div className="overlay-body">
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
        </div>
      </div>
    </div>
  );
}
