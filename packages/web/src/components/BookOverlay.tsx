/**
 * The open-book overlay both reading dialogs are built from: a scrim, a
 * focus-trapped dialog (`useDialog`), a corner close button, and a `.book`
 * whose pages sit side by side when there is room for two and collapse to one
 * column when there is not. The artist's statement and the Babel book are this
 * same book with different pages inside - the look and the collapse live here,
 * so a change to either is made once.
 *
 * The collapse is a CSS container query on the dialog's own available width
 * (not a device or pointer gate, so a shrunk desktop window collapses too). A
 * reader that pages a spread at a time - the Babel book, two pages when wide
 * and one when narrow - needs to know which layout is showing to advance by the
 * right amount, so the SAME width and threshold are reported back through
 * `onWideChange`. CSS and JS read the one number; they cannot disagree about
 * whether two pages are on screen.
 */
import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useDialog } from '../hooks/useDialog.ts';

// Must match `@container book (min-width: ...)` in index.html - the width below
// which the spread collapses to a single column.
const WIDE_MIN = 680;

interface BookOverlayProps {
  ariaLabel: string;
  onClose: () => void;
  /** Extra scrim classes, e.g. `stacked` (on top) or `behind` (dimmed under). */
  scrimClassName?: string;
  /** Extra classes on the dialog itself, e.g. `statement-overlay`. */
  overlayClassName?: string;
  /** Card-head content left of the close button (e.g. a page counter). */
  head?: ReactNode;
  /** Controls under the book (e.g. previous/next). */
  footer?: ReactNode;
  /** Called with whether the dialog is wide enough to show two pages. */
  onWideChange?: (isWide: boolean) => void;
  /** The `.book-page` element(s) - one or two. */
  children: ReactNode;
}

export function BookOverlay({
  ariaLabel,
  onClose,
  scrimClassName,
  overlayClassName,
  head,
  footer,
  onWideChange,
  children,
}: BookOverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);

  // Keep the latest callback without rebinding the observer each render.
  const onWideRef = useRef(onWideChange);
  onWideRef.current = onWideChange;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measure the container's content box - the inline-size the container query
    // reads - rather than the border box, so the two agree at the threshold.
    const report = () => {
      const cb = onWideRef.current;
      if (!cb) return;
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      cb(w >= WIDE_MIN);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      className={scrimClassName ? `overlay-scrim ${scrimClassName}` : 'overlay-scrim'}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={overlayClassName ? `overlay book-overlay ${overlayClassName}` : 'overlay book-overlay'}
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={ariaLabel}
      >
        <div className="card-head">
          {head}
          <button className="card-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>
        <div className="book">{children}</div>
        {footer}
      </div>
    </div>
  );
}
