/**
 * Reduce a source file to a canonical, comment-free form.
 *
 * This is the code-preservation gate for the comment-refactor passes (see
 * `docs/comment-refactor-plan.md`). Two versions of a file are compared by their
 * `strip()` output: equal means every non-comment byte - types included - is
 * unchanged, so a comment-only edit is invisible while any accidental code edit
 * shows up as a real diff.
 *
 * JS/TS goes through the classic TypeScript parser, aliased in `package.json`
 * as `typescript-classic` (the project's own `typescript` is the v7 native
 * port, which erases types and is what the esbuild-based trick relied on).
 * Parsing with the real language service is what gets regex-vs-division,
 * template `${}` substitutions and JSX text right - all of which a hand-rolled
 * lexer gets wrong, and reprinting from the AST also means incidental
 * whitespace never masquerades as a code change.
 *
 * CSS and HTML have no such parser here - `stripCss`/`stripHtml` are a
 * hand-rolled scan instead, safe only because both languages' comment
 * delimiters (slash-star...star-slash, `<!-- -->`) are unambiguous outside a
 * string, unlike JS's `/` (division vs. regex vs. comment). They track string/attribute
 * quotes so a comment-like sequence inside one is left alone, then collapse
 * whitespace runs outside strings to one space - the closest a scan-only
 * approach gets to the printer's canonical reformatting, so a comment edit
 * that shifts surrounding blank lines still reads as comment-only. Neither
 * function walks into a nested language: `stripHtml` gained no `<script>`/
 * `<style>` handling because `index.html` (the only file it runs on) embeds
 * neither, so a comment delimiter belonging to JS or CSS inside one would be
 * misread as HTML's own - a real gap if a second HTML file ever does embed one.
 */
import ts from 'typescript-classic';

const SCRIPT_KIND = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
};

/**
 * Collapses whitespace runs to one space across `code`-tagged segments, leaves
 * `str` segments untouched, then trims the joined result. Adjacent `code`
 * segments are merged before collapsing - a comment sitting between two
 * whitespace runs otherwise leaves them uncollapsed against each other.
 */
function collapseSegments(segments) {
  const merged = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (s.type === 'code' && last?.type === 'code') last.text += s.text;
    else merged.push({ ...s });
  }
  return merged.map((s) => (s.type === 'str' ? s.text : s.text.replace(/\s+/g, ' '))).join('').trim();
}

/**
 * Scans `src` for quoted strings (respecting `\`-escapes) so a caller can
 * skip comment detection inside one; `onCode(ch, i)` runs for every index
 * not inside a string and returns how many characters it consumed (0 to
 * leave `i` for the string scan to consider).
 *
 * @throws if a string is never closed.
 */
function scanWithStrings(src, path, onCode) {
  const segments = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) throw new Error(`${path}: unterminated string starting at index ${i}`);
      segments.push({ type: 'str', text: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    const consumed = onCode(src, i);
    if (consumed === 0) {
      segments.push({ type: 'code', text: ch });
      i++;
    } else {
      i += consumed;
    }
  }
  return segments;
}

/** CSS block comments removed outside strings; see this file's doc for why a scan is safe here. */
function stripCss(src, path) {
  const segments = scanWithStrings(src, path, (s, i) => {
    if (s[i] !== '/' || s[i + 1] !== '*') return 0;
    const end = s.indexOf('*/', i + 2);
    if (end === -1) throw new Error(`${path}: unterminated comment starting at index ${i}`);
    return end + 2 - i;
  });
  return collapseSegments(segments);
}

/** `<!-- ... -->` removed outside attribute-value strings; see this file's doc for the no-embedded-`<script>`/`<style>` caveat. */
function stripHtml(src, path) {
  const segments = scanWithStrings(src, path, (s, i) => {
    if (!s.startsWith('<!--', i)) return 0;
    const end = s.indexOf('-->', i + 4);
    if (end === -1) throw new Error(`${path}: unterminated comment starting at index ${i}`);
    return end + 3 - i;
  });
  return collapseSegments(segments);
}

/**
 * Reduce `src` to a comment-free canonical form for comparison. JS/TS is
 * parsed and reprinted (see this file's doc); `.css`/`.html` fall back to
 * `stripCss`/`stripHtml`.
 *
 * @throws if `src` does not parse cleanly - a comment edit that breaks syntax
 *   should fail loudly here rather than produce a misleading comparison.
 */
export function strip(src, path) {
  const ext = path.slice(path.lastIndexOf('.'));
  if (ext === '.css') return stripCss(src, path);
  if (ext === '.html') return stripHtml(src, path);
  const kind = SCRIPT_KIND[ext] ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
  // parseDiagnostics is populated by createSourceFile but marked @internal, so
  // it's absent from the public .d.ts despite existing on the real object.
  const parseDiagnostics = /** @type {{ parseDiagnostics?: ts.DiagnosticWithLocation[] }} */ (sf).parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length) {
    const first = parseDiagnostics[0];
    const { line } = sf.getLineAndCharacterOfPosition(first.start);
    throw new Error(`${path}: does not parse (line ${line + 1}): ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`);
  }
  return ts.createPrinter({ removeComments: true }).printFile(sf);
}

/** True when the two sources differ in anything but comments. */
export function codeChanged(before, after, path) {
  return strip(before, path) !== strip(after, path);
}
