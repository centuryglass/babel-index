/**
 * One room's tile, keywords and story, opened by right-click or long press.
 *
 * A full-page modal, the same treatment `RoomOverlay` gives a room reached
 * from the catalog - a scrim, a centered dialog, Escape and a backdrop click
 * both close it, Tab is trapped inside while it is open. It used to be a small
 * popup anchored to the gesture's screen point instead; that meant a card
 * opened near an edge could cover the very room it was describing, gave no
 * room to show the tile at any real size, and had no answer for "where does
 * a keyboard open (Enter) even put this" beyond faking a point at the canvas
 * center. A modal has no such point to need.
 *
 * The tile is sized to its own native resolution by default (`.card-tile`'s
 * `flex: 0 1 auto` - the `0` is what stops it being blown up past its own
 * pixels to fill spare room) and only shrinks when the viewport genuinely
 * cannot fit it; a right-click on it reaches the browser's own "save image",
 * which a canvas-painted tile could never offer. The image and the text below
 * it scroll independently (`.card-scroll` is its own region) so a long story
 * cannot push a native-size picture out of view, and a very tall picture
 * cannot bury the story below the fold with no way to reach it.
 *
 * The text is `RoomDetails`, which the catalog's rows and the canvas's own
 * fallback content also render - so a room reads the same however a reader
 * reached it. What is here beyond that is the dialog around it: how it opens,
 * how it is dismissed, and where focus goes.
 */
import { useEffect, useRef } from 'react';
import { RoomDetails, type FavoriteControl } from './RoomDetails.tsx';
import type { RoomPick } from '../lib/picking.ts';
import { roomTitle, type RoomMeta } from '../../../map/metadata.ts';
import type { Description } from '../../../map/describe.ts';
import type { SearchResult, MatchRange } from '../../../map/searchResult.ts';
import type { Config } from '../../../config/config.ts';

export function RoomCard({
  card,
  desc,
  entry,
  file,
  src,
  onClose,
  onKeyword,
  highlight,
  tagLinks,
  result,
  weights,
  favorite = null,
}: {
  card: RoomPick;
  desc: Description;
  entry: RoomMeta | null;
  file?: string;
  /** this room's (or generic cell's) tile, at whatever size the card allows - null while the manifest can't resolve one */
  src?: string | null;
  onClose: () => void;
  onKeyword: (keyword: string) => void;
  highlight?: { keyword: (text: string) => MatchRange[]; story: (text: string) => MatchRange[] } | null;
  tagLinks?: Record<string, string> | null;
  result?: SearchResult | null;
  weights?: Config['search']['weights'] | null;
  /** this room's favorite state, passed straight through to `RoomDetails` */
  favorite?: FavoriteControl | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Focus moves in on open and goes back where it came from on close - the
  // same contract `RoomOverlay` keeps, and for the same reason: a dialog that
  // leaves focus behind it strands a keyboard reader at the top of the
  // document.
  //
  // The restore is conditional rather than unconditional for two reasons. A
  // card is dismissed by clicking *anywhere else*, and that click has usually
  // already put focus somewhere the reader chose - stealing it back would
  // undo their own action. And the card may be closed because the map is
  // about to rearrange under it (`searchKeyword`), by which point the element
  // that opened it may be gone. So: restore only if focus is still inside the
  // card or has fallen to the body, which are exactly the cases where nobody
  // else has claimed it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      // The body is not somewhere focus can be "put back" - it is where focus
      // already is when nothing holds it, which is the ordinary case for a card
      // opened by right-clicking the canvas. Nothing to restore.
      if (!opener || opener === document.body || !opener.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !ref.current?.contains(active)) return;
      opener.focus();
    };
    // Mount and unmount only: re-running this on a re-render would drag focus
    // back to the card while someone is reading a chip inside it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // A dialog over the map has to hold focus, or Tab walks into whatever
      // is behind the scrim - the same trap `RoomOverlay` runs.
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

  // Named by `desc.name` - the same string a listbox option and the map's own
  // cursor say for this cell. The rank and the keywords are the reason to
  // have opened it.
  //
  // The visible id, unlike `desc.name`, leads with the title (`roomTitle`
  // falls back to "Room {id}" for a room the corpus hasn't retitled) and
  // trails with the filename - the numeric id alone named nothing a reader
  // could act on; the order it's listed in is never explained and rarely
  // matches the room's actual filename, so showing the number ahead of the
  // filename read as though it meant something it didn't.
  return (
    <div
      className="card-scrim"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="card" ref={ref} role="dialog" aria-modal="true" tabIndex={-1} aria-label={desc.name}>
        <div className="card-head">
          <span className="card-id">
            {'generic' in card ? (
              'a Babel shelf'
            ) : (
              <>
                <b>{roomTitle(entry, card.id)}</b>
                {file ? ` ${file}` : ''}
              </>
            )}
          </span>
          <button className="card-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>

        {/*
          The tile itself, so the card no longer has to be positioned clear of
          the room it describes to let a reader see it, and so a right-click
          here reaches the browser's own "save image" - neither was possible
          when the only picture of the room was the canvas underneath. `alt` is
          the sidecar's optional caption (`desc.picture`), empty when the corpus
          does not carry one.
        */}
        {src && <img className="card-tile" src={src} alt={desc.picture ?? ''} decoding="async" />}

        {/*
          Its own scrolling region, separate from the image above: a long story
          must not push the tile off screen, and a native-resolution tile must
          not bury the story below the fold with no way to reach it.
        */}
        <div className="card-scroll">
          <RoomDetails
            entry={entry}
            desc={desc}
            onKeyword={onKeyword}
            highlight={highlight}
            tagLinks={tagLinks}
            rank={'generic' in card ? undefined : card.rank}
            result={result}
            weights={weights}
            favorite={favorite}
          />
        </div>
      </div>
    </div>
  );
}
