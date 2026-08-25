/**
 * "A note on finding your way" - the library's one piece of explicit help,
 * reached by pressing a reserved book on the center shelf (`onOverride` in
 * `main.jsx`, action `help`). No new UI chrome outside the shelf.
 *
 * Structurally a copy of `RoomOverlay`'s dialog machinery (focus in on open,
 * back out on close; Escape and a scrim click dismiss; Tab is trapped inside)
 * with no room to show - static text instead of `RoomDetails`. Two copies of
 * that machinery rather than a shared wrapper because there is no third
 * dialog yet to justify factoring it out; if one shows up, fold this and
 * `RoomOverlay` into it together.
 */
import { useEffect, useRef } from 'react';

export function HelpDialog({ onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.focus();
    return () => {
      if (!opener || opener === document.body || !opener.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !ref.current?.contains(active)) return;
      opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      const focusable = ref.current?.querySelectorAll(
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

  return (
    <div className="overlay-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="overlay help-overlay"
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label="a note on finding your way"
      >
        <div className="card-head">
          <span className="card-id">a note on finding your way</span>
          <button className="card-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>

        <div className="help-body">
          <p>
            This is a library. Drag to walk the shelves, scroll or pinch to draw closer or
            step back. Right-click a room - or long-press it - to read what is on its wall.
          </p>
          <p>
            The room at the center holds the search desk. Type a word or phrase into it and
            the library rearranges itself around what matches. The books on its shelf are
            worth trying too: each is either a search already made, waiting to be repeated,
            or a word drawn from the collection, waiting to be tried.
          </p>
          <p>
            One of those books leads to the catalog: the same collection, read as an
            ordinary list rather than walked as a map.
          </p>
          <p>
            With a keyboard: arrow keys move the shelf's focus and pan the map when nothing
            else has claimed the press, Enter reads or repeats a book, and Escape closes
            an open dialog.
          </p>
        </div>
      </div>
    </div>
  );
}
