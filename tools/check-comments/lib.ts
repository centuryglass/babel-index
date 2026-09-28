/**
 * The pure half of `check:comments`: extracting the prose a reader sees
 * (comments in code, text in markdown) and checking it against the
 * mechanical rules in `AGENTS.md`, "Comments and docs".
 *
 * Split from `index.ts` the same way `check-requirements/lib.ts` is, so the
 * rules can be asserted against fixture strings without a git checkout.
 *
 * Every extractor returns a string the same length as its input, with
 * everything that is not prose blanked to spaces and newlines kept. Offsets
 * in the prose are offsets in the file, so a finding's line number needs no
 * mapping, and a pattern may wrap across comment lines because the comment
 * markers between them are blanked too. A line of blanked code is
 * whitespace-only, which is what stops a pattern running from one comment
 * into the next (see `BREAK`).
 */
import ts from 'typescript';

/** How a finding affects the exit code: `fail` counts against the baseline, `warn` never fails. */
export type Severity = 'fail' | 'warn';

export type Rule = 'pointer' | 'em-dash' | 'conviction' | 'ghost' | 'closed-issue';

export const SEVERITY: Record<Rule, Severity> = {
  pointer: 'fail',
  'em-dash': 'fail',
  conviction: 'fail',
  ghost: 'warn',
  'closed-issue': 'warn',
};

export interface Finding {
  rule: Rule;
  line: number;
  /** what was matched, as written */
  match: string;
  /** why it is a finding, for the report */
  message: string;
}

/**
 * Words the style rules ban from comments and docs. Each entry is a regex
 * source matched case-insensitively on word boundaries; a new agent quirk is
 * a new entry here.
 */
export const CONVICTION_WORDS = [
  'deliberately',
  'load-bearing',
  'on purpose',
  'the whole reason',
  'exactly',
  'really',
];

/**
 * Words that usually mark a ghost: prose about a prior state of the code.
 * Legitimate uses exist (a redirect, a permanent alias), so these warn.
 *
 * "rather than" and "instead of" are on `AGENTS.md`'s sweep list but not
 * here: most of their uses in the tree describe a present-tense choice, and
 * a warning that fires hundreds of times is one nobody reads.
 */
export const GHOST_WORDS = ['used to', 'no longer', 'previously', 'anymore', 'was migrated'];

/** A blank line, or a line of blanked code: where a wrapped pattern must stop. */
const BREAK = /\n[ \t]*\n/;

const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

function blankRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) if (chars[i] !== '\n') chars[i] = ' ';
}

/**
 * Keeps only what sits between comment delimiters in `masked`, whose string
 * and regex literals are already blanked. The delimiters themselves go, and
 * so does the ` * ` that opens each line of a block comment.
 */
function keepComments(masked: string, opts: { lineComments: boolean }): string {
  const out = blank(masked).split('');
  let i = 0;
  while (i < masked.length) {
    const line = opts.lineComments && masked.startsWith('//', i);
    if (!line && !masked.startsWith('/*', i)) {
      i++;
      continue;
    }
    let end = masked.indexOf(line ? '\n' : '*/', i + 2);
    if (end === -1) end = masked.length;
    let k = i + 2;
    while (masked[k] === (line ? '/' : '*')) k++;
    let lineStart = false;
    for (; k < end; k++) {
      const c = masked[k];
      if (c === '\n') lineStart = true;
      else if (lineStart && c === '*') {
        lineStart = false;
        continue;
      } else if (c !== ' ' && c !== '\t') lineStart = false;
      out[k] = c;
    }
    i = line ? end : end + 2;
  }
  return out.join('');
}

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
]);

/**
 * The comments in a TypeScript or JavaScript file, as prose.
 *
 * Literals come from the parse tree, since a string, template or regex can
 * hold `//` or an em dash and a user-facing string is not a comment. With
 * every literal blanked, the only `//` and `/*` left open comments.
 */
export function codeProse(source: string, fileName: string): string {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const chars = source.split('');
  const visit = (node: ts.Node): void => {
    if (LITERAL_KINDS.has(node.kind)) blankRange(chars, node.getStart(sf), node.end);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keepComments(chars.join(''), { lineComments: true });
}

/** The comments in a stylesheet, as prose. Quoted strings are blanked first. */
export function cssProse(source: string): string {
  const masked = source.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, blank);
  return keepComments(masked, { lineComments: false });
}

/** A markdown file as prose: everything but fenced code blocks. */
export function markdownProse(source: string): string {
  return source.replace(/^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, blank);
}

