/**
 * Bounded caching and concurrency for the CLIP text tower.
 *
 * `/api/search` runs CLIP inference per request. Unbounded, a burst of
 * distinct queries piles onto every core `onnxruntime-node` uses, each
 * paying full inference cost. Two generic primitives cover it: an LRU cache
 * (repeat searches - history, re-searching a term - are common) and a
 * limiter that caps concurrent inferences, so a burst degrades to latency
 * instead of thrashing the CPU. Neither knows about CLIP, which keeps both
 * testable with no model and no network.
 */

/**
 * A capacity-bounded least-recently-used cache.
 *
 * A `Map`'s insertion order is the recency order: re-inserting the key on
 * every get/set keeps the oldest key at `keys().next().value`.
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
 * `run` only delays calling `fn` until a slot is free - no threads are
 * created - which is enough to bound `onnxruntime-node`'s CPU-bound
 * inference without knowing anything about it.
 *
 * @param max concurrent jobs; must be at least 1
 * @param onSaturated called when a job is queued because `max` are already
 *   active, with the active/queued counts right after that push. Whether the
 *   queueing is worth logging, and how often, is the caller's decision.
 * @returns `run`
 */
export function createLimiter(max: number, { onSaturated }: { onSaturated?: (info: { active: number; queued: number }) => void } = {}) {
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
      if (active >= max) onSaturated?.({ active, queued: queue.length });
      next();
    });
  };
}
