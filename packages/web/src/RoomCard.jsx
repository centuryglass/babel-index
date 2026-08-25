/**
 * One room's keywords and story, opened by right-click or long press.
 *
 * Placed where the gesture happened and clamped back inside the viewport, so a
 * pick near an edge does not open a card half off screen. Escape and a click
 * anywhere outside close it, which are the two things anyone tries first.
 *
 * The body is `RoomDetails`, which the catalog's rows and the canvas's own
 * fallback content also render - so a room reads the same however a reader
 * reached it. What is here is the dialog around it: where it sits, how it is
 * dismissed, and where focus goes.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RoomDetails } from './RoomDetails.jsx';

/** How far the card sits from the pick, and from the edge it is clamped against. */
const CARD_GAP = 12;

export function RoomCard({ card, desc, entry, file, onClose, onKeyword, highlight, result, weights }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(() => ({ left: card.at.x + CARD_GAP, top: card.at.y + CARD_GAP }));

  // Clamp against the card's REAL height, not an assumed one: it grows with the
  // story, so a guess is wrong for exactly the long entries most likely to run
  // off the bottom of a short viewport. useLayoutEffect so the correction lands
  // before the browser paints rather than as a visible jump.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(CARD_GAP, Math.min(card.at.x + CARD_GAP, window.innerWidth - width - CARD_GAP)),
      top: Math.max(CARD_GAP, Math.min(card.at.y + CARD_GAP, window.innerHeight - height - CARD_GAP)),
    });
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
    const opener = document.activeElement;
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
    const onKey = (e) => e.key === 'Escape' && onClose();
    // `pointerdown` rather than `click`: the canvas would otherwise start a pan
    // under a dismissing click, and the map would lurch as the card vanished.
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  // Named by `desc.name` - the same string a listbox option and (once the
  // cursor lands, phase C) the map itself would say for this cell. "room" -
  // which is what this used to announce on its own - is the one fact a reader
  // already had; the rank and the keywords are the reason to have opened it.
  //
  // `tabIndex={-1}` makes it focusable without putting it in the tab order,
  // which is what lets focus be moved here programmatically above.
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
          {card.generic ? 'blank wall' : `room ${card.id}${file ? ` · ${file}` : ''}`}
        </span>
        <button className="card-close" onClick={onClose} aria-label="close">
          ×
        </button>
      </div>

      <RoomDetails
        entry={entry}
        desc={desc}
        onKeyword={onKeyword}
        highlight={highlight}
        rank={card.rank}
        result={result}
        weights={weights}
      />
    </div>
  );
}