/** Blanks inline code spans: they name code, and the word rules read only prose. */
export function withoutCodeSpans(prose: string): string {
  return prose.replace(/`[^`]+`/g, (span) => (BREAK.test(span) ? span : blank(span)));
}

/** A line-number lookup that is cheap to call once per finding. */
function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The space between two words of a phrase: at most one line break, never a `BREAK`. */
const WORD_GAP = '(?:[ \\t]+|[ \\t]*\\n[ \\t]*)';

/**
 * A word list as one regex. A word written as a mention (`"exactly"`,
 * `'on purpose'`) is not a use of it, so a match with a quote on both sides
 * is skipped by the caller.
 */
function wordRegex(words: string[]): RegExp {
  const alternatives = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, WORD_GAP));
  return new RegExp(`(?<![\\w-])(?:${alternatives.join('|')})(?![\\w-])`, 'gi');
}

const CONVICTION_RE = wordRegex(CONVICTION_WORDS);
const GHOST_RE = wordRegex(GHOST_WORDS);
const QUOTES = new Set(['"', "'", '\u201c', '\u201d', '\u2018', '\u2019']);

function wordFindings(prose: string, re: RegExp, rule: Rule, line: (o: number) => number): Finding[] {
  const out: Finding[] = [];
  for (const m of prose.matchAll(re)) {
    const before = prose[m.index - 1];
    const after = prose[m.index + m[0].length];
    if (QUOTES.has(before) && QUOTES.has(after)) continue;
    const word = collapse(m[0]);
    out.push({
      rule,
      line: line(m.index),
      match: word,
      message: rule === 'conviction' ? `conviction word "${word}"` : `possible ghost "${word}"`,
    });
  }
  return out;
}

/**
 * What a pointer can resolve against. `index.ts` builds it from
 * `git ls-files`; tests build it by hand.
 */
export interface Repo {
  /** tracked files, repo-root-relative */
  files: Set<string>;
  /** every directory holding a tracked file, repo-root-relative, no trailing slash */
  dirs: Set<string>;
  /** whether `.gitignore` covers a repo-root-relative path */
  ignored: (path: string) => boolean;
  /** the headings and bold lead phrases of a tracked markdown file, normalized by `normalizePhrase` */
  anchors: (path: string) => Set<string>;
}

/** How a cited heading or bold phrase is compared: backticks, trailing punctuation, case and spacing ignored. */
export function normalizePhrase(s: string): string {
  return collapse(s.replace(/`/g, '')).replace(/[.:;,!?]+$/, '').toLowerCase();
}

/**
 * The headings and bold lead phrases a pointer into this markdown can cite.
 * Bold text may wrap lines, so whitespace is collapsed first.
 */
export function markdownAnchors(markdown: string): Set<string> {
  const out = new Set<string>();
  const prose = markdownProse(markdown);
  for (const m of prose.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) out.add(normalizePhrase(m[1]));
  for (const m of collapse(prose).matchAll(/\*\*(.+?)\*\*/g)) out.add(normalizePhrase(m[1]));
  return out;
}

/**
 * Whether a cited phrase names one of a file's anchors. A citation may give
 * only the start of a bold lead phrase (`"Two opening views"` for
 * `**Two opening views, and they are not interchangeable.**`), so a prefix
 * that ends on a word boundary counts.
 */
export function citesAnchor(anchors: Set<string>, cited: string): boolean {
  if (anchors.has(cited)) return true;
  for (const a of anchors) if (a.startsWith(cited) && /\W/.test(a[cited.length])) return true;
  return false;
}

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `a/b/../c` to `a/c`; null when it climbs out of the repo. */
function normalizePath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

/**
 * Where a path written in `from` points: the tracked path, `unchecked`, or
 * null for nowhere.
 *
 * Tried in order: repo-root-relative, relative to the citing file, then as
 * the tracked file or directory ending in that path. Comments name a
 * sibling by bare filename (`see board.ts`), and a bare name several files
 * share can't be checked without guessing which was meant, and neither can
 * a gitignored path (`config.json`, the issue cache), which exists only at
 * runtime. Both are `unchecked`.
 */
