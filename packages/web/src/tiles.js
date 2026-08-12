/**
 * Lazy image cache for the map.
 *
 * The map is unbounded, so images are fetched only when a cell scrolls into
 * view and dropped once the cache is over budget and they are no longer the
 * ones being drawn. Nothing here is clever; it just has to avoid holding every
 * room in memory at once, since a full corpus will not fit.
 *
 * `createImage` exists so the eviction policy can be tested without a DOM; the
 * browser never passes it.
 */
export function createTileCache({ budget = 220, onLoad, createImage = () => new Image() } = {}) {
  const cache = new Map(); // url -> { img, state, lastUsed }
  let clock = 0;

  function get(url) {
    let entry = cache.get(url);
    if (entry) {
      entry.lastUsed = ++clock;
      return entry.state === 'ready' ? entry.img : null;
    }

    const img = createImage();
    entry = { img, state: 'loading', lastUsed: ++clock };
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

  function evict() {
    if (cache.size <= budget) return;
    const byAge = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [url, entry] of byAge.slice(0, cache.size - budget)) {
      if (entry.state === 'loading') continue; // let in-flight requests finish
      cache.delete(url);
    }
  }

  return { get, size: () => cache.size, clear: () => cache.clear() };
}
