/**
 * Native pinch-zoom/pan is left on for readers who want it (`index.html`'s
 * own note on why there's no `maximum-scale`/`user-scalable=no` - that would
 * be a WCAG 1.4.4 failure). But a dialog opening or closing is a natural
 * transition boundary, and nothing here should carry a zoom/pan applied to
 * reach some earlier, unrelated control (a small map button, an overlay
 * tile) into what happens next - see docs/pinch-zoom-native-fix-plan.md.
 *
 * There is no direct API to set `visualViewport.scale`/offset -
 * `resetNativeZoom` below is a one-shot reset at a boundary, never a
 * standing restriction, and restores the reader's own permissive viewport
 * `content` on the same tick so they can freely pinch-zoom again on the
 * very next gesture. Callers must run this from a `useLayoutEffect`, not a
 * plain `useEffect` - the DOM node a dialog's own open/close boundary hangs
 * off is removed synchronously during React's commit, but a passive
 * `useEffect` cleanup is scheduled asynchronously after that paint, and a
 * check made right after the element leaves the DOM (an e2e assertion, or a
 * reader's own eyes) can otherwise run before this has fired at all -
 * confirmed directly chasing why `pinch-zoom-native.e2e.ts`'s close-after-pan
 * case still read a leftover zoom moments after the dialog was already gone.
 */

const RESET_ATTEMPTS = 5;

function toggleViewportContent(meta: Element, original: string): void {
  // Setting `content` back to a value IDENTICAL to what's already applied is
  // a no-op - Chromium (confirmed directly, see
  // packages/web/e2e/pinch-zoom-native.e2e.ts) only recomputes zoom when the
  // parsed viewport description actually changes. Toggling through a
  // `content` whose `initial-scale` genuinely differs, then back to the
  // page's real one, is what forces that recompute: the interim value snaps
  // scale (and any pan offset) to itself, and landing back on this page's
  // own `initial-scale=1` leaves it there rather than re-zooming out again.
  const distinct = /initial-scale\s*=\s*[\d.]+/i.test(original)
    ? original.replace(/initial-scale\s*=\s*[\d.]+/i, 'initial-scale=1.0001')
    : `${original}, initial-scale=1.0001`;
  meta.setAttribute('content', distinct);
  meta.setAttribute('content', original);
}

export function resetNativeZoom(): void {
  const meta = document.querySelector('meta[name="viewport"]');
  const original = meta?.getAttribute('content');
  if (!meta || !original) return;

  toggleViewportContent(meta, original);

  // A pinch immediately followed by a pan can still be settling (Chromium's
  // own fling/rubber-band physics after the touch lifts) at the exact
  // instant this runs, which the single toggle above alone does not
  // reliably win. A few follow-up toggles a frame apart catch whatever the
  // first one lost the race against, without this ever becoming a standing
  // per-frame loop.
  const vv = window.visualViewport;
  let attempts = 0;
  const retry = () => {
    attempts += 1;
    const settled = !vv || (vv.scale < 1.05 && Math.abs(vv.offsetLeft) < 1 && Math.abs(vv.offsetTop) < 1);
    if (settled || attempts >= RESET_ATTEMPTS) return;
    toggleViewportContent(meta, original);
    requestAnimationFrame(retry);
  };
  requestAnimationFrame(retry);
}
