/**
 * Lazy image cache for the map.
 *
 * The map is unbounded, so images are fetched only when a cell scrolls into
 * view and dropped once the cache is over budget and they are no longer the
 * ones being drawn. Nothing here is clever; it just has to avoid holding every
 * room in memory at once, since a full corpus will not fit.
 *
 * ### Eviction is frame-aware, and has to be
 *
 * The budget is smaller than a zoomed-out screen - at MIN_ZOOM a 1600x900
 * viewport wants ~800 distinct rooms and the budget is 240 - so eviction is not
 * an edge case out there, it is every frame. That makes *what* gets evicted the
 * whole game.
 *
 * A plain LRU gets it exactly wrong. The renderer walks cells row by row, so
 * within one frame the tiles it has already drawn are the least recently used
 * things in the cache. A miss half way down the screen would evict the top of
 * the same screen - tiles that are still visible and about to be drawn again
 * one frame later. The result is a pan that blanks and refetches tiles that
 * never left the viewport.
 *
 * So entries carry the frame they were last drawn in, and eviction skips
 * anything touched by the current frame or the one before it. The previous
 * frame is included because it is very nearly the current one: a pan moves the
 * viewport by a cell or two, and a tile drawn last frame is almost certainly
 * still on screen this frame. Everything older is fair game.
 *
 * The consequence is deliberate: when a single screen exceeds the budget the
 * cache grows past it rather than thrashing, and `overBudget()` says by how
 * much. Holding two screens is the lesser evil, and the real fix is to stop
 * drawing full-resolution art when zoomed out - see pyramid.js.
 *
 * `createImage` exists so the eviction policy can be tested without a DOM; the
 * browser never passes it.
 */
export function createTileCache({ budget = 220, onLoad, createImage = () => new Image() } = {}) {
  const cache = new Map(); // url -> { img, state, lastUsed, frame }
  const pinned = new Set();
  let clock = 0;
  // null until the caller opts in. Without beginFrame() there is no such thing
  // as "the current frame", so nothing is protected and this is a plain LRU.
  let frame = null;

  /**
   * Open a new frame. Tiles drawn from here on, and those drawn in the previous
   * frame, are off-limits to eviction until two frames have passed.
   */
  function beginFrame() {
    frame = (frame ?? 0) + 1;
    evict();
  }

  /** Keep this url forever. The generic room is the floor rule 1 falls back to. */
  function pin(url) {
    pinned.add(url);
    return get(url);
  }

  function get(url) {
    let entry = cache.get(url);
    if (entry) {
      entry.lastUsed = ++clock;
      entry.frame = frame;
      return entry.state === 'ready' ? entry.img : null;
    }

    const img = createImage();
    entry = { img, state: 'loading', lastUsed: ++clock, frame };
    cache.set(url, entry);

    img.onload = () => {
      entry.state = 'ready';
      onLoad?.();
    };
    img.onerror = () => {
      entry.state = 'error';
    };
    img.src = url;

    evict();
    return null;
  }

  /** Is this entry one the current draw still depends on? */
  const inUse = (entry) => frame !== null && entry.frame != null && entry.frame >= frame - 1;

  function evict() {
    if (cache.size <= budget) return;
    const spare = [...cache.entries()]
      // An in-flight drop orphans the request: the image completes, writes into
      // an entry no longer in the map, and the url is fetched again next draw.
      .filter(([url, e]) => e.state !== 'loading' && !pinned.has(url) && !inUse(e))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    for (const [url] of spare.slice(0, cache.size - budget)) cache.delete(url);
  }

  return {
    get,
    pin,
    beginFrame,
    size: () => cache.size,
    /** How far past the budget the visible working set is forcing us. */
    overBudget: () => Math.max(0, cache.size - budget),
    clear: () => {
      cache.clear();
      pinned.clear();
    },
  };
}
