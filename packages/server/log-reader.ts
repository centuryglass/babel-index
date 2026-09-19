/**
 * Reads back what `log-file.ts`'s rotating destination has written, for the
 * admin log viewer (`app.ts`'s `/api/logs` and `/admin/logs`).
 *
 * Both files (current + the one rotation) are read whole into memory on
 * every request rather than tailed incrementally - `log-file.ts` caps each
 * at `maxBytes`, so a request costs reading at most twice that, which is
 * cheap enough not to need anything cleverer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { rotatedPath } from './log-file.ts';

/** How many entries `/api/logs` returns with no `limit` query param. */
export const DEFAULT_LOGS_LIMIT = 500;
/** The most a caller may ask for in one request - bounds the response size regardless of what's on disk. */
export const MAX_LOGS_LIMIT = 5_000;

/** One pino log line, parsed. `level` is pino's numeric scale (10 trace .. 60 fatal). */
export interface LogEntry {
  time?: number;
  level?: number;
  msg?: string;
  [key: string]: unknown;
}

/** A line that didn't parse as JSON - a partial write caught mid-append, or something non-pino wrote to the file. Kept rather than dropped, so nothing silently vanishes from the view. */
export interface RawLogEntry {
  raw: string;
}

export interface ReadLogsOptions {
  /** the current log file - the same path `logger.ts`'s rotating stream writes to */
  path: string;
  /** how many of the most recent entries to return, oldest first */
  limit?: number;
  /** keep only entries at or above this pino level; entries whose level can't be read (RawLogEntry) always pass */
  minLevel?: number;
}

/**
 * The last `limit` entries across the current file and its one rotated
 * predecessor, oldest first - the same order `tail -n` reads in.
 */
export function readRecentLogs({ path, limit = DEFAULT_LOGS_LIMIT, minLevel }: ReadLogsOptions): (LogEntry | RawLogEntry)[] {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_LOGS_LIMIT));
  const lines = [...readLines(rotatedPath(path)), ...readLines(path)];
  const entries = lines.map(parseLine);
  const filtered =
    minLevel === undefined ? entries : entries.filter((e) => 'raw' in e || (e.level ?? 0) >= minLevel);
  return filtered.slice(-boundedLimit);
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

function parseLine(line: string): LogEntry | RawLogEntry {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? (parsed as LogEntry) : { raw: line };
  } catch {
    return { raw: line };
  }
}
