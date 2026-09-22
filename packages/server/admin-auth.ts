/**
 * HTTP Basic Auth for the one operator, guarding the admin routes (currently
 * only `/api/logs`/`/admin/logs`). `ADMIN_PASSWORD_HASH` holds `salt:hash`
 * (both hex, from `scryptSync`) - `hashPassword` below is what
 * `tools/hash-admin-password` calls to produce it; the plaintext password is
 * never written anywhere, including this env var. There is exactly one
 * operator, so the Basic Auth username is read but never checked - the
 * scheme requires one, this deployment has no use for it.
 *
 * `express-basic-auth` or similar would do this too, but the whole
 * implementation is the parse-header-and-timingSafeEqual below plus what
 * `node:crypto` already ships - not worth a dependency for.
 *
 * `requireAdminAuth` also rate-limits, on `req.ip` via `rate-buckets.ts` -
 * the same shape `app.ts` already uses for favorite writes. Every request
 * spends a token, whether the password turns out right or not, so this
 * bounds guesses per address rather than only reacting to wrong ones.
 * Behind a reverse proxy this needs `--trust-proxy` set (same caveat as
 * favorites - see index.ts), or every visitor shares the proxy's bucket.
 *
 * `verifyPassword` uses `scrypt`'s async (thread-pool) form, not
 * `scryptSync`: a burst of login attempts still costs the same CPU, but on
 * libuv's thread pool rather than blocking the process's one JS thread -
 * `scryptSync` here would stall every other request (image serving,
 * search, everything) for each hash's duration, which a rate limit alone
 * doesn't prevent during the burst before it trips (the bucket bounds *guesses per address*, not concurrent
 * *addresses*, so a distributed attacker gets a fresh burst per address).
 * `hashPassword` stays sync - it's `tools/hash-admin-password`'s one-off CLI
 * call, never on a request path, so blocking there is harmless.
 *
 * Every attempt is logged (`ip`, path, outcome) through the same `logger`
 * everything else writes through - so a real attack shows up in the log
 * file this module itself gates access to, not just as user-visible
 * slowness. Never the attempted password, right or wrong: that's worth
 * nothing operationally and is exactly the kind of thing that shouldn't
 * end up sitting in a log file. Rate-limited attempts log at `warn`
 * (this is the "someone is hammering the endpoint" signal, and the bucket
 * itself already caps how often it can fire); a wrong password also logs
 * at `warn`; a real login logs at `info`, so the level filter in the log
 * viewer can separate "did I get in" from "is something hammering this".
 */
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { createRateBuckets, type RateBuckets } from './rate-buckets.ts';
import { logger } from './logger.ts';

const SCRYPT_KEYLEN = 64;
const scryptAsync = promisify(scrypt);

/** `salt:hash`, both hex - what goes in `ADMIN_PASSWORD_HASH`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Whether `password` matches a hash `hashPassword` produced. Constant-time once both sides are hashed, so a wrong guess can't be timed against the stored value. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const sep = stored.indexOf(':');
  if (sep === -1) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (!salt.length || !expected.length) return false;
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return timingSafeEqual(actual, expected);
}

/** The password half of a `Basic <base64>` Authorization header, or null if the header is missing or malformed. */
function passwordFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  return sep === -1 ? decoded : decoded.slice(sep + 1);
}

/**
 * Express middleware: 401 with a `WWW-Authenticate` challenge unless the
 * request's Basic Auth password matches `passwordHash`, and 429 past
 * `rate-buckets.ts`'s per-address burst (this module's own header comment).
 * One bucket store per call, matching `app.ts`'s `favoriteBuckets` - the
 * caller (`app.ts`) builds this once and reuses it for every admin route,
 * so the three log-viewer routes share one budget rather than one each.
 *
 * `buckets` is injectable so a test can exhaust a burst without needing 20+
 * real `scrypt` calls to finish inside one refill window - the default
 * refill (1/second) leaves no margin against ~20 password hashes' own
 * wall-clock cost (thread-pool queuing included), which is what made the
 * shared default flaky under CI load.
 */
export function requireAdminAuth(passwordHash: string, buckets: RateBuckets = createRateBuckets()) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // req.ip is undefined only for a socket that has already gone away.
    const ip = req.ip ?? '';
    if (!buckets.take(ip)) {
      logger.warn({ ip, path: req.path }, 'admin auth rate-limited');
      return res.status(429).json({ error: 'too many attempts - try again in a moment' });
    }
    const password = passwordFromHeader(req.get('Authorization'));
    if (password !== null && (await verifyPassword(password, passwordHash))) {
      logger.info({ ip, path: req.path }, 'admin auth succeeded');
      return next();
    }
    // Never log `password` itself - a rejected guess is worth nothing
    // operationally, and logging it would just be storing credentials.
    logger.warn({ ip, path: req.path }, 'admin auth failed');
    res.set('WWW-Authenticate', 'Basic realm="babel-index admin", charset="UTF-8"');
    res.status(401).json({ error: 'authentication required' });
  };
}
