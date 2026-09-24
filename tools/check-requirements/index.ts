#!/usr/bin/env node
/**
 * Fails if the search requirements and the test tree have drifted: a
 * coverage tag naming a requirement that does not exist, or a requirement
 * that has lost the coverage the committed baseline says it had. `npm run
 * check:requirements`, and the `lint` CI job.
 *
 * Coverage is never stored. A test names the requirement it covers
 * (`test('... [SR-18]', ...)`), and this rebuilds the whole mapping from
 * `git ls-files` on every run - so there is nothing to keep in sync, and
 * `docs/search_requirements.md` can go on naming no tests at all.
 *
 * The baseline is a ratchet. `baseline.json` lists the requirements known
 * to be uncovered: losing coverage fails, gaining it never does, and
 * `--update-baseline` rewrites the list once a gap is closed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverage, parseRequirements, parseTags, verdict, type Baseline } from './lib.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REQUIREMENTS_PATH = 'docs/search_requirements.md';
const BASELINE_PATH = 'tools/check-requirements/baseline.json';

/** The same suffixes `check-file-map` calls a test, minus the images it also skips. */
const TEST_RE = /\.(test\.(ts|mjs)|e2e\.ts|parity\.ts)$/;

function trackedTests(): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter((p) => p && TEST_RE.test(p));
}

function readBaseline(): Baseline {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_PATH), 'utf8'));
    const list = (parsed as Baseline)?.uncovered;
    return { uncovered: Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [] };
  } catch {
    // A missing or unreadable baseline is "nothing is allowed to be
    // uncovered", which fails loudly rather than passing a run that
    // checked nothing.
    return { uncovered: [] };
  }
}

function writeBaseline(uncovered: string[]): void {
  const body = { uncovered: [...uncovered].sort() };
  writeFileSync(join(REPO_ROOT, BASELINE_PATH), `${JSON.stringify(body, null, 2)}\n`);
}

function main(): void {
  const update = process.argv.includes('--update-baseline');
  const verbose = process.argv.includes('--list');

  const requirements = parseRequirements(readFileSync(join(REPO_ROOT, REQUIREMENTS_PATH), 'utf8'));
  if (!requirements.length) {
    console.error(`${REQUIREMENTS_PATH} defines no requirements - has its list format changed?`);
    process.exit(1);
  }

  const tagsByFile = new Map<string, Set<string>>();
  for (const file of trackedTests()) {
    const tags = parseTags(readFileSync(join(REPO_ROOT, file), 'utf8'));
    if (tags.size) tagsByFile.set(file, tags);
  }

  const report = coverage({ requirements, tagsByFile });
  const testable = requirements.length - report.judged.length;

  if (update) {
    writeBaseline(report.uncovered);
    console.log(`baseline updated: ${report.uncovered.length} uncovered of ${testable} testable`);
    return;
  }

  const result = verdict(report, readBaseline());

  console.log(
    `${report.covered.length} / ${testable} testable requirements covered` +
      `${report.judged.length ? `, ${report.judged.length} judged` : ''}` +
      ` (${requirements.length} total)`
  );

  if (verbose)
    for (const r of requirements) {
      const files = report.filesById.get(r.id);
      const mark = files ? 'x' : r.judged ? '~' : ' ';
      console.log(`  [${mark}] ${r.id} ${r.text}`);
      if (files) for (const f of files) console.log(`        ${f}`);
    }

  for (const { id, file } of report.dangling)
    console.error(`dangling tag: ${file} names ${id}, which ${REQUIREMENTS_PATH} does not define`);

  for (const id of result.regressions)
    console.error(`coverage lost: ${id} has no tagging test and is not in ${BASELINE_PATH}`);

  if (result.stale.length)
    console.log(
      `${result.stale.length} newly covered (${result.stale.join(', ')}) - ` +
        'run `npm run check:requirements -- --update-baseline` to lower the baseline'
    );

  if (!result.ok) process.exit(1);
}

main();
