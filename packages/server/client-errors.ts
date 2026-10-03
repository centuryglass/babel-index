/**
 * Validation for `POST /api/client-errors`, the browser's error beacon
 * (`packages/web/src/lib/errorReport.ts` sends it).
 *
 * The body is untrusted and lands in the log file, so every field is
 * type-checked and truncated, unknown fields are dropped, and a body that
 * is not an object with a string `message` is rejected. `url` loses its
 * query string and fragment, which can carry what a reader searched for.
 * The route that calls this (`app.ts`) owns the size cap and rate limit.
 */

/** The `kind` values the client sends; anything else is stored as `'other'`. */
export const CLIENT_ERROR_KINDS = ['error', 'unhandledrejection', 'render', 'webglcontextlost'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number] | 'other';

/** The renderer the reporting page was on (`webglFlag.ts`'s choice). */
export type ClientRenderer = 'gl' | 'canvas2d';

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  url?: string;
  renderer?: ClientRenderer;
}

/** Per-field character caps. The route's body-size limit is the outer bound. */
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_URL = 500;

/** The sanitized report, or null when `body` is not a usable report. */
export function parseClientError(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.message !== 'string' || !b.message) return null;
  const report: ClientErrorReport = {
    kind: (CLIENT_ERROR_KINDS as readonly unknown[]).includes(b.kind) ? (b.kind as ClientErrorKind) : 'other',
    message: b.message.slice(0, MAX_MESSAGE),
  };
  if (typeof b.stack === 'string' && b.stack) report.stack = b.stack.slice(0, MAX_STACK);
  if (typeof b.url === 'string' && b.url) report.url = b.url.split(/[?#]/)[0].slice(0, MAX_URL);
  if (b.renderer === 'gl' || b.renderer === 'canvas2d') report.renderer = b.renderer;
  return report;
}
