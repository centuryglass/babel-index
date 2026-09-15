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
import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';

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

/**
 * Props for a scrim div that closes its dialog on an outside click, without
 * also reaching whatever is behind it.
 *
 * Closing straight from `onPointerDown` (every scrim's old behaviour) can
 * unmount the scrim before the browser gets to dispatch the `click` that
 * follows - pointerdown, pointerup and click are three separate native
 * events, and React re-renders after the first of them. The `click` then
 * hits whatever the pointer is over once the scrim is gone: on the map that
 * lands nowhere clickable, but a catalog row sits exactly where the scrim
 * just was, so the same gesture that closed one room's overlay opens the row
 * underneath it. Waiting for `click` itself - the last event in the
 * sequence - keeps the scrim mounted through the whole gesture, so it is
 * still what the browser hit-tests.
 *
 * Requiring `pointerdown` to have also started on the scrim (not just the
 * `click`) rules out the other direction: a click event's target is the
 * common ancestor of its pointerdown and pointerup targets, so a drag that
 * starts inside the dialog and is released outside it can otherwise retarget
 * the click onto the scrim and close a dialog the reader was merely
 * selecting text in.
 */
export function useScrimDismiss(onClose: () => void): {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onClick: (e: ReactMouseEvent<HTMLElement>) => void;
} {
  const downOnScrim = useRef(false);
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    downOnScrim.current = e.target === e.currentTarget;
  }, []);
  const onClick = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      const shouldClose = downOnScrim.current && e.target === e.currentTarget;
      downOnScrim.current = false;
      if (shouldClose) onClose();
    },
    [onClose]
  );
  return { onPointerDown, onClick };
}
