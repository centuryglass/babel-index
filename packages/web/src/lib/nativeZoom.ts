/**
 * Native pinch-zoom is only reachable while style.css's
 * `html:has(.overlay-scrim, .catalog)` rule relaxes touch-action back to
 * `auto` - for a room overlay, the help/artist-statement dialogs, or the
 * catalog view - see that rule's own comment for why it exists. The moment
 * the last such element unmounts, touch-action snaps back to `none` on the
 * map's ancestors, so a page left pinch-zoomed in has no gesture left to
 * zoom back out with over the map - only another `.overlay-scrim`/`.catalog`
 * offers the pinch again. `watchZoomUnlock` resets the page's zoom exactly
 * at that transition, which is what keeps the map reachable at 1x once a
 * reader is done with whatever they zoomed into.
 */

const LOCK_SELECTOR = '.overlay-scrim, .catalog';

/** Observes `root`'s direct children (where every `.overlay-scrim`/`.catalog`
 * element mounts) and resets page zoom the instant none of them remain. */
export function watchZoomUnlock(root: HTMLElement): () => void {
  let wasLocked = root.querySelector(LOCK_SELECTOR) !== null;
  const observer = new MutationObserver(() => {
    const isLocked = root.querySelector(LOCK_SELECTOR) !== null;
    if (wasLocked && !isLocked) resetPageZoom();
    wasLocked = isLocked;
  });
  observer.observe(root, { childList: true });
  return () => observer.disconnect();
}

function resetPageZoom() {
  if ((window.visualViewport?.scale ?? 1) <= 1.001) return;
  const meta = document.querySelector('meta[name="viewport"]');
  const original = meta?.getAttribute('content');
  if (!meta || !original) return;
  // Briefly capping maximum-scale forces mobile browsers to snap the visual
  // viewport back to 1x; reverting it right after keeps page zoom available
  // again next time a dialog opens - the attribute is never left in place,
  // exactly as index.html's own comment on WCAG 1.4.4 requires.
  meta.setAttribute('content', `${original}, maximum-scale=1`);
  requestAnimationFrame(() => meta.setAttribute('content', original));
}
