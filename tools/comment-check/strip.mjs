/**
 * Reduce JS/TS source to a canonical, comment-free form.
 *
 * This is the code-preservation gate for the comment-refactor passes (see
 * `docs/comment-refactor-plan.md`). Two versions of a file are compared by their
 * `strip()` output: equal means every non-comment byte - types included - is
 * unchanged, so a comment-only edit is invisible while any accidental code edit
 * shows up as a real diff.
 *
 * It uses the classic TypeScript parser, aliased in `package.json` as
 * `typescript-classic` (the project's own `typescript` is the v7 native port,
 * which erases types and is what the esbuild-based trick relied on). Parsing
 * with the real language service is what gets regex-vs-division, template
 * substitutions and JSX text right - all of which a hand-rolled lexer gets wrong.
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
 * Print `src` with comments removed and types preserved, in ts' canonical
 * formatting so incidental whitespace never masquerades as a code change.
 *
 * @throws if `src` does not parse cleanly - a comment edit that breaks syntax
 *   should fail loudly here rather than produce a misleading comparison.
 */
export function strip(src, path) {
  const kind = SCRIPT_KIND[path.slice(path.lastIndexOf('.'))] ?? ts.ScriptKind.TS;
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
