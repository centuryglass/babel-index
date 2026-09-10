/**
 * mulberry32 - small, fast, seedable. Deterministic output matters here: the
 * base room must regenerate byte-identically so the seam mask stays aligned
 * with every asset derived from it.
 */

export interface Prng {
  (): number;
  range(lo: number, hi: number): number;
  int(lo: number, hi: number): number;
  pick<T>(arr: T[]): T;
  chance(p: number): boolean;
}

export function prng(seed: number): Prng {
  let a = seed >>> 0;
  const next = (() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Prng;
  next.range = (lo, hi) => lo + next() * (hi - lo);
  next.int = (lo, hi) => Math.floor(next.range(lo, hi + 1));
  next.pick = (arr) => arr[next.int(0, arr.length - 1)];
  next.chance = (p) => next() < p;
  return next;
}

/** Turn an arbitrary string into a 32-bit seed (FNV-1a). */
export function seedFrom(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
