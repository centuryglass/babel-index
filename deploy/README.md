# deploy — main to the VPS, verified

`.github/workflows/deploy.yml` replaces the manual sequence this used to be:
ssh in on a non-standard port, `git pull`, `npm install`,
`sudo systemctl restart babel-index`, and then a guess about whether it
worked. A merge to main now does all of it and refuses to call it done until
the live site answers with the sha that was merged.

Three pieces:

- **`deploy/deploy.sh`** runs on the VPS and is the deploy - fetch, verify the
  revision really is on `main`, check out, reinstall if the lockfile moved,
  restart the unit, confirm it came back healthy. It is also the SSH *forced
  command*, so the key GitHub holds cannot do anything else.
- **`deploy/health-check.mjs`** polls `/api/health` until the server reports
  the expected commit, or explains what it is reporting instead. Run twice per
  deploy: on the box against `127.0.0.1` (did the unit come back on the new
  code?) and from the runner against the public url (can anyone reach it?).
- **`.github/workflows/deploy.yml`** waits for `ci` to go green on main, then
  makes one ssh call and runs the second health check.

Unlike `infra/` - where the Cloudflare credentials deliberately never leave
your machine - this does put a key in GitHub's secret store. The forced
command and the ancestor check below are what make that key worth less than a
shell: everything it can do is "deploy a revision that already passed CI on
main".

## What "verified" means here

`git pull && systemctl restart` can fail silently in ways that still leave
something answering on port 5173. The old process surviving a failed restart,
a unit file pointing at a second checkout, `--images` aimed at a directory
that moved - all of those serve a 200. So the check is not "does it answer":

