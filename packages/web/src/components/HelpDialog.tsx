/**
 * The one piece of explicit, plain-language help explaining the interface -
 * reached by pressing a reserved book on the center shelf (action `help`
 * in `useCenterShelf.ts`'s `CENTER_OVERRIDES`). No new UI chrome outside
 * the shelf.
 *
 * The focus-in/restore, Escape and Tab-trap machinery below is an inline
 * copy of what `useDialog` provides, bound to `window` outside its
 * topmost-only stack. It is correct only while no other dialog can open over
 * this one, or one Escape closes both. `docs/file_map.md`'s `useDialog.ts`
 * entry records which dialogs have adopted the hook.
 *
 * The content-blocking panel sits at the bottom of the dialog, collapsed
 * in a native `<details>` rather than mounted open: a reader who has never
 * heard of sensitive-content tags should not see a checklist the first
 * time they open "help". `<details>`/`<summary>` is natively focusable and
 * keyboard-operable, so the panel needs no open/closed state of its own.
 * It renders nothing when the corpus carries no tags to block.
 */
import { useEffect, useRef } from 'react';
import { useContentZoom } from '../hooks/useContentZoom.ts';
import { useScrimDismiss } from '../hooks/useDialog.ts';
import { ZoomControls } from './ZoomControls.tsx';
import { HelpBody } from './HelpBody.tsx';

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
  // Viewport = `.overlay` (`ref`) itself - see useContentZoom.ts. No
  // resetKey: this dialog's content never changes under a given instance.
  const contentZoom = useContentZoom(ref);
  const scrimDismiss = useScrimDismiss(onClose);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (!opener || opener === document.body || !opener.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !ref.current?.contains(active)) return;
      opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      // `summary` is in the selector because the content-blocking panel is
      // a native `<details>`: focusable and in the real tab order whether
      // or not it is expanded, and a trap that missed it would let Tab
      // walk past the dialog's actual last stop.
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
    <div className="overlay-scrim" {...scrimDismiss}>
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

        <div
          className={contentZoom.zoomed ? 'paper-sheet zoom-scope zoomed' : 'paper-sheet zoom-scope'}
          ref={contentZoom.ref}
          style={contentZoom.style}
        >
        <HelpBody />

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
    </div>
  );
}
