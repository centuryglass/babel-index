/**
 * The tile cache: which resolution of which room is in memory, and what to draw
 * when the one you asked for is not.
 *
 * Keyed on `(id, level)`, not on url. A room is one thing at five resolutions,
 * and the whole point of the pyramid is that those five are interchangeable in
 * a pinch - so the cache has to be able to answer "what do you have for room
 * 12?" rather than only "do you have this url?".
 *
 * ### Budgets are per level, and that is load-bearing
 *
 * Each level gets its own LRU with its own budget from `pyramid.js`. A single
 * global LRU would break rule 1: zooming in floods the cache with level 0,
 * evicts the entire coarse field, and zooming back out flashes blank across the
 * whole screen - which is the failure the pyramid exists to prevent. Levels
 * never evict each other.
 *
 * ### Eviction is frame-aware, and that is too
 *
 * The renderer walks cells row by row, so mid-frame the tiles it has ALREADY
 * DRAWN are the least recently used entries in the cache. A plain LRU therefore
 * evicts the top of the screen to make room for the bottom of the same screen,
 * and the pan blanks and refetches tiles that never left the viewport. Entries
 * carry the frame they were last drawn in, and eviction skips anything touched
 * by the current frame or the one before it - the previous frame included
 * because eviction runs at the top of a frame, before the renderer has touched
 * anything, so protecting only the frame in progress would protect nothing.
 *
 * When one screen genuinely exceeds a level's budget the cache holds it anyway
 * and `overBudget()` says by how much. Holding is the lesser evil; picking a
 * coarser level is the actual answer, and that is the renderer's job.
 *
 * `createImage` exists so all of this can be tested without a DOM; the browser
 * never passes it.
 */
import { PYRAMID, PREFETCH } from './pyramid.js';

/**
 * The shared-tile ids. Strings, so they can never collide with a numeric room id.
 *
 * `CENTER` is the blank center tile at cell (0, 0). The wallpaper elsewhere is
 * one of N inpainted generics, addressed by `genericId(i)`; a generic cell with
 * none available (an empty `generic/` dir) falls back to `CENTER`, which is why
 * `genericId(-1)` is `CENTER` rather than an id that resolves to nothing.
 */
export const CENTER = 'center';
export const genericId = (i) => (i < 0 ? CENTER : `generic:${i}`);

/** How many prefetches may be waiting at once. See prefetch() for why. */
const QUEUE_LIMIT = 256;

/**
 * @param {object} opts
 * @param {(id: number|string, level: number) => string|null} opts.urlFor
 *        where a level of a room lives, or null if that level does not exist
 * @param {object} [opts.pyramid]      the ladder and its budgets
 * @param {() => void} [opts.onLoad]   ask for a redraw
 * @param {number} [opts.concurrency]  in-flight prefetches allowed
 * @param {() => object} [opts.createImage]
 */
