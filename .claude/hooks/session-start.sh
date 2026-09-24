#!/bin/bash
set -euo pipefail

# Also run by OpenCode (`.opencode/plugins/issue-cache.ts`), which discards
# stdout and reads the cache's index file instead.
cd "${CLAUDE_PROJECT_DIR:-.}"

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  npm install
fi

# Refresh the GitHub issue cache and surface it as session context (see
# AGENTS.md, "Tracking open work"). Two automatic paths, in order of
# preference, plus a manual fallback for an environment that can reach
# neither:
#   - `gh` on PATH and authenticated - the maintainer's own machine.
#   - No `gh`: `--fetch-api` hits the REST API directly. The repo is
#     public, so this works with no token at all, subject to the
#     unauthenticated 60/hr-per-IP rate limit (shared across a Claude Code
#     Remote container's other traffic, and observed exhausted there) -
#     see the --fetch-api docstring in issues.mjs for the token env vars
#     that raise it. Best-effort either way: a rate-limited or otherwise
#     failed call must not take the rest of session start down with it.
# Both failing (no `gh`, and the API call rejected) means an agent must run
# `.claude/scripts/issues.mjs` by hand, piping in issue JSON from the
# GitHub MCP tools instead.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  node .claude/scripts/issues.mjs --fetch && cat .claude/cache/issues/index.md || true
else
  node .claude/scripts/issues.mjs --fetch-api && cat .claude/cache/issues/index.md || true
fi