1. `/api/health` reports the commit the process is actually running
   (`packages/server/version.ts` reads it from `BABEL_COMMIT`, else the
   checkout's own `.git`). The deploy fails unless that matches the sha it
   just pushed.
2. It reports the room count, and a release that comes up serving an **empty
   corpus** fails immediately rather than waiting out the timeout - that one
   cannot fix itself by retrying.
3. Both are checked again from outside the machine, through nginx, so a
   working server behind a broken reverse proxy is not a green deploy.

A failed deploy is **not** rolled back. It stops, loudly, and prints the sha
it was on so the rollback is one button (below). Rolling back automatically
would leave a working-looking site and a red workflow, which is the pair of
signals most likely to be misread.

## One-time setup

### 1. On the VPS

Everything here is done as the user that owns the checkout (the one you ssh in
as today). Nothing needs a new account, though a dedicated `babel-deploy` user
with nothing but this checkout in its home is the stricter version if you want
it later.

**Let that user restart the service without a password**, and *only* that:

```sh
sudo visudo -f /etc/sudoers.d/babel-index
```

```sudoers
# Check the path first: `command -v systemctl`. sudo matches the command
# literally, so a rule for /bin/systemctl does not authorize /usr/bin/systemctl.
youruser ALL=(root) NOPASSWD: /usr/bin/systemctl restart babel-index
```

**Generate a key for GitHub to use.** It is not your key - it authenticates a
workflow, and you want to be able to revoke it on its own:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/babel_deploy -C 'github actions deploy' -N ''
```

**Pin that key to the deploy script.** In `~/.ssh/authorized_keys`, prefix the
new public key with a forced command and the restrictions:

```
command="/home/youruser/Repos/babel-index/deploy/deploy.sh",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ssh-ed25519 AAAA...  github actions deploy
```

That is the whole security story for this key. Whatever command the far end
asks for lands in `$SSH_ORIGINAL_COMMAND` and is never executed - `deploy.sh`
reads a 40-character sha out of it, refuses anything else, and refuses even a
valid sha that is not an ancestor of `origin/main`. A leaked key can redeploy
main or roll back to something that was main. It cannot get a shell, read a
file, or deploy a branch.

**Tell it about this box, if it differs from the defaults** - service
`babel-index`, branch `main`, health at `http://127.0.0.1:5173/api/health`.
This file is also where `PATH` goes if node came from nvm or asdf, since a
forced command runs with a minimal environment and no login shell:

```sh
sudo tee /etc/babel-index-deploy.conf <<'EOF'
BABEL_HEALTH_URL=http://127.0.0.1:5173/api/health
# BABEL_SERVICE=babel-index
# BABEL_BRANCH=main
# BABEL_HEALTH_TIMEOUT=90
# PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH"
EOF
```

**Check it before GitHub tries it.** From the VPS itself:

```sh
cd ~/Repos/babel-index
./deploy/deploy.sh "$(git rev-parse origin/main)"
```

That is the real thing, restart included. It should end in `==> deployed
<sha>`.

### 2. In the repository settings

Under **Settings → Secrets and variables → Actions**, as *secrets*:

| Secret | What goes in it |
| --- | --- |
| `DEPLOY_SSH_KEY` | the whole of `~/.ssh/babel_deploy` (the **private** half), including the BEGIN/END lines |
| `DEPLOY_KNOWN_HOSTS` | your VPS's host public keys — `ssh-keyscan -p <your port> <your host>`, fingerprint-checked against the box itself (below) |
| `DEPLOY_HOST` | the VPS hostname |
| `DEPLOY_PORT` | the non-standard ssh port |
| `DEPLOY_USER` | the user that owns the checkout |

and as a *variable* (not a secret - it is on the deployment record and in the
job summary):

| Variable | What goes in it |
| --- | --- |
| `PUBLIC_URL` | `https://centuryglass.us/babel-index/` |

`DEPLOY_KNOWN_HOSTS` is the other direction of the same connection:
`DEPLOY_SSH_KEY` proves to the VPS that the runner may ask for a deploy, and
this proves to the runner that it is talking to your VPS. A runner is a fresh
VM with an empty `known_hosts` every time, so without it the connection is
trust-on-first-use — it would accept whatever key answered. SSH would still
keep an impostor from stealing or replaying the deploy key (pubkey auth signs
a challenge bound to the session), but an impostor does not need the key to
read the requested sha and answer "deployed" — the deploy step would report
success having deployed nothing, anywhere. The public health check would
still catch that, since the real site would be serving the old commit, but
one clear ssh failure beats a confusing health failure two steps later.

Scanning over the network is itself trust-on-first-use, so check the
fingerprints against the box rather than trusting the scan. From your existing
ssh session on the VPS:

```sh
for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done
```

Then run the `ssh-keyscan` above, pipe it through `ssh-keygen -lf -`, and
confirm every fingerprint appears in that list before pasting the scan's raw
output into the secret.

Two consequences worth expecting. Entries are keyed by host **and** port
(`ssh-keyscan -p` writes the `[host]:port` form for you), so changing the ssh
port invalidates this secret even though the machine has not changed. And the
pin is to whatever holds `/etc/ssh/ssh_host_*_key`, so rebuilding the box
fails the deploy until you re-scan — which is the point, and the one event you
would want to be told about rather than deployed through.

The workflow names a `production` environment, which gives you the deployment
record on the repo's front page and somewhere to hang a required reviewer if
you ever want the deploy to pause for a click.

### 3. Merge it

`workflow_run` and `workflow_dispatch` only exist once the workflow file is on
the **default branch** - until `deploy.yml` is on main, nothing will fire and
no "Run workflow" button appears. That is normal, not a misconfiguration.

## Everyday use

**A normal deploy** is a merge to main. `ci` runs; if it goes green, `deploy`
picks up the exact sha ci tested and ships it.

**A redeploy or a rollback** is Actions → deploy → *Run workflow*, with a sha
in the box (empty means the tip of main). Any revision that has been on main
is accepted, so rolling back is pasting the previous sha from the failed run's
summary.

**When a deploy fails**, the site is still on whatever the failed release
left. Read which step failed:

- *deploy* - the box rejected it or the unit did not come back. The job log
  carries `deploy.sh`'s own output, including the sha it was on before.
- *verify it from outside* - the service is healthy on the new revision but
  the public url disagrees. That is nginx, TLS, or DNS, not the release.

## Things that will bite you

- **`deploy.sh` deploys with the version of itself that was already checked
  out**, because the checkout happens partway through the run. A change to the
  deploy script takes effect on the deploy *after* the one that introduces it.
- **`npm ci`, not `npm install`** - a deploy installs the lockfile CI tested,
  not whatever resolves today. It also deletes `node_modules`, and
  transformers.js caches the CLIP weights *inside* it, so the script moves that
  cache aside and back. Without that, every dependency bump silently
  re-downloads a few hundred MB on the first search after deploying.
- **The install carries two flags that are about the box, not the project.**
  `--maxsockets=1` keeps a from-scratch install inside a small VPS's memory
  and bandwidth instead of failing partway through with `node_modules` half
  written, and `--onnxruntime-node-install-cuda=skip` stops it fetching CUDA
  binaries a CPU-only host has no use for. Both make the install slower and
  neither is needed on a larger machine — if this deployment ever moves
  somewhere with room, they are the first thing to drop.
- **Nothing here runs `git clean`,** and it must not start: `config.json` and
  `favorites.json` are untracked, live in the checkout, and are the only
  state this deployment owns.
- **The reverse proxy has to be in front of it.** `--base-path` alone serves a
  page whose every relative url 404s (see AGENTS.md, "Deployment and the base
  path"); the nginx config that strips the prefix is a separate, hand-managed
  file on the box.
