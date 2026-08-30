/**
 * Placeholder for the artist's statement, reached by the open book painted
 * into a shelf gap on the center tile (`centerBookAtPoint` in
 * `packages/web/src/lib/center.ts`, dispatched from `main.tsx`).
 *
 * Structurally a copy of `HelpDialog`'s dialog machinery (focus in on open,
 * back out on close; Escape and a scrim click dismiss; Tab is trapped inside)
 * with no content yet - this ships empty on purpose, the same "seam ships
 * empty" the shelf's own override books were left in until the catalog
 * claimed one. See that file for why this is not factored into a shared
 * wrapper yet.
 */
import { useEffect, useRef } from 'react';

export function ArtistStatementOverlay({ onClose }: { onClose: () => void }) {
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

  return (
    <div className="overlay-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="overlay help-overlay"
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label="an artist's statement"
      >
        <div className="card-head">
          <span className="card-id">an artist's statement</span>
          <button className="card-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>

        <div className="help-body">
          <p>Coming soon.</p>
        </div>
      </div>
    </div>
  );
}
