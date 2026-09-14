/**
 * Native pinch-zoom/pan is left on for readers who want it (`index.html`'s
 * own note on why there's no `maximum-scale`/`user-scalable=no` - that would
 * be a WCAG 1.4.4 failure). But a dialog opening or closing is a natural
 * transition boundary, and nothing here should carry a zoom/pan applied to
 * reach some earlier, unrelated control (a small map button, an overlay
 * tile) into what happens next - see docs/pinch-zoom-native-fix-plan.md.
 *
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

/**
 * Force a genuinely NEW `<meta name="viewport">` element into the document
 * carrying `content`, rather than mutating the existing one's attribute.
 * Confirmed directly in Chromium that mutating `content` to a value
 * IDENTICAL to what's already applied is a no-op - it only recomputes zoom
 * when the parsed viewport description actually changes - so toggling
 * through a distinct `initial-scale` and back (see `resetNativeZoom` below)
 * already covers that engine. Firefox's own viewport meta handling has a
 * separate, longstanding gap where a dynamic `content` update does not
 * always discard the previously-parsed values (mozilla bug 1498729) - a
 * full element swap is the least ambiguous way to say "this really changed"
 * to an engine that might otherwise coalesce or ignore an attribute mutation.
 */
function replaceViewportMeta(meta: HTMLMetaElement, content: string): HTMLMetaElement {
  const next = document.createElement('meta');
  next.setAttribute('name', 'viewport');
  next.setAttribute('content', content);
  meta.replaceWith(next);
  return next;
}

function toggleViewportContent(meta: HTMLMetaElement, original: string): HTMLMetaElement {
  const distinct = /initial-scale\s*=\s*[\d.]+/i.test(original)
    ? original.replace(/initial-scale\s*=\s*[\d.]+/i, 'initial-scale=1.0001')
    : `${original}, initial-scale=1.0001`;
  return replaceViewportMeta(replaceViewportMeta(meta, distinct), original);
}

export function resetNativeZoom(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const original = meta?.getAttribute('content');
  if (!meta || !original) return;

  // The real fix for this, once browsers ship it: a direct, purpose-built
  // reset the CSS Working Group resolved to add (w3c/csswg-drafts#9787),
  // not yet in TypeScript's own DOM lib - call it when present rather than
  // only ever reaching for the viewport meta workaround below.
  const vv = window.visualViewport as (VisualViewport & { resetScale?: () => void }) | null;
  if (typeof vv?.resetScale === 'function') {
    vv.resetScale();
    return;
  }

  let current = toggleViewportContent(meta, original);

  // A pinch immediately followed by a pan can still be settling (a native
  // fling/rubber-band physics after the touch lifts) at the exact instant
  // this runs, which the single toggle above alone does not reliably win. A
  // few follow-up toggles a frame apart catch whatever the first one lost
  // the race against, without this ever becoming a standing per-frame loop.
  let attempts = 0;
  const retry = () => {
    attempts += 1;
    const settled = !vv || (vv.scale < 1.05 && Math.abs(vv.offsetLeft) < 1 && Math.abs(vv.offsetTop) < 1);
    if (settled || attempts >= RESET_ATTEMPTS) return;
    current = toggleViewportContent(current, original);
    requestAnimationFrame(retry);
  };
  requestAnimationFrame(retry);
}
