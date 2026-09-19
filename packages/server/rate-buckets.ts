/**
 * Token buckets, one per key, for throttling how fast one caller can hit an
 * endpoint. Shared by `app.ts`'s favorite writes (keyed on `req.ip`, per
 * AGENTS.md's "Favorites") and `admin-auth.ts`'s login attempts (also
 * `req.ip` - the one thing an attacker can't mint a fresh one of for free,
 * unlike a header). In memory and never persisted: a restart forgets
 * everyone, and no record of who asked for what is kept.
 */
const RATE_BURST = 20;
const RATE_REFILL_MS = 1000;
const RATE_MAX_TRACKED = 10_000;

export type RateBuckets = ReturnType<typeof createRateBuckets>;

export function createRateBuckets({ burst = RATE_BURST, refillMs = RATE_REFILL_MS } = {}) {
  const seen = new Map<string, { tokens: number; at: number }>();
  return {
    /** @returns whether this key may spend a token now */
    take(key: string): boolean {
      const now = Date.now();
      // Bounded so a spray of forged keys (or an honest crowd) cannot grow
      // this map without limit. Oldest-first, which is a Map's own iteration
      // order here since every touch rewrites its entry at the end.
      if (seen.size >= RATE_MAX_TRACKED && !seen.has(key)) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      const entry = seen.get(key) ?? { tokens: burst, at: now };
      entry.tokens = Math.min(burst, entry.tokens + (now - entry.at) / refillMs);
      entry.at = now;
      const allowed = entry.tokens >= 1;
      if (allowed) entry.tokens -= 1;
      seen.delete(key);
      seen.set(key, entry);
      return allowed;
    },
  };
}
