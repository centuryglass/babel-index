#!/usr/bin/env node
/**
 * Compiles this repo's GitHub issues into a local directory an agent can
 * read with ordinary file tools: one `index.md` to scan, one file per
 * issue to open.
 *
 * Why this exists: open work lives in GitHub issues (AGENTS.md, "Tracking
 * open work"), but a file on disk is what a coding agent reads cheaply at
 * the start of a session. This closes that gap without moving the source of
 * truth back into the repo - the cache is generated, gitignored, and always
 * a copy.
 *
 * Three front ends, one compiler, because the callers have different
 * GitHub access:
 *   - `--fetch` shells out to `gh`, which the maintainer has locally.
 *   - `--fetch-api` calls the REST API directly with Node's built-in
 *     `fetch` - no `gh` binary needed, and no token needed either, since
 *     this repo is public: an unauthenticated call works, just against the
 *     shared 60/hr-per-IP limit rather than 5000/hr. A Claude Code Remote
 *     container's egress IP is shared with other traffic and was observed
 *     to have that budget already spent, so `fetchWithApi`'s own comment
 *     documents an optional `BABEL_INDEX_ISSUES_TOKEN` - a fine-grained,
 *     read-only, issues-only PAT safe to set as a plain env var - as the
 *     fix for that case. `GH_TOKEN`/`GITHUB_TOKEN` are tried too, for a
 *     setup where those happen to be a real PAT; in a Claude Code Remote
 *     session's environment they are not (401), so `session-start.sh`
 *     calls this front end best-effort regardless of outcome.
 *   - stdin (or `--from-json`) takes an already-fetched JSON array, the
 *     fallback for an agent whose environment can reach neither
 *     `api.github.com` nor `gh` at all - see AGENTS.md's "Tracking open
 *     work".
 *
 * Plain `.mjs` rather than the `.ts` AGENTS.md defaults to: this has to run
 * before `npm install` has necessarily happened, and the TypeScript loader
 * hook (`build/register.mjs`) needs esbuild out of `node_modules`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_OUT = '.claude/cache/issues';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function fetchWithGh() {
  const fields = 'number,title,state,labels,body,createdAt,updatedAt,url,assignees,comments';
  return execFileSync('gh', ['issue', 'list', '--state', 'all', '--limit', '500', '--json', fields], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Parsed from `origin` rather than hardcoded, so a fork queries its own issues. */
function originRepo() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
  if (!match) throw new Error(`origin remote is not a github.com url: ${url}`);
  return { owner: match[1], repo: match[2] };
}

/**
 * The repo is public, so no token is required by GitHub - only a token
 * raises the rate limit from 60/hr (unauthenticated, shared across every
 * request from the same egress IP - already exhausted by other traffic in
 * a Claude Code Remote container, observed as an immediate 403) to
 * 5000/hr. `BABEL_INDEX_ISSUES_TOKEN` is a scope-it-yourself escape hatch
 * for that: a fine-grained PAT with read-only access to this repo's
 * issues, safe to set as a plain (non-secret) environment variable since
 * it can do nothing but what an unauthenticated request already could.
 * `GH_TOKEN`/`GITHUB_TOKEN` are tried after it for a setup where those
 * happen to be a real PAT rather than reserved for something else, as
 * observed in a Claude Code Remote session (see the file docblock).
 *
 * The REST issues endpoint also returns pull requests (flagged with a
 * `pull_request` key) and paginates at 100/page regardless of what's asked
 * for, so both need handling `gh issue list` does internally.
 */
async function fetchWithApi() {
  const token = process.env.BABEL_INDEX_ISSUES_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const { owner, repo } = originRepo();
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'babel-index-issues-cache',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const issues = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`,
      { headers }
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    for (const issue of batch) {
      if (issue.pull_request) continue;
      issues.push({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
        body: issue.body,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        url: issue.html_url,
      });
    }
    if (batch.length < 100) break;
  }
  return JSON.stringify(issues);
}

/** Tolerant of the two shapes the front ends produce: a bare array, or `{issues: [...]}`. */
function parseIssues(raw) {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : (parsed?.issues ?? []);
  if (!Array.isArray(list)) throw new TypeError('expected a JSON array of issues');
  return list;
}

const labelsOf = (issue) =>
  (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l?.name ?? ''))).filter(Boolean);

const stateOf = (issue) => String(issue.state ?? 'OPEN').toUpperCase();

function slug(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'issue';
}

function issueFile(issue) {
  const labels = labelsOf(issue);
  const head = [
    `# #${issue.number} ${issue.title ?? ''}`,
    '',
    `- state: ${stateOf(issue)}`,
    labels.length ? `- labels: ${labels.join(', ')}` : null,
    issue.url ? `- url: ${issue.url}` : null,
    issue.updatedAt || issue.updated_at ? `- updated: ${issue.updatedAt ?? issue.updated_at}` : null,
    '',
    '---',
    '',
  ].filter((l) => l !== null);
  return `${head.join('\n')}${issue.body ?? '_no description_'}\n`;
}

async function main() {
  const out = arg('--out', DEFAULT_OUT);
  const fromJson = arg('--from-json');

  let raw;
  if (process.argv.includes('--fetch')) raw = fetchWithGh();
  else if (process.argv.includes('--fetch-api')) raw = await fetchWithApi();
  else if (fromJson) raw = readFileSync(fromJson, 'utf8');
  else raw = readStdin();

  if (!raw.trim()) {
    console.error(
      'no input. Pipe issue JSON in, pass --from-json <path>, use --fetch where `gh` is ' +
      'available, or use --fetch-api where GH_TOKEN/GITHUB_TOKEN is set.'
    );
    process.exit(1);
  }

  const issues = parseIssues(raw).slice().sort((a, b) => (b.number ?? 0) - (a.number ?? 0));

  // Rebuilt from scratch every run: a stale file for an issue that has
  // since been deleted or renumbered is worse than no cache at all.
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const open = issues.filter((i) => stateOf(i) === 'OPEN');
  const closed = issues.filter((i) => stateOf(i) !== 'OPEN');

  const line = (i) => {
    const labels = labelsOf(i);
    return `- [#${i.number}](${i.number}-${slug(i.title)}.md) ${i.title ?? ''}` +
      `${labels.length ? ` _(${labels.join(', ')})_` : ''}`;
  };

  const index = [
    '# Issue cache',
    '',
    `Generated by \`.claude/scripts/issues.mjs\`. A copy, never the source of`,
    'truth - re-run it rather than editing anything here, and make changes on',
    'GitHub itself.',
    '',
    `${open.length} open, ${closed.length} closed.`,
    '',
    '## Open',
    '',
    ...(open.length ? open.map(line) : ['_none_']),
    '',
    '## Closed',
    '',
    ...(closed.length ? closed.map(line) : ['_none_']),
    '',
  ].join('\n');

  writeFileSync(join(out, 'index.md'), index);
  for (const i of issues) writeFileSync(join(out, `${i.number}-${slug(i.title)}.md`), issueFile(i));

  console.log(`${issues.length} issues written to ${out} (${open.length} open)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
