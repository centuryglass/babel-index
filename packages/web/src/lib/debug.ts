/**
 * `?debug` shows the dev panel and the cache/rearrangement HUD.
 *
 * The panel is the development surface: the ranked results list, the
 * rooms-on-map and non-generic sliders, rescatter and center, the
 * loading-animation loop, and the catalog and forget shortcuts. It is
 * hidden by default - a `DEBUG &&` gate in `MapView.tsx` - the same
 * module-scope flag pattern as `?touchdebug`'s pointer log.
 *
 * Read once at module scope, so `DEBUG` is a stable per-session boolean
 * the gate checks, not a URL query re-read on every render.
 */
export const DEBUG =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