export function resolvePath(written: string, from: string, repo: Repo): string | 'unchecked' | null {
  const trimmed = written.replace(/\/$/, '');
  const exists = (p: string | null): p is string => p !== null && (repo.files.has(p) || repo.dirs.has(p));
  for (const candidate of [normalizePath(trimmed), normalizePath(`${dirOf(from)}/${trimmed}`)])
    if (exists(candidate)) return candidate;
  for (const candidate of [normalizePath(trimmed), normalizePath(`${dirOf(from)}/${trimmed}`)])
    if (candidate !== null && (repo.ignored(candidate) || repo.ignored(`${candidate}/`))) return 'unchecked';
  if (trimmed.startsWith('.')) return null;
  const suffix = `/${trimmed}`;
  const hits = new Set<string>();
  for (const p of repo.files) if (p.endsWith(suffix)) hits.add(p);
  for (const p of repo.dirs) if (p.endsWith(suffix)) hits.add(p);
  if (hits.size > 1) return 'unchecked';
  return hits.size === 1 ? [...hits][0] : null;
}

/** File extensions that make a slash-separated span a path. */
const PATH_EXTENSIONS = /\.(ts|tsx|mjs|js|md|json|css|html|yml|yaml|sh|svg|vert|frag|glsl|py|tf|txt|webmanifest)$/;

/**
 * File extensions that make a bare name (`board.ts`) a path. Source files
 * only: a bare `summary.json` or `bundle.js` is usually an output name,
 * which no tracked file backs.
 */
const BARE_EXTENSIONS = /\.(ts|tsx|mjs|md|css|yml|yaml|sh|py|tf|vert|frag|glsl)$/;

/**
 * The path a backticked span names, or null when the span is code.
 *
 * A bare name is a path when it has a source extension (`board.ts`). A
 * slash-separated span is one when it ends in a file extension
 * (`docs/api.md`) or starts at a tracked top-level directory
 * (`tools/embed`). That leaves out git refs (`origin/main`), routes and
 * system paths (a leading `/`), import specifiers (`./port.ts`), packages
 * (`@scope/name`), suffixes (`.e2e.ts`), and anything with a space, glob or
 * placeholder character (`*.e2e.ts`, `{name}.test.ts`), which includes a
 * whole citation in one span.
 */
export function pathInSpan(span: string, repo: Repo): string | null {
  const s = span.trim();
  if (!/^[\w.@/-]+$/.test(s) || /^(\/|@|\.\.?\/)/.test(s)) return null;
  const segments = s.replace(/\/$/, '').split('/');
  const last = segments[segments.length - 1];
  if (segments.length === 1) return BARE_EXTENSIONS.test(s) && !s.startsWith('.') ? s : null;
  if (PATH_EXTENSIONS.test(last)) return s;
  if (repo.dirs.has(segments[0])) return s;
  return null;
}

/** `docs/agents/rendering.md, "The WebGL renderer"`, `AGENTS.md's "Layout"`. */
const CITATION_RE = /([\w./-]*[\w-]\.md)`?(?:,|'s)\s+"([^"]+)"/g;

/** A relative markdown link target: `[text](../file.md#anchor)`. */
const MD_LINK_RE = /\]\(([^)\s]+)\)/g;

/** GitHub's heading anchor: lowercased, punctuation dropped, spaces to hyphens. */
export function githubSlug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\- ]/g, '')
    .replace(/ /g, '-');
}

function pointerFindings(
  prose: string,
  file: string,
  repo: Repo,
  opts: { markdown: boolean },
  line: (o: number) => number
): Finding[] {
  const out: Finding[] = [];

  for (const m of prose.matchAll(CITATION_RE)) {
    const [, written, phrase] = m;
    if (BREAK.test(phrase)) continue;
    const target = resolvePath(written, file, repo);
    if (!target) {
      out.push({ rule: 'pointer', line: line(m.index), match: written, message: `cites ${written}, which does not exist` });
      continue;
    }
    if (target === 'unchecked') continue;
    if (!citesAnchor(repo.anchors(target), normalizePhrase(phrase)))
      out.push({
        rule: 'pointer',
        line: line(m.index),
        match: `${written}, "${collapse(phrase)}"`,
        message: `${target} has no heading or bold phrase "${collapse(phrase)}"`,
      });
  }

  for (const m of prose.matchAll(/`([^`]+)`/g)) {
    const written = pathInSpan(m[1], repo);
    if (!written) continue;
    if (!resolvePath(written, file, repo))
      out.push({ rule: 'pointer', line: line(m.index), match: written, message: `names ${written}, which does not exist` });
  }

  if (opts.markdown)
    for (const m of prose.matchAll(MD_LINK_RE)) {
      const target = m[1];
      if (/^[a-z]+:|^#|^\//i.test(target)) continue;
      const [path, anchor] = target.split('#');
      const resolved = normalizePath(`${dirOf(file)}/${decodeURIComponent(path)}`);
      if (resolved === null || !(repo.files.has(resolved) || repo.dirs.has(resolved))) {
        out.push({ rule: 'pointer', line: line(m.index), match: target, message: `links ${path}, which does not exist` });
        continue;
      }
      if (anchor && resolved.endsWith('.md')) {
        const slugs = new Set([...repo.anchors(resolved)].map(githubSlug));
        if (!slugs.has(anchor.toLowerCase()))
          out.push({ rule: 'pointer', line: line(m.index), match: target, message: `${resolved} has no heading #${anchor}` });
      }
    }

  return out;
}

