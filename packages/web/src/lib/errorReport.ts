/**
 * The browser's error beacon: sends uncaught errors, unhandled rejections,
 * render crashes and lost WebGL contexts to `POST api/client-errors`
 * (`packages/server/client-errors.ts` validates them), where they land in the
 * server log beside its own errors.
 *
 * A report is deduplicated per page load by kind and message, and a page
 * sends at most `MAX_REPORTS`, so a failure inside the render loop costs one
 * request, not one per frame. `navigator.sendBeacon` carries it so a report
 * made while the page unloads still arrives; `fetch` with `keepalive` is the
 * fallback where sendBeacon is missing or refuses.
 *
 * The url sent is the page path without its query string or fragment, since
 * those can carry a search. Nothing identifying the reader is sent; the
 * server adds the user agent from the request.
 */

/** Matches `packages/server/client-errors.ts`'s `CLIENT_ERROR_KINDS`. */
export type ErrorKind = 'error' | 'unhandledrejection' | 'render' | 'webglcontextlost';

export interface ErrorReport {
  kind: ErrorKind;
  message: string;
  stack?: string;
  url?: string;
  renderer?: 'gl' | 'canvas2d';
}

/** Reports one page load sends at most, whatever their kind. */
export const MAX_REPORTS = 5;

/** Relative, like every url the client fetches (docs/agents/deploy.md, "Deployment and the base path"). */
const ENDPOINT = 'api/client-errors';

/**
 * A reporter with its own dedupe state. `send` is injectable so a test can
 * read what would go out; the module's default instance posts to `ENDPOINT`.
 */
export function createErrorReporter({ send = sendReport, renderer }: { send?: (body: string) => void; renderer?: ErrorReport['renderer'] } = {}) {
  const seen = new Set<string>();
  let currentRenderer = renderer;
  return {
    setRenderer(next: ErrorReport['renderer']) {
      currentRenderer = next;
    },
    report(kind: ErrorKind, error: unknown) {
      if (seen.size >= MAX_REPORTS) return;
      const { message, stack } = describe(error);
      const key = `${kind}\n${message}`;
      if (seen.has(key)) return;
      seen.add(key);
      const report: ErrorReport = { kind, message, stack, url: pagePath(), renderer: currentRenderer };
      try {
        send(JSON.stringify(report));
      } catch {
        // A report that cannot be sent is dropped; reporting must never throw into the page.
      }
    },
  };
}

/** A message and stack from whatever was thrown or rejected, which need not be an Error. */
export function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack };
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

function pagePath(): string | undefined {
  return typeof location === 'undefined' ? undefined : `${location.origin}${location.pathname}`;
}

function sendReport(body: string) {
  // text/plain keeps sendBeacon a simple request; the server parses any type as JSON.
  const blob = new Blob([body], { type: 'text/plain' });
  if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(ENDPOINT, blob)) return;
  void fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {});
}

/** The page's one reporter. `installErrorReporting` sets its renderer. */
export const errorReporter = createErrorReporter();

/**
 * Listens for uncaught errors and unhandled rejections on `window`, and
 * records which renderer this page load chose. `main.tsx` calls it once,
 * before the first render.
 */
export function installErrorReporting(renderer: ErrorReport['renderer']) {
  errorReporter.setRenderer(renderer);
  window.addEventListener('error', (e) => errorReporter.report('error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => errorReporter.report('unhandledrejection', e.reason));
}
