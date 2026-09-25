#!/bin/bash
set -euo pipefail

# Also run by OpenCode (`.opencode/plugins/issue-cache.ts`), which discards
# stdout and reads the cache's index file instead.
cd "${CLAUDE_PROJECT_DIR:-.}"

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  npm install
fi

# Refresh the GitHub issue cache and surface it as session context (see
# AGENTS.md, "Tracking open work"). Uses `gh` when it is on PATH and
# authenticated, and otherwise `--fetch-api`, whose token and rate-limit
# handling `issues.mjs`'s header covers. Either fetch is best-effort: a
# rate-limited or failed one must not fail session start. When neither works,
# an agent runs `issues.mjs --from-json` by hand with issue JSON from the
# GitHub MCP tools.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  node .claude/scripts/issues.mjs --fetch && cat .claude/cache/issues/index.md || true
else
  node .claude/scripts/issues.mjs --fetch-api && cat .claude/cache/issues/index.md || true
fi
