/**
 * Assembles `/style.css` from `packages/web/style.css` and the partials it
 * imports, once per request, so the browser gets one sheet and editing a
 * partial needs only a refresh.
 *
 * The index names each partial on a line of its own, written as
 * `@import "<path>";` with the path relative to the index. That line is
 * replaced with the partial's text. A native `@import` reaching the browser
 * would add a blocking request and resolve the partial's relative `url()`s
 * against the partial's own path, so these throw:
 * - an `@import` written any other way (single quotes, `url()`, a media
 *   list);
 * - an `@import` inside a partial;
 * - a partial that does not exist.
 *
 * Nothing is cached, like the per-request read of `index.html`.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const IMPORT_LINE = /^@import "([^"]+)";$/;
const ANY_IMPORT = /^\s*@import\b/;

type ReadText = (path: string) => Promise<string>;

const readText: ReadText = (path) => readFile(path, 'utf8');

/** The partial paths `indexCss` imports, in order, as written. */
export function stylesheetImports(indexCss: string): string[] {
  const paths: string[] = [];
  for (const [n, line] of indexCss.split('\n').entries()) {
    const match = IMPORT_LINE.exec(line);
    if (match) paths.push(match[1]);
    else if (ANY_IMPORT.test(line))
      throw new Error(`style.css line ${n + 1}: write an import as a whole line, @import "<path>"; - got: ${line.trim()}`);
  }
  return paths;
}

/** `indexPath`'s text with each import line replaced by that partial's text. */
export async function assembleStylesheet(indexPath: string, read: ReadText = readText): Promise<string> {
  const index = await read(indexPath);
  stylesheetImports(index);
  const lines = index.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const match = IMPORT_LINE.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const path = resolve(dirname(indexPath), match[1]);
    let partial: string;
    try {
      partial = await read(path);
    } catch (err) {
      throw new Error(`style.css imports ${match[1]}, which could not be read: ${err.message}`, { cause: err });
    }
    const nested = partial.split('\n').findIndex((l) => ANY_IMPORT.test(l));
    if (nested >= 0) throw new Error(`${match[1]} line ${nested + 1}: a partial cannot import another file`);
    out.push(partial.endsWith('\n') ? partial.slice(0, -1) : partial);
  }
  return out.join('\n');
}
