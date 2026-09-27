#!/usr/bin/env node
/**
 * Checks comments and docs against the mechanical rules in `AGENTS.md`,
 * "Comments and docs". `npm run check:comments`, and the `lint` CI job.
 *
 * Pointers must resolve, and em dashes and conviction words fail; ghost
 * words and closed-issue citations only warn. `lib.ts` owns the rules and
 * the word lists.
 *
 * `baseline.json` is a ratchet, like `check-requirements`'s: it counts the
 * failing findings each file is allowed, so the ones already in the tree
 * can be fixed gradually. A count above the baseline fails; one below it
 * prints the command that lowers it (`--update-baseline`). `--list` prints
 * every failing finding, baselined or not.
 *
 * Closed-issue citations are checked only where the issue cache exists
 * (`AGENTS.md`, "Tracking open work"). CI has no cache, so there the rule
 * is skipped.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkFile,
  kindOf,
  markdownAnchors,
  SEVERITY,
  tally,
  verdict,
  type Baseline,
  type Finding,
  type Repo,
  type Rule,
} from './lib.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASELINE_PATH = 'tools/check-comments/baseline.json';
const ISSUE_INDEX_PATH = '.claude/cache/issues/index.md';

/**
 * Tracked paths this check never reads.
 *
 * - `tools/curation/` is a separate ecosystem with its own agent rules.
 * - `CHANGELOG.md` is written by release-please from PR titles.
 * - `reference/` belongs to the inpainting pipeline.
 */
const SKIP = [/^tools\/curation\//, /^CHANGELOG\.md$/, /^reference\//];

/**
 * Rules a file is exempt from, and why.
 *
 * - `docs/agents/comment-audit.md` names files that live on another branch
 *   and are copied in only for the audit.
 */
const EXEMPT: Record<string, Rule[]> = {
  'docs/agents/comment-audit.md': ['pointer'],
};

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function buildRepo(files: string[]): Repo {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const cache = new Map<string, Set<string>>();
  const ignoredCache = new Map<string, boolean>();
  return {
    files: new Set(files),
    dirs,
    ignored(path) {
      let hit = ignoredCache.get(path);
      if (hit === undefined) {
        // Exit status 0 means ignored, 1 means not; execFileSync throws on 1.
        try {
          execFileSync('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd: REPO_ROOT, stdio: 'ignore' });
          hit = true;
        } catch {
          hit = false;
        }
        ignoredCache.set(path, hit);
      }
      return hit;
    },
    anchors(path) {
      let hit = cache.get(path);
      if (!hit) {
        hit = path.endsWith('.md') && existsSync(join(REPO_ROOT, path))
          ? markdownAnchors(readFileSync(join(REPO_ROOT, path), 'utf8'))
          : new Set();
        cache.set(path, hit);
      }
      return hit;
    },
  };
}

/** Closed issue numbers from the issue cache's index, or undefined when there is no cache. */
function closedIssues(): Set<number> | undefined {
  const path = join(REPO_ROOT, ISSUE_INDEX_PATH);
  if (!existsSync(path)) return undefined;
  const index = readFileSync(path, 'utf8');
  const closed = index.split(/^## Closed$/m)[1];
  if (closed === undefined) return undefined;
  return new Set([...closed.matchAll(/^- \[#(\d+)\]/gm)].map((m) => Number(m[1])));
}

function readBaseline(): Baseline {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_PATH), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Baseline) : {};
  } catch {
    // A missing baseline allows nothing, which fails loudly rather than
    // passing a run that checked nothing.
    return {};
  }
}

function writeBaseline(counts: Baseline): void {
  const sorted: Baseline = {};
  for (const file of Object.keys(counts).sort()) {
    sorted[file] = {};
    for (const rule of Object.keys(counts[file]).sort() as (keyof Baseline[string])[])
      sorted[file][rule] = counts[file][rule];
  }
  writeFileSync(join(REPO_ROOT, BASELINE_PATH), `${JSON.stringify(sorted, null, 2)}\n`);
}

const show = (file: string, f: Finding): string => `${file}:${f.line}: [${f.rule}] ${f.message}`;

function main(): void {
  const update = process.argv.includes('--update-baseline');
  const list = process.argv.includes('--list');

  const files = trackedFiles();
  const repo = buildRepo(files);
  const closed = closedIssues();

  const findingsByFile = new Map<string, Finding[]>();
  for (const file of files) {
    if (!kindOf(file) || SKIP.some((re) => re.test(file))) continue;
    // `CLAUDE.md` links to `AGENTS.md`; its findings are that file's.
    if (lstatSync(join(REPO_ROOT, file)).isSymbolicLink()) continue;
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    const exempt = EXEMPT[file] ?? [];
    const findings = checkFile({ file, source, repo, closedIssues: closed }).filter((f) => !exempt.includes(f.rule));
    if (findings.length) findingsByFile.set(file, findings);
  }

  const counts = tally(findingsByFile);
  if (update) {
    writeBaseline(counts);
    const total = Object.values(counts).reduce((n, r) => n + Object.values(r).reduce((a, b) => a + b, 0), 0);
    console.log(`baseline updated: ${total} failing findings allowed across ${Object.keys(counts).length} files`);
    return;
  }

  const result = verdict(counts, readBaseline());

  const warnings: string[] = [];
  for (const [file, findings] of findingsByFile)
    for (const f of findings) {
      if (SEVERITY[f.rule] === 'warn') warnings.push(show(file, f));
      else if (list) console.log(show(file, f));
    }
  for (const w of warnings) console.warn(`warning: ${w}`);

  for (const r of result.regressions) {
    console.error(`${r.file}: ${r.rule} found ${r.count} times, ${BASELINE_PATH} allows ${r.allowed}`);
    for (const f of findingsByFile.get(r.file) ?? []) if (f.rule === r.rule) console.error(`  ${show(r.file, f)}`);
  }

  if (result.stale.length)
    console.log(
      `${result.stale.length} file/rule counts fell below the baseline - ` +
        'run `npm run check:comments -- --update-baseline` to lower it'
    );
  if (!closed) console.log(`closed-issue check skipped: no ${ISSUE_INDEX_PATH}`);

  if (!result.ok) process.exit(1);
  console.log(`comments ok (${warnings.length} warnings)`);
}

main();
