/**
 * Per-request logging and the in-process counters `/api/metrics` reports:
 * requests and 5xx responses by route, `/api/search` latency percentiles,
 * and client error reports. This is the "is it up but broken" half of
 * observability; `/api/health` is the "is it up" half.
 *
 * Everything is in memory and resets on restart. Nothing per-visitor is
 * kept: a request log line carries method, route, path, status and
 * duration, never the address or the query string (a search's terms live
 * in the query string).
 *
 * Counters are keyed by route pattern (`/api/favorites/:file`), never by raw
 * path, so a spray of unknown urls lands in one `UNMATCHED_ROUTE` bucket
 * instead of growing the map. `routeLabel` owns the mapping.
 */
import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger.ts';

/** The counter key for a request no route or static mount answered. */
export const UNMATCHED_ROUTE = '(unmatched)';

/** The counter key for a file `publicDir`'s root static mount served. */
export const STATIC_ROUTE = '(static)';

/** How many recent `/api/search` durations the percentiles are taken over. */
const SEARCH_SAMPLES = 1000;

/**
 * Static mounts whose requests are counted but logged at `debug`: one map
 * view fetches dozens of tiles, and an `info` line each would bury every
 * other entry in the log viewer.
 */
const QUIET_PREFIXES = ['/images/', '/shared/'];
const QUIET_ROUTES = new Set(['/bundle.js', '/style.css', '/favicon.ico', STATIC_ROUTE]);

export interface RouteCounts {
  count: number;
  serverErrors: number;
}

export interface RequestStatsSnapshot {
  requests: { total: number; serverErrors: number; byRoute: Record<string, RouteCounts> };
  search: { samples: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null };
  clientErrors: number;
}

export type RequestStats = ReturnType<typeof createRequestStats>;

export function createRequestStats() {
  const byRoute = new Map<string, RouteCounts>();
  // A ring buffer: `searchCount` keeps rising, and slot `searchCount % SEARCH_SAMPLES` is the oldest.
  const searchMs = new Float64Array(SEARCH_SAMPLES);
  let searchCount = 0;
  let clientErrors = 0;

  return {
    record(route: string, status: number, ms: number) {
      const counts = byRoute.get(route) ?? { count: 0, serverErrors: 0 };
      counts.count++;
      if (status >= 500) counts.serverErrors++;
      byRoute.set(route, counts);
      if (route === '/api/search') searchMs[searchCount++ % SEARCH_SAMPLES] = ms;
    },
    recordClientError() {
      clientErrors++;
    },
    snapshot(): RequestStatsSnapshot {
      let total = 0;
      let serverErrors = 0;
      for (const c of byRoute.values()) {
        total += c.count;
        serverErrors += c.serverErrors;
      }
      const samples = Array.from(searchMs.subarray(0, Math.min(searchCount, SEARCH_SAMPLES))).sort((a, b) => a - b);
      return {
        requests: { total, serverErrors, byRoute: Object.fromEntries([...byRoute].map(([k, v]) => [k, { ...v }])) },
        search: {
          samples: samples.length,
          p50Ms: percentile(samples, 0.5),
          p95Ms: percentile(samples, 0.95),
          p99Ms: percentile(samples, 0.99),
        },
        clientErrors,
      };
    },
  };
}

/** Nearest-rank percentile of an ascending array, rounded to 0.1 ms; null when empty. */
export function percentile(sorted: ArrayLike<number>, p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[rank] * 10) / 10;
}

/**
 * The counter key for a finished request: the matched route's pattern, a
 * static mount's prefix (`/images/*`), `STATIC_ROUTE`, or `UNMATCHED_ROUTE`.
 *
 * `req.route` is set only once a route handler ran. A request without one
 * was answered by a static mount or by nobody: the `/images` and `/shared`
 * mounts are recognised by path, and any other success came from the
 * `publicDir` root mount.
 */
export function routeLabel(req: Request, status: number): string {
  if (req.route?.path) return `${req.baseUrl}${req.route.path}`;
  const path = req.originalUrl.split('?')[0];
  for (const prefix of QUIET_PREFIXES) if (path.startsWith(prefix)) return `${prefix}*`;
  return status < 400 ? STATIC_ROUTE : UNMATCHED_ROUTE;
}

/**
 * Express middleware: one log line and one `stats` record per finished
 * response. Mount it first, so its `finish` listener sees every request,
 * including the ones a static mount or the error handler answers.
 *
 * A 5xx logs at `warn` (the error handler has already logged the cause at
 * `error`), a static asset at `debug`, everything else at `info`.
 */
export function requestLog(stats: RequestStats) {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = routeLabel(req, res.statusCode);
      stats.record(route, res.statusCode, ms);
      const path = req.originalUrl.split('?')[0];
      const fields = { method: req.method, route, path, status: res.statusCode, ms: Math.round(ms * 10) / 10 };
      if (res.statusCode >= 500) logger.warn(fields, 'request failed');
      else if (QUIET_ROUTES.has(route) || route.endsWith('/*')) logger.debug(fields, 'request');
      else logger.info(fields, 'request');
    });
    next();
  };
}
