/**
 * HTTP Basic Auth for the one operator, guarding the admin routes (currently
 * only `/api/logs`/`/admin/logs`). `ADMIN_PASSWORD_HASH` holds `salt:hash`
 * (both hex, from `scryptSync`) - `hashPassword` below is what
 * `tools/hash-admin-password` calls to produce it; the plaintext password is
 * never written anywhere, including this env var. There is one
 * operator, so the Basic Auth username is read but never checked.
 *
 * `requireAdminAuth` rate-limits on `req.ip` via `rate-buckets.ts`. Every
 * request spends a token, right password or wrong, so this bounds guesses
 * per address. Behind a reverse proxy it needs `--trust-proxy` (see
 * index.ts), or every visitor shares the proxy's bucket.
 *
 * `verifyPassword` must stay on async `scrypt`: `scryptSync` on a request
 * path blocks every other request for each hash, and the rate limit can't
 * prevent that, since it is per address and a distributed burst gets a
 * fresh budget per address. `hashPassword` is sync because only the
 * `tools/hash-admin-password` CLI calls it.
 *
 * Every attempt is logged (`ip`, path, outcome), never the attempted
 * password. Rate-limited and wrong-password attempts log at `warn`, a
 * successful login at `info`, so the log viewer's level filter separates
 * logins from hammering.
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
 * `buckets` is injectable so a test can exhaust a burst without waiting on
 * a burst's worth of real `scrypt` calls, which can outlast one refill
 * window under load and make the test flaky.
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