/** An issue citation: `#123`, not a CSS color or a URL fragment. */
const ISSUE_RE = /(?<![\w&/#-])#(\d{2,4})(?![\w-])/g;

export interface CheckInput {
  /** repo-root-relative path, which picks the extractor */
  file: string;
  source: string;
  repo: Repo;
  /** issue numbers known to be closed, when an issue cache is available */
  closedIssues?: Set<number>;
}

/** Which extractor a path takes, or null for a file this check doesn't read. */
export function kindOf(file: string): 'code' | 'css' | 'markdown' | null {
  if (/\.(ts|tsx|mts|mjs|js|jsx)$/.test(file)) return 'code';
  if (/\.css$/.test(file)) return 'css';
  if (/\.md$/.test(file)) return 'markdown';
  return null;
}

/** Every finding in one file, in line order. */
export function checkFile({ file, source, repo, closedIssues }: CheckInput): Finding[] {
  const kind = kindOf(file);
  if (!kind) return [];
  const prose = kind === 'code' ? codeProse(source, file) : kind === 'css' ? cssProse(source) : markdownProse(source);
  const words = withoutCodeSpans(prose);
  const line = lineIndex(source);

  const out: Finding[] = [
    ...pointerFindings(prose, file, repo, { markdown: kind === 'markdown' }, line),
    ...wordFindings(words, CONVICTION_RE, 'conviction', line),
    ...wordFindings(words, GHOST_RE, 'ghost', line),
  ];

  for (const m of words.matchAll(/\u2014/g))
    out.push({ rule: 'em-dash', line: line(m.index), match: '\u2014', message: 'em dash; use an ASCII hyphen' });

  if (closedIssues)
    for (const m of words.matchAll(ISSUE_RE))
      if (closedIssues.has(Number(m[1])))
        out.push({ rule: 'closed-issue', line: line(m.index), match: m[0], message: `cites ${m[0]}, which is closed` });

  return out.sort((a, b) => a.line - b.line);
}

/** Per file, per rule: how many failing findings are allowed to stand. */
export type Baseline = Record<string, Partial<Record<Rule, number>>>;

/** Failing findings counted the way the baseline stores them. */
export function tally(findingsByFile: Map<string, Finding[]>): Baseline {
  const out: Baseline = {};
  for (const [file, findings] of findingsByFile)
    for (const f of findings) {
      if (SEVERITY[f.rule] !== 'fail') continue;
      const counts = (out[file] ??= {});
      counts[f.rule] = (counts[f.rule] ?? 0) + 1;
    }
  return out;
}

export interface Verdict {
  ok: boolean;
  /** file and rule where the count rose above the baseline */
  regressions: { file: string; rule: Rule; count: number; allowed: number }[];
  /** file and rule where the count fell below it: the baseline can be lowered */
  stale: { file: string; rule: Rule; count: number; allowed: number }[];
}

/**
 * Compares counts against the baseline. A ratchet, like
 * `check-requirements`'s: more findings than allowed fails, fewer never
 * does and is reported so the baseline gets lowered.
 *
 * Counts, not line numbers, because an edit above a known finding moves it
 * without making it new.
 */
export function verdict(current: Baseline, baseline: Baseline): Verdict {
  const regressions: Verdict['regressions'] = [];
  const stale: Verdict['stale'] = [];
  const files = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const file of [...files].sort()) {
    const rules = new Set([...Object.keys(current[file] ?? {}), ...Object.keys(baseline[file] ?? {})]) as Set<Rule>;
    for (const rule of rules) {
      const count = current[file]?.[rule] ?? 0;
      const allowed = baseline[file]?.[rule] ?? 0;
      if (count > allowed) regressions.push({ file, rule, count, allowed });
      else if (count < allowed) stale.push({ file, rule, count, allowed });
    }
  }
  return { ok: regressions.length === 0, regressions, stale };
}

