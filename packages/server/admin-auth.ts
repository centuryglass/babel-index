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
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SCRYPT_KEYLEN = 64;

/** `salt:hash`, both hex - what goes in `ADMIN_PASSWORD_HASH`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Whether `password` matches a hash `hashPassword` produced. Constant-time once both sides are hashed, so a wrong guess can't be timed against the stored value. */
export function verifyPassword(password: string, stored: string): boolean {
  const sep = stored.indexOf(':');
  if (sep === -1) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (!salt.length || !expected.length) return false;
  const actual = scryptSync(password, salt, expected.length);
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

/** Express middleware: 401 with a `WWW-Authenticate` challenge unless the request's Basic Auth password matches `passwordHash`. */
export function requireAdminAuth(passwordHash: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const password = passwordFromHeader(req.get('Authorization'));
    if (password !== null && verifyPassword(password, passwordHash)) return next();
    res.set('WWW-Authenticate', 'Basic realm="babel-index admin", charset="UTF-8"');
    res.status(401).json({ error: 'authentication required' });
  };
}
