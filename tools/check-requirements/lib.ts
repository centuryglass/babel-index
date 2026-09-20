/**
 * The pure half of `check:requirements`: parsing requirement ids out of the
 * requirements document, and coverage tags out of a test file.
 *
 * Split from `index.ts` the same way `check-file-map/lib.ts` is, so the
 * parsing rules can be asserted without a filesystem or a git checkout.
 *
 * The one rule this file encodes: references point from the volatile thing
 * to the stable one. A test names the requirement it covers; the
 * requirements document names no tests. Nothing has to be kept in sync
 * because the mapping is rebuilt from the test tree on every run.
 */

/** `SR-01`, as written in the requirements document and in a test's name. */
export const REQUIREMENT_ID = /^SR-\d{2}$/;

/** A tag inside a test name: `test('... [SR-18]', ...)`. */
const TAG_RE = /\[(SR-\d{2})\]/g;

/** A requirement's opening line: `- **SR-01** Search should ...`. */
const HEADING_RE = /^-\s+\*\*(SR-\d{2})\*\*\s*(.*)$/;

/**
 * A requirement judged rather than tested. Marked in the document itself so
 * the decision is reviewable in a diff, not buried in the checker.
 *
 * "Feels intuitively correct to users" has no assertion that would fail if
 * it stopped being true. Counting such a requirement as a permanent gap
 * would put the coverage ratchet out of reach forever, and marking it
 * covered would be a lie; this is the third answer.
 */
const JUDGED_RE = /_\(judged\)_\s*$/;

export interface Requirement {
  id: string;
  /** the requirement's own text, whitespace collapsed */
  text: string;
  /** judged rather than mechanically testable - see `JUDGED_RE` */
  judged: boolean;
}

/**
 * Every requirement in the document, in the order it appears.
 *
 * A requirement is a top-level list item opening with a bolded id. Wrapped
 * continuation lines are folded into the text; anything else (prose,
 * headings, blank lines) ends the current item.
 *
 * @param markdown the requirements document's contents
 * @throws RangeError on a duplicate id, which would make coverage ambiguous
 */
export function parseRequirements(markdown: string): Requirement[] {
  const out: Requirement[] = [];
  const seen = new Set<string>();
  let current: { id: string; parts: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const text = current.parts.join(' ').replace(/\s+/g, ' ').trim();
    out.push({ id: current.id, text: text.replace(JUDGED_RE, '').trim(), judged: JUDGED_RE.test(text) });
    current = null;
  };

  for (const line of markdown.split('\n')) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      const id = heading[1];
      if (seen.has(id)) throw new RangeError(`duplicate requirement id ${id}`);
      seen.add(id);
      current = { id, parts: [heading[2]] };
      continue;
    }
    // An indented, non-empty line continues the item above it; anything
    // else closes it. Requirement text wraps at the document's margin, so
    // this is what keeps a two-line requirement one requirement.
    if (current && /^\s+\S/.test(line)) {
      current.parts.push(line.trim());
      continue;
    }
    flush();
  }
  flush();
  return out;
}

/**
 * Every requirement id tagged in one source file.
 *
 * Deliberately a plain text scan rather than a parse: a tag is meant to be
 * greppable by a human with the same rule the checker uses, and a tag in a
 * `describe` block or a comment counts the same as one in a test name.
 */
export function parseTags(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(TAG_RE)) out.add(m[1]);
  return out;
}

export interface CoverageInput {
  requirements: Requirement[];
  /** file path -> ids tagged in it */
  tagsByFile: Map<string, Set<string>>;
}

export interface CoverageReport {
  /** ids with at least one tagging test */
  covered: string[];
  /** ids with none, and not judged */
  uncovered: string[];
  /** ids marked judged rather than tested */
  judged: string[];
  /** tags naming an id the document does not define, with where they were found */
  dangling: { id: string; file: string }[];
  /** id -> the files tagging it */
  filesById: Map<string, string[]>;
}

/** Cross-reference the document against the tags found in the test tree. */
export function coverage({ requirements, tagsByFile }: CoverageInput): CoverageReport {
  const known = new Set(requirements.map((r) => r.id));
  const filesById = new Map<string, string[]>();
  const dangling: { id: string; file: string }[] = [];

  for (const [file, ids] of tagsByFile) {
    for (const id of ids) {
      if (!known.has(id)) {
        dangling.push({ id, file });
        continue;
      }
      const at = filesById.get(id);
      if (at) at.push(file);
      else filesById.set(id, [file]);
    }
  }

  const covered: string[] = [];
  const uncovered: string[] = [];
  const judged: string[] = [];
  for (const r of requirements) {
    if (filesById.has(r.id)) covered.push(r.id);
    else if (r.judged) judged.push(r.id);
    else uncovered.push(r.id);
  }

  dangling.sort((a, b) => a.id.localeCompare(b.id) || a.file.localeCompare(b.file));
  for (const at of filesById.values()) at.sort();
  return { covered, uncovered, judged, dangling, filesById };
}

export interface Baseline {
  uncovered: string[];
}

export interface Verdict {
  /** uncovered now, and not allowed to be - a regression */
  regressions: string[];
  /** listed as uncovered but now covered - the baseline wants lowering */
  stale: string[];
  ok: boolean;
}

/**
 * Compare a coverage report against the committed baseline.
 *
 * Asymmetric on purpose. A requirement that loses its coverage fails the
 * build; a requirement that gains coverage never does, because a check that
 * fails on an improvement teaches people to stop improving. The stale entry
 * is reported with the command that clears it.
 */
export function verdict(report: CoverageReport, baseline: Baseline): Verdict {
  const allowed = new Set(baseline.uncovered);
  const regressions = report.uncovered.filter((id) => !allowed.has(id));
  const coveredOrJudged = new Set([...report.covered, ...report.judged]);
  const stale = baseline.uncovered.filter((id) => coveredOrJudged.has(id));
  return { regressions, stale, ok: regressions.length === 0 && report.dangling.length === 0 };
}
