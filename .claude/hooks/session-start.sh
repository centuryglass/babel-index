#!/bin/bash
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  npm install
fi

# Refresh the GitHub issue cache and surface it as session context (see
# AGENTS.md, "Tracking open work"). Two automatic paths, in order of
# preference, plus a manual fallback for anything with neither:
#   - `gh` on PATH and authenticated - the maintainer's own machine.
#   - GH_TOKEN/GITHUB_TOKEN in the environment with no `gh` binary - a
#     Claude Code Remote session, which has the token but not the CLI.
# Neither of those holding (no `gh`, no token) means an agent must run
# `.claude/scripts/issues.mjs` by hand, piping in issue JSON from the
# GitHub MCP tools instead.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  node .claude/scripts/issues.mjs --fetch
  cat .claude/cache/issues/index.md
elif [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  # Best-effort: the env token isn't guaranteed to be a plain REST bearer
  # token (see the --fetch-api docstring in issues.mjs), so a 401 here must
  # not take the rest of session start down with it.
  node .claude/scripts/issues.mjs --fetch-api && cat .claude/cache/issues/index.md || true
fi
