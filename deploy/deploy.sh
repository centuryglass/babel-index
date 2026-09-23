#!/usr/bin/env bash
#
# The deploy itself, run on the VPS by .github/workflows/deploy.yml over SSH.
# deploy/README.md has the one-time setup and the rollback path.
#
#   deploy/deploy.sh <40-char sha>
#
# It is also the deploy key's SSH forced command, so a leaked key can only ask
# for a revision of `main`. Over SSH the sha arrives in $SSH_ORIGINAL_COMMAND;
# run by hand, it is the first argument. Either is read.
#
# Two rules make that pinning worth anything. Both live here, not in the
# workflow, because the workflow is what they defend against:
#
#   - The sha must already be an ancestor of origin/<branch>. The key can
#     redeploy main or roll back to something that was main, and nothing
#     else: not a branch, a fork's commit, or a tag.
#   - The request is never interpolated into a command. It must match a
#     40-hex pattern before it is used at all.
#
# A failure is not rolled back. The script stops with the previous sha
# printed, and the rollback is a manual redeploy of it. An automatic rollback
# would pair a working-looking site with a red workflow, easily misread as
# flaky CI.
set -euo pipefail

# Every step lives in a function called on the last line, because
# `git reset --hard` rewrites this script while bash is still reading it, and
# bash reads a script incrementally. Parsing the whole body first keeps bash
# from resuming at a byte offset into a changed file, a silent failure. Git's
# rename-into-place already keeps the open handle on the old inode; this is
# the second guard. The version that runs is the one already on the box, so a
# change here takes effect one deploy late.
main() {
  local requested sha previous lock_before lock_after

  # The repo is the checkout this script sits in, so moving the checkout needs
  # no edit here (only the authorized_keys path).
  local repo_dir
  repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

  # Per-box settings, which are not properties of the source tree. Sourced
  # before the defaults below so it can set any BABEL_*, and so it can put
  # node on PATH, which a forced command does not inherit.
  if [[ -r /etc/babel-index-deploy.conf ]]; then
    # shellcheck source=/dev/null
    source /etc/babel-index-deploy.conf
  fi
  local service="${BABEL_SERVICE:-babel-index}"
  local branch="${BABEL_BRANCH:-main}"
  local health_url="${BABEL_HEALTH_URL:-http://127.0.0.1:5173/api/health}"
  local health_timeout="${BABEL_HEALTH_TIMEOUT:-90}"

  requested="${1:-${SSH_ORIGINAL_COMMAND:-}}"
  # The workflow sends `deploy <sha>`. The verb leaves room for a second
  # action and is stripped here.
  requested="${requested#deploy }"
  sha="$(tr -d '[:space:]' <<<"$requested" | tr '[:upper:]' '[:lower:]')"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    die "expected a 40-character commit sha, got: ${requested:-<nothing>}"
  fi

  # A forced command runs under a non-login shell with a minimal PATH, so an
  # nvm- or asdf-managed node is not on it. This check fails in one clear line
  # before anything changes, not with `npm: command not found` mid-deploy.
  for tool in git node npm; do
    command -v "$tool" >/dev/null || die "$tool is not on PATH ($PATH) - set PATH in /etc/babel-index-deploy.conf"
  done

  cd "$repo_dir"
  say "deploying $sha to $service from $repo_dir"

  previous="$(git rev-parse HEAD)"
  say "currently at $previous"

  # An explicit refspec, so origin/<branch> is always updated. The ancestor
  # check below is only as good as that ref is fresh.
  git fetch --quiet --prune origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  git cat-file -e "${sha}^{commit}" 2>/dev/null || die "$sha is not a commit in this repo, even after fetching origin/$branch"
  git merge-base --is-ancestor "$sha" "origin/$branch" ||
    die "$sha is not an ancestor of origin/$branch - this key may only deploy revisions that reached $branch"

  lock_before="$(git rev-parse HEAD:package-lock.json)"
  # Resets tracked files only. `config.json`, `favorites.json` and the log
  # file are untracked and live in this directory, so this must never become
  # `git clean`. From here until the restart, the checkout is ahead of the
  # running process; a failed install leaves it that way.
  git reset --quiet --hard "$sha"
  lock_after="$(git rev-parse HEAD:package-lock.json)"

  if [[ "$lock_before" != "$lock_after" || ! -d node_modules ]]; then
    say "dependencies changed - reinstalling"
    install_dependencies
  else
    say "package-lock.json is unchanged - keeping the installed dependencies"
  fi

  say "restarting $service"
  # -n so a missing sudoers rule fails immediately and says so, instead of
  # blocking on a password prompt no one is there to answer.
  sudo -n systemctl restart "$service"

  # A restarted unit is not proof it serves the new code; health-check.mjs
  # checks the running commit.
  node deploy/health-check.mjs "$health_url" "$sha" "--timeout=$health_timeout" || {
    warn "the service did not come up healthy on $sha, and has NOT been rolled back."
    warn "roll back with:  ssh <this box> 'deploy $previous'"
    exit 1
  }

  say "deployed $sha"
}

# Installs the lockfile CI tested (`npm ci`), keeping the CLIP model cache.
# `npm ci` deletes node_modules, and transformers.js caches the CLIP weights
# inside it (node_modules/@huggingface/transformers/.cache). Without the move
# aside and back, every dependency bump silently re-downloads a few hundred MB
# of model on the first search after deploying.
install_dependencies() {
  local cache='node_modules/@huggingface/transformers/.cache'
  local stash
  stash="$(mktemp -d)"

  if [[ -d "$cache" ]]; then
    say 'setting the CLIP model cache aside'
    mv "$cache" "$stash/cache"
  fi

  # Two flags for this small, CPU-only box; a larger host can drop both:
  #   --maxsockets=1 holds the install to one connection at a time, so a
  #     from-scratch install cannot exhaust a small VPS's memory or bandwidth
  #     partway through and leave node_modules half written. It is slower.
  #   --onnxruntime-node-install-cuda=skip stops onnxruntime-node's install
  #     script fetching CUDA binaries, which this box has no GPU to use and
  #     which are large enough to be the thing that fails.
  npm ci --omit=dev --maxsockets=1 --onnxruntime-node-install-cuda=skip

  # If the install already wrote a new cache, keep it and drop the stash.
  # Both are content-addressed by url, so either is correct.
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
