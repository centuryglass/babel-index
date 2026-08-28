/**
 * `?debug` shows the dev panel and its cache/rearrangement stats.
 *
 * Everything the panel used to expose by default - the ranked results list,
 * the sliders, reorder/rescatter/center, the cache HUD - is now either
 * reachable diegetically (the shelf's first book opens the catalog, the
 * in-tile field is the real search box) or a launch-time concern nobody
 * needs mid-session. What is left in the panel is genuinely for development,
 * so it is gated the same way `?touchdebug` gates the pointer log: read once
 * at module scope, so a normal session compiles the panel out of the tree
 * rather than rendering and hiding it.
 */
export const DEBUG =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
