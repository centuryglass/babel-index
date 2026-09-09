/**
 * The modal-dialog machinery every overlay needs: focus in on open and back
 * out on close, Escape to dismiss, and a Tab-trap that keeps focus inside.
 * Copy-pasted three times before this existed (`RoomOverlay`, `HelpDialog`,
 * `ArtistStatementOverlay`) and missing entirely from `BabelBookOverlay`.
 *
 * The one thing the duplicated copies never had is a dialog STACK. Overlays
 * can now sit on top of each other (the artist statement opens the Babel book
 * over itself), and every copy bound Escape and its Tab-trap to `window` - so
 * two open at once meant one Escape closed both and two Tab-traps fought over
 * focus. The stack fixes that: only the topmost open dialog reacts to a key.
 * It is a plain module-level array rather than context because the ordering it
 * tracks is mount order, which is exactly what a shared array already records.
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// Distinct object per open dialog; identity is all the stack compares on.
type DialogToken = { id: symbol };

const stack: DialogToken[] = [];

/** Push a dialog as the new topmost. */
export function pushDialog(token: DialogToken): void {
  stack.push(token);
}

/** Remove a dialog from the stack, wherever it sits (unmount order is not
 * guaranteed to be reverse mount order under React's cleanup). */
export function popDialog(token: DialogToken): void {
  const i = stack.lastIndexOf(token);
  if (i !== -1) stack.splice(i, 1);
}

/** Whether this dialog is the one a global key press should act on. */
export function isTopDialog(token: DialogToken): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/** Test-only: drop any leftover entries between cases. */
export function resetDialogStack(): void {
  stack.length = 0;
}

const FOCUSABLE =
  'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/**
 * Wire a dialog element (the `.overlay` node the ref points at) into the
 * shared machinery. Focuses it on mount, restores focus to the opener on
 * unmount, and - only while it is the topmost dialog - closes on Escape and
 * traps Tab within it.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
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

  const tokenRef = useRef<DialogToken>({ id: Symbol('dialog') });
  useEffect(() => {
    const token = tokenRef.current;
    pushDialog(token);
    return () => popDialog(token);
  }, []);

  useEffect(() => {
    const token = tokenRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (!isTopDialog(token)) return;
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      const focusable = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
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
  }, [onClose, ref]);
}
