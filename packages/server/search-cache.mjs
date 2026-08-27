/**
 * Bounded caching and concurrency for the CLIP text tower.
 *
 * `/api/search` runs CLIP inference synchronously per request with no cache and
 * no concurrency cap - a burst of distinct queries piles every request onto
 * however many threads `onnxruntime-node` uses, each paying full inference
 * cost. Two small, generic primitives fix that: an LRU cache (repeat searches -
 * history, re-searching the same term - are common) and a queue that caps how
 * many inferences run at once, so a burst degrades to latency instead of
 * thrashing the CPU. Neither primitive knows about CLIP; that keeps both
 * testable with no model and no network.
 */

/**
 * A capacity-bounded least-recently-used cache.
 *
 * Built on a `Map` rather than a dependency: insertion order is what a `Map`
 * already tracks, and re-inserting the key on every `get`/`set` is enough to
 * keep that order equal to recency - the oldest key is always
 * `keys().next().value`.
 *
 * @param {number} max entries to keep; must be at least 1
 */
export function createLruCache(max) {
  if (!(max >= 1)) throw new RangeError(`createLruCache: max must be at least 1, got ${max}`);
  const map = new Map();

  return {
    /** @returns {*} the cached value, or `undefined` on a miss */
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
  };
}

/**
 * Caps how many async jobs run at once; the rest wait in FIFO order.
 *
 * A promise-based semaphore rather than a real thread pool - `run` only
 * delays calling `fn` until a slot is free - which is enough to bound
 * `onnxruntime-node`'s CPU-bound inference without knowing anything about it.
 *
 * @param {number} max concurrent jobs; must be at least 1
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>} `run`
 */
export function createLimiter(max) {
  if (!(max >= 1)) throw new RangeError(`createLimiter: max must be at least 1, got ${max}`);
  let active = 0;
  const queue = [];

  function next() {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(
      (v) => {
        active--;
        resolve(v);
        next();
      },
      (e) => {
        active--;
        reject(e);
        next();
      }
    );
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}
