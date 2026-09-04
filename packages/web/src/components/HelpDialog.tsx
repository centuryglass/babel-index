/**
 * The one piece of explicit, plain-language help explaining the interface -
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
        aria-label="help"
      >
        <div className="card-head">
          <span className="card-id">help</span>
          <button className="card-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>

        <div className="help-body">
          <p>
            <strong>What this is:</strong> a zoomable, pannable map of library
            rooms, each paired with keywords and a short story. Most rooms are alike,
            but strange variations can be found among them.
          </p>
          <p>
            <strong>Move around:</strong> drag to pan, scroll or pinch to zoom. With a
            keyboard, arrow keys pan the map when no other control has focus.
          </p>
          <p>
            <strong>View a room:</strong> right-click it, long-press it, or focus it and
            press Enter, to see the full image, its story, and its keywords.
          </p>
          <p>
            <strong>Search:</strong> type a word or phrase into the search box at the
            center of the map. The map rearranges so closer matches sit nearer the center;
            an unrelated search leaves rooms mixed evenly with generic ones, which is a
            visible sign of how confident the match is. The books on the center shelf are
            shortcuts: some repeat an earlier search, others try a keyword drawn from the
            collection.
          </p>
          <p>
            <strong>Catalog view:</strong> one of the center shelf's books switches to a
            plain list view of the same collection, better suited to reading result by
            result than scanning a map.
          </p>
          <p>
            <strong>Favorites:</strong> mark a room as a favorite to find it again later and
            to help others discover the most interesting ones. Sort by your favorites to see
            all rooms you've marked, or by most favorited to see which ones other people
            recommend.
          </p>
          <p>
            <strong>Keyboard, general:</strong> Tab moves between controls, arrow keys pan
            the map or move shelf/list focus, Enter activates whatever is focused, and
            Escape closes an open dialog.
          </p>
          <p>
            <strong>Keyboard, on the map:</strong> the shortcuts below apply once the map
            itself has focus (Tab to it, or click it).
          </p>
          <dl className="help-keys">
            <dt>Arrow keys</dt>
            <dd>move one room at a time</dd>
            <dt>Shift + arrow</dt>
            <dd>jump a full screen in that direction</dd>
            <dt>Ctrl/Cmd + arrow</dt>
            <dd>jump to the next unique room in that direction, skipping generic ones</dd>
            <dt>+ / - (or Page Up/Down)</dt>
            <dd>zoom in or out, centered on the current room</dd>
            <dt>Home</dt>
            <dd>return to the center</dd>
            <dt>Ctrl/Cmd + Home</dt>
            <dd>jump to the top search result</dd>
            <dt>Ctrl/Cmd + End</dt>
            <dd>jump to the lowest-ranked search result</dd>
            <dt>Enter / Space</dt>
            <dd>open the current room</dd>
            <dt>/</dt>
            <dd>jump to the search box</dd>
            <dt>?</dt>
            <dd>hear a description of what's nearby</dd>
          </dl>
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
