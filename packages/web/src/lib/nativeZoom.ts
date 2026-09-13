/**
 * Keeps `<html>`'s `zoomed` class in sync with whether the page is actually
 * pinch-zoomed in, for style.css's `html.zoomed` rule - see that rule's own
 * comment. `.overlay-scrim`/`.catalog` being mounted is what LETS a reader
 * start a native pinch (the CSS's `:has()` half), but closing the overlay
 * mid-zoom used to strand the page zoomed in with touch-action already back
 * to `none` over the map - no gesture left to zoom back out with, only
 * opening another overlay/catalog offered the pinch again. Resetting the
 * zoom itself from script was the first attempt (toggling `maximum-scale` on
 * the viewport `<meta>` tag, the usual cross-browser trick) - it does
 * nothing on Chrome for Android, which ignores a runtime edit to the
 * viewport meta after the initial layout. Tracking the live zoom level
 * directly and keeping touch-action relaxed for as long as it lasts sidesteps
 * that entirely: the reader's own pinch-out gesture reaches the browser
 * regardless of whether the dialog that let them zoom in is still open.
 */

const ZOOMED_CLASS = 'zoomed';
// Pinch zoom rarely lands on exactly 1 - a hair of slack against float noise
// so a "fully unzoomed" reading isn't missed by a fraction of a percent.
const EPSILON = 0.01;

export function watchNativeZoom(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const onResize = () => {
    document.documentElement.classList.toggle(ZOOMED_CLASS, viewport.scale > 1 + EPSILON);
  };
  onResize();
  viewport.addEventListener('resize', onResize);
  return () => viewport.removeEventListener('resize', onResize);
}
