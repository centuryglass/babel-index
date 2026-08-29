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
 *
 * The content-blocking panel lives at the bottom of this dialog, collapsed by
 * `<details>` rather than mounted open - a reader who has never heard of
 * sensitive-content tags should not see a checklist appear the first time
 * they open "help". `<details>`/`<summary>` costs nothing extra: it is
 * natively focusable and keyboard-operable, so the panel needs no open/closed
 * state of its own. It renders nothing at all when the corpus carries no
 * tags to block - most corpora - so the majority never see it, collapsed or
 * not.
 */
import { useEffect, useRef } from 'react';

export function HelpDialog({
  onClose,
  availableTags = [],
  blockedTags = [],
  onToggleTag,
  blockedCount = 0,
}: {
  onClose: () => void;
  availableTags?: string[];
  blockedTags?: string[];
  onToggleTag: (tag: string) => void;
  blockedCount?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      // `summary` is included because the content-blocking panel below is a
      // native `<details>` - it is focusable and in the real tab order
      // whether or not it is expanded, and a trap that does not know about it
      // would let Tab walk past the dialog's actual last stop.
      const focusable = ref.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'
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

        {availableTags.length > 0 && (
          <details className="help-block-panel">
            <summary>content settings</summary>
            <p className="help-block-note">
              Some rooms in this library carry a sensitive-content tag. Block a tag to
              remove every room carrying it from the map and the catalog.
              {blockedCount > 0 &&
                ` ${blockedCount} room${blockedCount === 1 ? ' is' : 's are'} hidden right now.`}
            </p>
            <ul className="help-block-list">
              {availableTags.map((tag) => (
                <li key={tag}>
                  <label>
                    <input
                      type="checkbox"
                      checked={blockedTags.includes(tag)}
                      onChange={() => onToggleTag(tag)}
                    />
                    {tag}
                  </label>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
