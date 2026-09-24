/**
 * Hourly, privacy-preserving usage counts: unique visitors, searches, and
 * favorite adds/removes, logged through `logger.ts` on the wall-clock hour.
 * Nothing here is written to disk, and no per-visitor data survives a
 * flush.
 *
 * A visitor is remembered only as `HMAC(hourlySalt, ip)` in the current
 * hour's in-memory `Set` - the same shape `favorites.ts` uses to make a hash
 * useless as an identity list. Unlike `favorites.ts`'s salt, which persists
 * so counts survive a restart, this salt is thrown away and regenerated on
 * every flush. Only a per-hour size is needed, and a persistent salt would
 * let an operator correlate one visitor's hash across log lines.
 *
 * An hour where every count is zero is not logged at all.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { logger } from './logger.ts';

const HOUR_MS = 60 * 60 * 1000;

/** Same reasoning as favorites.ts's `HASH_CHARS`: far past collision range
 *  for one hour's worth of visitors, and short log lines read better. */
const HASH_CHARS = 16;

export interface UsageMetrics {
  /** Count one page load from this address toward the current hour's unique-visitor set. */
  recordVisit(ip: string): void;
  recordSearch(): void;
  recordFavoriteAdd(): void;
  recordFavoriteRemove(): void;
  /** Log the current hour's counts (skipped if every one is zero) and start
   *  a fresh hour. Exposed so a test can trigger it without waiting on the
   *  clock. */
  flush(): void;
  /** Cancel the hourly timer. A partial hour is simply lost, the same as any
   *  other in-memory-only counter on shutdown. */
  stop(): void;
}

export interface UsageMetricsOptions {
  /** where a flushed line goes - defaults to `logger.info`, overridable so a test can capture it without reading the real logger */
  log?: (fields: Record<string, number>) => void;
  /** clock override for tests; production never sets this */
  now?: () => number;
}

export function createUsageMetrics({ log = defaultLog, now = Date.now }: UsageMetricsOptions = {}): UsageMetrics {
  let salt = randomBytes(16).toString('hex');
  let visitors = new Set<string>();
  let searches = 0;
  let favoriteAdds = 0;
  let favoriteRemoves = 0;

  const hash = (ip: string) => createHmac('sha256', salt).update(ip).digest('hex').slice(0, HASH_CHARS);

  const flush = () => {
    if (visitors.size || searches || favoriteAdds || favoriteRemoves)
      log({ visitors: visitors.size, searches, favoriteAdds, favoriteRemoves });
    salt = randomBytes(16).toString('hex');
    visitors = new Set();
    searches = 0;
    favoriteAdds = 0;
    favoriteRemoves = 0;
  };

  // Aligned to the wall-clock hour, not just every HOUR_MS from process
  // start - a demo restarted at 2:17 still flushes at 3:00. The delay is
  // recomputed from `now()` on every reschedule, so it stays pinned to the
  // hour without drifting by however long the previous flush took.
  let timer: NodeJS.Timeout;
  const scheduleNext = () => {
    timer = setTimeout(() => {
      flush();
      scheduleNext();
    }, msUntilNextHour(now()));
    // Never hold the process open for a pending hour - same reasoning as
    // favorites.ts's debounce timer.
    timer.unref?.();
  };
  scheduleNext();

  return {
    recordVisit(ip) {
      if (ip) visitors.add(hash(ip));
    },
    recordSearch() {
      searches++;
    },
    recordFavoriteAdd() {
      favoriteAdds++;
    },
    recordFavoriteRemove() {
      favoriteRemoves++;
    },
    flush,
    stop() {
      clearTimeout(timer);
    },
  };
}

function defaultLog(fields: Record<string, number>) {
  logger.info(fields, 'hourly usage metrics');
}

/** Milliseconds until the next wall-clock hour boundary after `now`. */
export function msUntilNextHour(now = Date.now()): number {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setTime(next.getTime() + HOUR_MS);
  return next.getTime() - now;
}
