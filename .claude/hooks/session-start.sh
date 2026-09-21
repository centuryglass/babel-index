#!/bin/bash
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  npm install
fi

# Refresh the GitHub issue cache and surface it as session context (see
# AGENTS.md, "Tracking open work"). Only possible where `gh` is on PATH and
# authenticated - a Claude Code Remote session has neither, so this is a
# no-op there and an agent must run `.claude/scripts/issues.mjs` by hand,
# piping in issue JSON from the GitHub MCP tools instead.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  node .claude/scripts/issues.mjs --fetch
  cat .claude/cache/issues/index.md
fi
