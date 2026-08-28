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
 * @param max entries to keep; must be at least 1
 */
export function createLruCache<K, V>(max: number) {
  if (!(max >= 1)) throw new RangeError(`createLruCache: max must be at least 1, got ${max}`);
  const map = new Map<K, V>();

  return {
    /** the cached value, or `undefined` on a miss */
    get(key: K): V | undefined {
      if (!map.has(key)) return undefined;
      const value = map.get(key) as V;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key: K, value: V) {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value as K);
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
 * @param max concurrent jobs; must be at least 1
 * @returns `run`
 */
export function createLimiter(max: number) {
  if (!(max >= 1)) throw new RangeError(`createLimiter: max must be at least 1, got ${max}`);
  let active = 0;
  interface Job<T> {
    fn: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
  }
  const queue: Job<unknown>[] = [];

  function next() {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift() as Job<unknown>;
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

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({ fn, resolve, reject } as unknown as Job<unknown>);
      next();
    });
  };
}
