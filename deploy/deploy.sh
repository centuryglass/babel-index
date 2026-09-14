#!/usr/bin/env bash
#
# The whole deploy, run ON THE VPS by .github/workflows/deploy.yml over SSH.
# See deploy/README.md for the one-time setup this expects.
#
#   deploy/deploy.sh <40-char sha>
#
# It is also the SSH forced command: authorized_keys pins the deploy key to
# this script, so a leaked key cannot get a shell, only ask for a revision of
# `main` to be deployed. The requested sha therefore arrives in
# $SSH_ORIGINAL_COMMAND rather than as an argument, and is read from either.
#
# Two rules make that pinning worth anything, and both are here rather than in
# the workflow, because the workflow is the thing being defended against:
#
#   - The sha must already be an ancestor of origin/<branch>. Anyone holding
#     the key can redeploy main, or roll back to something that WAS main, and
#     nothing else - not a branch, not a fork's commit, not a tag.
#   - Nothing here interpolates the request into a command. It is matched
#     against a 40-hex pattern before it is used at all.
#
# The deploy is not rolled back on failure, deliberately: a release that comes
# up unhealthy stops here, loudly, with the previous sha printed so the
# rollback is one command. Automatic rollback would hide a bad release behind
# a green-looking site and a red workflow nobody reads twice.
set -euo pipefail

# Every step lives in a function called on the last line, because this script
# replaces itself partway through: `git reset --hard` rewrites deploy.sh while
# bash is still reading it, and bash reads a script incrementally as it runs.
# Git's rename-into-place keeps the open handle pointing at the old inode, so
# this is belt and braces - but the failure it guards against (bash resuming
# at a byte offset into a file that changed underneath it) is silent and
# absurd to debug.
main() {
  local requested sha previous lock_before lock_after

  # The repo is wherever this script was run from, so nothing here has to be
  # told where the checkout lives - moving it needs no edit.
  local repo_dir
  repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

  # Per-box settings: the service name and the port it listens on are not
  # properties of the source tree, so they are not stated in it. Sourced
  # first, so the file gets to set the BABEL_* the defaults below read - and
  # so it can put node on PATH, which a forced command does not inherit.
  if [[ -r /etc/babel-index-deploy.conf ]]; then
    # shellcheck source=/dev/null
    source /etc/babel-index-deploy.conf
  fi
  local service="${BABEL_SERVICE:-babel-index}"
  local branch="${BABEL_BRANCH:-main}"
  local health_url="${BABEL_HEALTH_URL:-http://127.0.0.1:5173/api/health}"
  local health_timeout="${BABEL_HEALTH_TIMEOUT:-90}"

  requested="${1:-${SSH_ORIGINAL_COMMAND:-}}"
  # The workflow sends `deploy <sha>`; the leading verb is there so a future
  # second action has somewhere to go, and is stripped here.
  requested="${requested#deploy }"
  sha="$(tr -d '[:space:]' <<<"$requested" | tr '[:upper:]' '[:lower:]')"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    die "expected a 40-character commit sha, got: ${requested:-<nothing>}"
  fi

  # A forced command runs under a non-login shell with a minimal PATH, so an
  # nvm- or asdf-managed node is not on it. Checking here turns that into one
  # clear line instead of `npm: command not found` halfway through a deploy.
  for tool in git node npm; do
    command -v "$tool" >/dev/null || die "$tool is not on PATH ($PATH) - set PATH in /etc/babel-index-deploy.conf"
  done

  cd "$repo_dir"
  say "deploying $sha to $service from $repo_dir"

  previous="$(git rev-parse HEAD)"
  say "currently at $previous"

  # An explicit refspec, so origin/<branch> is definitely updated - the
  # ancestor check below is only as good as how fresh that ref is.
  git fetch --quiet --prune origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  git cat-file -e "${sha}^{commit}" 2>/dev/null || die "$sha is not a commit in this repo, even after fetching origin/$branch"
  git merge-base --is-ancestor "$sha" "origin/$branch" ||
    die "$sha is not an ancestor of origin/$branch - this key may only deploy revisions that reached $branch"

  lock_before="$(git rev-parse HEAD:package-lock.json)"
  # Tracked files only: `config.json` and `favorites.json` are untracked and
  # live in this directory, so this must never become `git clean`.
  git reset --quiet --hard "$sha"
  lock_after="$(git rev-parse HEAD:package-lock.json)"

  if [[ "$lock_before" != "$lock_after" || ! -d node_modules ]]; then
    say "dependencies changed - reinstalling"
    install_dependencies
  else
    say "package-lock.json is unchanged - keeping the installed dependencies"
  fi

  say "restarting $service"
  # -n so a missing sudoers rule fails immediately and says so, rather than
  # blocking on a password prompt no one is there to answer.
  sudo -n systemctl restart "$service"

  # The unit is up; whether it is SERVING the code we just checked out is a
  # different question, and the only one worth answering. See health-check.mjs.
  node deploy/health-check.mjs "$health_url" "$sha" "--timeout=$health_timeout" || {
    warn "the service did not come up healthy on $sha, and has NOT been rolled back."
    warn "roll back with:  ssh <this box> 'deploy $previous'"
    exit 1
  }

  say "deployed $sha"
}

# `npm ci` rather than `npm install`, so a deploy installs the lockfile it was
# tested against rather than whatever resolves today. The cost is that `ci`
# deletes node_modules outright - and transformers.js caches the CLIP weights
# INSIDE it (node_modules/@huggingface/transformers/.cache), so a plain
# reinstall silently re-downloads a few hundred MB of model on the first
# search after every dependency bump. Move it aside and put it back.
install_dependencies() {
  local cache='node_modules/@huggingface/transformers/.cache'
  local stash
  stash="$(mktemp -d)"

  if [[ -d "$cache" ]]; then
    say 'setting the CLIP model cache aside'
    mv "$cache" "$stash/cache"
  fi

  npm ci --omit=dev

  # An install that pulled a new transformers.js may have written a cache of
  # its own; the stashed copy is content-addressed by url, so either one is
  # correct and merging them is not worth the complication.
  if [[ -d "$stash/cache" && ! -d "$cache" ]]; then
    mkdir -p "$(dirname "$cache")"
    mv "$stash/cache" "$cache"
    say 'CLIP model cache restored'
  fi
  rm -rf "$stash"
}

say() { printf '==> %s\n' "$*"; }
warn() { printf '!!! %s\n' "$*" >&2; }
die() {
  warn "$*"
  exit 1
}

main "$@"
