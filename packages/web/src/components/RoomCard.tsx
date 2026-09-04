/**
 * One room's tile, keywords and story, opened by right-click or long press.
 *
 * Placed where the gesture happened and clamped back inside the viewport, so a
 * pick near an edge does not open a card half off screen. Escape and a click
 * anywhere outside close it, which are the two things anyone tries first.
 *
 * Carries its own tile image now, rather than leaning on the map underneath
 * being visible around the card - a card opened close to an edge used to cover
 * the exact room it was describing. That also gets a right-click here to the
 * browser's native "save image", which a canvas-painted tile could never
 * offer. The image and the text below it scroll independently (`.card-tile`
 * fixed, `.card-scroll` its own region) so a long story cannot push the
 * picture out of view.
 *
 * The text is `RoomDetails`, which the catalog's rows and the canvas's own
 * fallback content also render - so a room reads the same however a reader
 * reached it. What is here beyond that is the dialog around it: where it
 * sits, how it is dismissed, and where focus goes.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RoomDetails, type FavoriteControl } from './RoomDetails.tsx';
import type { RoomPick } from '../lib/picking.ts';
import { roomTitle, type RoomMeta } from '../../../map/metadata.ts';
import type { Description } from '../../../map/describe.ts';
import type { SearchResult, MatchRange } from '../../../map/searchResult.ts';
import type { Config } from '../../../config/config.ts';

/** How far the card sits from the pick, and from the edge it is clamped against. */
const CARD_GAP = 12;

/**
 * The area actually visible right now, not `window.inner{Width,Height}` alone.
 *
 * Those two describe the layout viewport, which on a phone can be larger than
 * what is on screen - a pinch-zoomed page, or a browser chrome toolbar that is
 * still animating out of the way, both shrink the VISUAL viewport without
 * changing the layout one. Clamping against the wrong rectangle is exactly
 * how a card that respects "inside the viewport" still opens partly under a
 * toolbar or past the zoomed-in edge. `visualViewport` is undefined in a test
 * DOM and on older browsers, so this falls back to the layout viewport there.
 */
function visibleRect() {
  const vv = window.visualViewport;
  return vv
    ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

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
  card: RoomPick & { at: { x: number; y: number } };
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
  const [pos, setPos] = useState(() => ({ left: card.at.x + CARD_GAP, top: card.at.y + CARD_GAP }));

  // Clamp against the card's REAL height, not an assumed one: it grows with the
  // story, so a guess is wrong for exactly the long entries most likely to run
  // off the bottom of a short viewport. useLayoutEffect so the correction lands
  // before the browser paints rather than as a visible jump.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const recalc = () => {
      const { width, height } = el.getBoundingClientRect();
      const vp = visibleRect();
      setPos({
        left: Math.max(vp.left + CARD_GAP, Math.min(card.at.x + CARD_GAP, vp.left + vp.width - width - CARD_GAP)),
        top: Math.max(vp.top + CARD_GAP, Math.min(card.at.y + CARD_GAP, vp.top + vp.height - height - CARD_GAP)),
      });
    };
    recalc();
    // The visible area can change out from under an already-open card - a
    // pinch-zoom, or a mobile browser's toolbar finishing its show/hide
    // animation - and only `visualViewport` reports either.
    const vv = window.visualViewport;
    vv?.addEventListener('resize', recalc);
    vv?.addEventListener('scroll', recalc);
    return () => {
      vv?.removeEventListener('resize', recalc);
      vv?.removeEventListener('scroll', recalc);
    };
  }, [card]);

  // Focus moves in on open and goes back where it came from on close.
  //
  // Two things make the restore conditional rather than unconditional. A card
  // is dismissed by clicking *anywhere else*, and that click has usually
  // already put focus somewhere the reader chose - stealing it back would
  // undo their own action. And the card may be closed because the map is about
  // to rearrange under it (`searchKeyword`), by which point the element that
  // opened it may be gone. So: restore only if focus is still inside the card
  // or has fallen to the body, which are exactly the cases where nobody else
  // has claimed it.
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
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // `pointerdown` rather than `click`: the canvas would otherwise start a pan
    // under a dismissing click, and the map would lurch as the card vanished.
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  // Named by `desc.name` - the same string a listbox option and (once the
  // cursor lands, phase C) the map itself would say for this cell. The rank
  // and the keywords are the reason to have opened it.
  //
  // `tabIndex={-1}` makes it focusable without putting it in the tab order,
  // which is what lets focus be moved here programmatically above.
  //
  // The visible id, unlike `desc.name`, leads with the title (`roomTitle`
  // falls back to "Room {id}" for a room the corpus hasn't retitled) and
  // trails with the filename - the numeric id alone named nothing a reader
  // could act on; the order it's listed in is never explained and rarely
  // matches the room's actual filename, so showing the number ahead of the
  // filename read as though it meant something it didn't.
  return (
    <div
      className="card"
      ref={ref}
      style={pos}
      role="dialog"
      tabIndex={-1}
      aria-label={desc.name}
    >
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
        must not push the tile off screen or force the whole card past
        `max-height` before either can be read in full.
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
  );
}
