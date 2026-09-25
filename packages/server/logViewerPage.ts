/**
 * The admin log viewer served at `/admin/logs` (`app.ts`) - a small,
 * self-contained HTML page, not part of `index.html`/`bundle.js`. It has
 * nothing to do with the map app (no `<base href>`, no SSR-body-into-`#root`
 * pattern) and isn't meant to be crawled or linked from it, so it gets its
 * own document rather than routing through `renderPage`.
 *
 * Server-rendered on every request (so it works with no JS at all - reload
 * the page to see new entries), and progressively enhanced with a small
 * inline script that polls `/admin/logs/fragment` (this module's own
 * `renderEntryList`, the same markup the initial page embeds) and replaces
 * just the entry list, for a live tail without a full-page reload. The
 * browser's cached Basic Auth credentials (from the initial page load) are
 * sent automatically on that fetch, so there's no separate auth handling to
 * write here.
 */
import { LOG_LEVEL_NAMES } from './log-levels.ts';
import type { LogEntry, RawLogEntry } from './log-reader.ts';

export interface LogViewerPageOptions {
  entries: (LogEntry | RawLogEntry)[];
  /** the `minLevel` this page was requested with, for the level `<select>`'s selected option */
  minLevel: number;
  /** the `limit` this page was requested with, for the limit `<input>`'s value */
  limit: number;
}

/** Escapes text for use inside HTML content or a double-quoted attribute. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FIELD_KEYS_TO_HIDE = new Set(['time', 'level', 'msg', 'pid', 'hostname', 'raw']);

/** One entry's non-standard fields (a room id, a query, an err object, ...) as `key=value ...`. */
function extraFields(entry: LogEntry): string {
  return Object.entries(entry)
    .filter(([key]) => !FIELD_KEYS_TO_HIDE.has(key))
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}

function renderEntry(entry: LogEntry | RawLogEntry): string {
  // `'raw' in entry` alone doesn't narrow the union: LogEntry's own index
  // signature makes `entry.raw` typecheck (as `unknown`) on that branch too.
  if ('raw' in entry) {
    const raw = (entry as RawLogEntry).raw;
    return `<li class="entry level-unknown"><span class="msg">${escapeHtml(raw)}</span></li>`;
  }
  const levelName = LOG_LEVEL_NAMES[entry.level ?? 0] ?? String(entry.level ?? '?');
  const time = typeof entry.time === 'number' ? new Date(entry.time).toISOString() : '';
  const extra = extraFields(entry);
  return (
    `<li class="entry level-${escapeHtml(levelName)}">` +
    `<span class="time">${escapeHtml(time)}</span>` +
    `<span class="level">${escapeHtml(levelName)}</span>` +
    `<span class="msg">${escapeHtml(entry.msg ?? '')}</span>` +
    (extra ? `<span class="fields">${escapeHtml(extra)}</span>` : '') +
    `</li>`
  );
}

/** The `<ul>` of entries alone - what the polling script above swaps in on each refresh, and what this module's own page embeds on first render. */
export function renderEntryList(entries: (LogEntry | RawLogEntry)[]): string {
  // Newest last in the file, but a log a reader is tailing wants the newest
  // entry closest to where their eye already is - at the top on a page that
  // doesn't otherwise scroll to the bottom on refresh.
  return `<ul id="entries">${[...entries].reverse().map(renderEntry).join('')}</ul>`;
}

export function renderLogViewerPage({ entries, minLevel, limit }: LogViewerPageOptions): string {
  const levelOptions = Object.entries(LOG_LEVEL_NAMES)
    .map(
      ([value, name]) =>
        `<option value="${value}"${Number(value) === minLevel ? ' selected' : ''}>${escapeHtml(name)}+</option>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>babel-index logs</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; margin: 0; padding: 0.75rem; }
  form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.75rem; }
  input[type="number"] { width: 5rem; }
  ul#entries { list-style: none; margin: 0; padding: 0; }
  .entry { display: flex; gap: 0.5rem; flex-wrap: wrap; padding: 0.25rem 0; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  .time { opacity: 0.6; white-space: nowrap; }
  .level { font-weight: bold; text-transform: uppercase; white-space: nowrap; }
  .level-error, .level-fatal { color: #d33; }
  .level-warn { color: #b58900; }
  .fields { opacity: 0.7; width: 100%; word-break: break-word; }
  #status { opacity: 0.6; margin-left: auto; }
</style>
</head>
<body>
<form id="controls" method="get">
  <label>min level <select name="minLevel">${levelOptions}</select></label>
  <label>lines <input type="number" name="limit" value="${limit}" min="1" max="5000"></label>
  <button type="submit">reload</button>
  <label><input type="checkbox" id="autoRefresh" checked> auto-refresh</label>
  <span id="status"></span>
</form>
${renderEntryList(entries)}
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var status = document.getElementById('status');
  var autoRefresh = document.getElementById('autoRefresh');
  var timer = null;

  // The fragment route returns this page's own <ul id="entries"> markup
  // (logViewerPage.ts's renderEntryList), so one HTML renderer serves both
  // the first paint and every refresh.
  function refresh() {
    var url = 'logs/fragment?' + new URLSearchParams({
      minLevel: params.get('minLevel') || '0',
      limit: params.get('limit') || '${limit}',
    });
    fetch(url)
      .then(function (res) { return res.text(); })
      .then(function (html) {
        document.getElementById('entries').outerHTML = html;
        status.textContent = 'updated ' + new Date().toLocaleTimeString();
      })
      .catch(function () { status.textContent = 'refresh failed'; });
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    if (autoRefresh.checked) timer = setTimeout(function () { refresh(); schedule(); }, 5000);
  }
  autoRefresh.addEventListener('change', schedule);
  schedule();
})();
</script>
</body>
</html>`;
}
