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
 *   - `--fetch-api` calls the REST API with Node's built-in `fetch`, so it
 *     needs no `gh` binary. The repo is public, so it needs no token
 *     either; unauthenticated, it shares GitHub's 60/hr-per-IP limit, which
 *     a Claude Code Remote container's egress IP can already have spent.
 *     A token raises the limit to 5000/hr. The first one set wins:
 *       - `BABEL_INDEX_ISSUES_TOKEN`: a fine-grained PAT with read-only
 *         access to this repo's issues. It can do nothing an
 *         unauthenticated request can't, so it is safe as a plain env var.
 *       - `GH_TOKEN`, then `GITHUB_TOKEN`, for a setup where one of those
 *         is a real PAT. In a Claude Code Remote session they are not
 *         (401), which is why `session-start.sh` treats this front end as
 *         best-effort.
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
 * Fetches every comment on one issue, following pagination. Called only for
 * an issue whose `comments` count is nonzero, since each call is a request
 * against the same rate budget.
 */
async function fetchIssueComments(commentsUrl, headers) {
  const comments = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${commentsUrl}?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    for (const c of batch) {
      comments.push({ author: c.user?.login ?? null, body: c.body ?? '', createdAt: c.created_at ?? null });
    }
    if (batch.length < 100) break;
  }
  return comments;
}

/**
 * The `--fetch-api` front end; the file header covers tokens and rate
 * limits. The REST issues endpoint also returns pull requests (flagged with
 * a `pull_request` key) and caps pages at 100, so this skips the former and
 * pages through the latter, both of which `gh issue list` does internally.
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
        comments: issue.comments > 0 ? await fetchIssueComments(issue.comments_url, headers) : [],
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

/**
 * Tolerant of `gh issue list --json comments`' shape (`author: {login}`,
 * `createdAt`) and `fetchIssueComments`' shape (`author` already a login
 * string, `createdAt`), and defaults to none for `--from-json`/stdin input
 * that predates this field.
 */
const commentsOf = (issue) =>
  (Array.isArray(issue.comments) ? issue.comments : []).map((c) => ({
    author: (typeof c.author === 'string' ? c.author : c.author?.login) ?? null,
    body: c.body ?? '',
    createdAt: c.createdAt ?? c.created_at ?? null,
  }));

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

  const comments = commentsOf(issue);
  const commentsBlock = comments.length
    ? [
        '',
        '---',
        '',
        '## Comments',
        '',
        ...comments.flatMap((c) => [
          `### @${c.author ?? 'unknown'} - ${c.createdAt ?? 'unknown date'}`,
          '',
          c.body || '_no comment body_',
          '',
        ]),
      ].join('\n')
    : '';

  return `${head.join('\n')}${issue.body ?? '_no description_'}\n${commentsBlock}`;
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
      'available, or use --fetch-api where api.github.com is reachable.'
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