export function createTileCache({
  urlFor,
  pyramid = PYRAMID,
  onLoad,
  concurrency = PREFETCH.concurrency,
  createImage = () => new Image(),
} = {}) {
  // level -> (id -> { img, state, lastUsed, frame })
  const levels = new Map(pyramid.levels.map((l) => [l.level, new Map()]));
  const pinned = new Set();
  const queue = [];
  let inFlightPrefetch = 0;
  let clock = 0;
  // null until the caller opts in: without beginFrame() there is no such thing
  // as "the current frame", so nothing is protected and this is a plain LRU.
  let frame = null;

  const bucket = (level) => levels.get(level);
  const entry = (id, level) => bucket(level)?.get(id);
  const isReady = (id, level) => entry(id, level)?.state === 'ready';

  /**
   * Open a new frame. Tiles drawn from here on, and those drawn in the frame
   * before, are off-limits to eviction. Also drops any prefetch still queued
   * from the last frame: it was queued for a viewport that has since moved.
   */
  function beginFrame() {
    frame = (frame ?? 0) + 1;
    queue.length = 0;
    for (const { level } of pyramid.levels) evict(level);
  }

  /** Keep every level of this room forever. The base tiles are the floor rule 1 lands on. */
  function pin(id) {
    pinned.add(id);
  }

  /**
   * Start the load for one level of one room, if it is not already here or on
   * its way. Returns the image if it happens to be ready.
   */
  function request(id, level) {
    const found = entry(id, level);
    if (found) {
      found.lastUsed = ++clock;
      found.frame = frame;
      return found.state === 'ready' ? found.img : null;
    }

    const url = urlFor(id, level);
    // No url means this level was never generated for this corpus. Recording a
    // miss would be recording a fact about the corpus in a per-tile cache.
    if (url == null) return null;

    const store = bucket(level);
    if (!store) return null;

    const img = createImage();
    const fresh = { img, state: 'loading', lastUsed: ++clock, frame };
    store.set(id, fresh);

    img.onload = () => {
      fresh.state = 'ready';
      onLoad?.();
    };
    // A 404 is remembered rather than retried: the entry stays, permanently
    // demoting this cell to whatever level does work.
    img.onerror = () => {
      fresh.state = 'error';
    };
    img.src = url;

    evict(level);
    return null;
  }

  /**
   * The nearest level this room has art for at all, which is not always the one
   * asked for: a corpus that has never been through the pipeline has only level
   * 0, so every request for a coarser tile has to resolve to it or the cell
   * would wait forever for a file that does not exist.
   *
   * Same preference as `bestAvailable` - coarser first, then finer - so what
   * gets fetched and what gets drawn agree about which substitute is best.
   */
  function servableLevel(id, want) {
    if (urlFor(id, want) != null) return want;
    for (const { level } of pyramid.levels)
      if (level > want && urlFor(id, level) != null) return level;
    for (let i = pyramid.levels.length - 1; i >= 0; i--) {
      const { level } = pyramid.levels[i];
      if (level < want && urlFor(id, level) != null) return level;
    }
    return null;
  }

  /**
   * Rule 1: the best thing available to draw for this room right now.
   *
   * Always starts the nearest servable level loading, then answers with
   * whatever is actually here - coarser first, since a coarse tile is cheap,
   * usually already resident from the zoomed-out view, and upscales to
   * something soft but correct. The level comes back with the image so the
   * renderer can tell a hit from a substitute.
   *
   * @returns {{img: object, level: number}|null} null only when the room has nothing at all
   */
  function get(id, want) {
    const servable = servableLevel(id, want);
    if (servable !== null) request(id, servable);
    const level = pyramid.bestAvailable((l) => isReady(id, l), want);
    return level === null ? null : { img: entry(id, level).img, level };
  }

  /**
   * Rule 2: load this, but only behind everything visible.
   *
   * Queued rather than issued, and capped, because a prefetch that queues ahead
   * of a visible tile has made rule 1 worse in order to serve rule 2. The queue
   * is cleared every frame, so a fast pan never works through a backlog aimed
   * at where the camera used to be.
   */
  function prefetch(id, level) {
    // The queue is emptied every frame, so anything past what `concurrency`
    // could plausibly start before the next one is stale before it is reached.
    // A zoomed-out frame offers thousands of candidates; taking them all would
    // be a large allocation per frame to throw away.
    if (queue.length >= QUEUE_LIMIT) return;
    if (entry(id, level) || urlFor(id, level) == null) return;
    queue.push([id, level]);
    pump();
  }

  function pump() {
    while (inFlightPrefetch < concurrency && queue.length) {
      const [id, level] = queue.shift();
      if (entry(id, level)) continue; // arrived by another route since queueing
      inFlightPrefetch++;
      request(id, level);
      const started = entry(id, level);
      if (!started || started.state !== 'loading') {
        inFlightPrefetch--;
        continue;
      }
      const done = () => {
        inFlightPrefetch--;
        pump();
      };
      const { onload, onerror } = started.img;
      started.img.onload = () => { onload?.(); done(); };
      started.img.onerror = () => { onerror?.(); done(); };
    }
  }

  /** Is this entry one the current draw still depends on? */
  const inUse = (e) => frame !== null && e.frame != null && e.frame >= frame - 1;

  function evict(level) {
    const store = bucket(level);
    const budget = pyramid.budgetOf(level);
    if (!store || store.size <= budget) return;

    const spare = [...store.entries()]
      // Dropping an in-flight entry orphans the request: the image completes,
      // writes into an entry no longer in the map, and the url is fetched again
      // the next time it is drawn.
      .filter(([id, e]) => e.state !== 'loading' && !pinned.has(id) && !inUse(e))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    for (const [id] of spare.slice(0, store.size - budget)) store.delete(id);
  }

  const size = () => [...levels.values()].reduce((n, store) => n + store.size, 0);

  return {
    beginFrame,
    request,
    get,
    prefetch,
    pin,
    size,
    sizeOf: (level) => bucket(level)?.size ?? 0,
    /** How far past their budgets the visible working set is forcing the levels. */
    overBudget: () =>
      pyramid.levels.reduce(
        (n, l) => n + Math.max(0, (bucket(l.level)?.size ?? 0) - pyramid.budgetOf(l.level)),
        0
      ),
    pendingPrefetch: () => queue.length,
    clear: () => {
      for (const store of levels.values()) store.clear();
      pinned.clear();
      queue.length = 0;
      inFlightPrefetch = 0;
    },
  };
}
