/**
 * A synchronous, size-capped file destination for `logger.ts`: appends every
 * write to `path`, and once the file reaches `maxBytes` renames it to
 * `rotatedPath(path)` (overwriting whatever was there) and starts fresh. At
 * most two files on disk, ever - `log-reader.ts` is what reads them back for
 * the admin log viewer (`app.ts`'s `/api/logs`).
 *
 * Synchronous by design: a write here is a handful of bytes on an already
 * logged line, not a hot path worth async buffering for.
 */
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';

/** Rotation threshold `logger.ts` falls back to when `LOG_FILE_MAX_BYTES` isn't set. */
export const DEFAULT_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Where a full file gets renamed to on rotation - the one place that name is decided. */
export function rotatedPath(path: string): string {
  return `${path}.1`;
}

export interface RotatingFileStream {
  /** pino calls this with one already-newline-terminated log line at a time. */
  write(chunk: string): void;
}

export function createRotatingFileStream(path: string, maxBytes = DEFAULT_LOG_FILE_MAX_BYTES): RotatingFileStream {
  let size = existsSync(path) ? statSync(path).size : 0;
  return {
    write(chunk: string) {
      appendFileSync(path, chunk);
      size += Buffer.byteLength(chunk);
      if (size < maxBytes) return;
      try {
        renameSync(path, rotatedPath(path));
      } catch {
        // Best-effort: a failed rename (e.g. the directory went away) just
        // means the file keeps growing past maxBytes rather than losing
        // anything already logged.
        return;
      }
      size = 0;
    },
  };
}
