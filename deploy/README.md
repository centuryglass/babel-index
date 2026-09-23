# deploy - shipping a release to the VPS, verified

Merging release-please's release PR deploys that release to the VPS. The
deploy counts as done only when the live site reports the sha that was merged.
An ordinary merge to main builds and tests but does not deploy.

| Piece | Where it runs | What it does |
| --- | --- | --- |
| `.github/workflows/deploy.yml` | GitHub Actions | Picks the sha, runs the render-parity gate, makes one ssh call, then checks the public url. |
| `deploy/deploy.sh` | the VPS, as the deploy key's SSH forced command | Refuses any sha not on `main`, checks it out, reinstalls if the lockfile moved, restarts the unit, checks `127.0.0.1`. |
| `deploy/health-check.mjs` | both | Polls `/api/health` until it reports the expected commit, or says what it reports instead. |
| `deploy/babel-index.nginx.conf` | reference only | The babel-index blocks of the VPS's hand-managed nginx config. |

## Everyday use

**A normal deploy** is merging the standing release PR (titled
`chore(main): release ...`). `ci` runs on the merge commit; if it goes
green, `deploy` ships the sha `ci` tested.

**A redeploy, a rollback, or an urgent fix between releases** is Actions ->
deploy -> *Run workflow*, with a sha in the box. Leave it empty for the tip of
the branch the run is dispatched from (main by default). The sha must be the
full 40 characters and must have been on main at some point; anything else is
refused.

**When a deploy fails, nothing is rolled back.** The site stays on whatever
the failed release left. Find the failed step:

| Failed step | Meaning | The box |
| --- | --- | --- |
| *which commit* | The dispatched sha is not a full 40-character lowercase sha. | untouched |
| *npm ci*, *Install Chromium*, *npm run test:parity* | The runner could not build, or the revision breaks Canvas2D/WebGL parity. Reproduce with `npm run test:parity`. | untouched |
| *authorize the runner* | Secrets or the `PUBLIC_URL` variable are missing; the error names them. | untouched |
| *deploy* | ssh failed (host key mismatch, auth), or `deploy.sh` refused the sha, failed to install, or the unit did not come back healthy on the new sha. The log's last `==>`/`!!!` lines say which. | untouched if refused; checkout on the new sha with the old process serving if the install failed; restarted on the new sha if the health check failed |
| *verify it from outside* | The service is healthy on the new revision on the box, but the public url disagrees: nginx, TLS or DNS, not the release. | new revision running |

**To roll back**, dispatch the workflow with the previous sha. The *deploy*
step's log has it as `==> currently at <sha>`, printed before anything
changes. The last successful run's summary also names its commit.

**By hand from the VPS**, the same script takes the sha as an argument:

```sh
cd ~/Repos/babel-index && ./deploy/deploy.sh <40-char sha>
```

When the health check fails, `deploy.sh` prints
`roll back with: ssh <this box> 'deploy <sha>'`. That form works only with the
deploy key, whose forced command runs `deploy.sh`. With your own login, use
the command above.

## What "verified" means here

A restart can fail and still leave something answering 200 on port 5173: the
old process surviving a failed restart, a unit pointing at another checkout,
an `--images` dir that moved. So `health-check.mjs` asks `/api/health` for
more than a 200:

1. **The running commit must match the sha being deployed.**
   `packages/server/version.ts` reads it once at startup, from `BABEL_COMMIT`,
   else the checkout's `.git`. Until it matches, the check retries (90s on the
   box, `BABEL_HEALTH_TIMEOUT`; 60s from outside).
2. **Some failures cannot fix themselves, so they fail at once:** a new
   revision serving zero rooms (a wrong `--images` path), a server that
   cannot name its commit (no `.git`, no `BABEL_COMMIT`), and a url that
   answers 200 with something other than JSON (a proxy error page, a
   default vhost).
3. **It runs twice.** `deploy.sh` checks `127.0.0.1` (did the unit come back
   on the new code?). The workflow re-checks the public url through nginx
   (can anyone reach it?), which is the only check that sees a broken reverse
   proxy.

A failed deploy stops and is not rolled back automatically. An automatic
rollback would pair a working-looking site with a red workflow, easily
misread as flaky CI.

## One-time setup

### 1. On the VPS

Do all of this as the user that owns the checkout. A dedicated
`babel-deploy` user with only this checkout in its home is the stricter
option.

**Let that user restart the service without a password, and nothing else.**

```sh
sudo visudo -f /etc/sudoers.d/babel-index
```

```sudoers
# Check the path first: `command -v systemctl`. sudo matches the command
# literally, so a rule for /bin/systemctl does not authorize /usr/bin/systemctl.
youruser ALL=(root) NOPASSWD: /usr/bin/systemctl restart babel-index
```

`deploy.sh` calls `sudo -n`, so a missing rule fails at once instead of
hanging on a password prompt.

**Generate a key for GitHub to use.** It authenticates a workflow, not you,
so it must be revocable on its own:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/babel_deploy -C 'github actions deploy' -N ''
```

**Pin that key to the deploy script.** In `~/.ssh/authorized_keys`, prefix
the new public key with a forced command and the restrictions:

```
command="/home/youruser/Repos/babel-index/deploy/deploy.sh",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ssh-ed25519 AAAA...  github actions deploy
```

This is what makes a key in GitHub's secret store worth less than a shell.
Whatever command the far end asks for arrives in `$SSH_ORIGINAL_COMMAND` and
is never executed. `deploy.sh` accepts only a 40-hex sha that is already an
ancestor of `origin/main` (its header states both rules). A leaked key can
redeploy main or roll back to something that was main. It cannot get a
shell, read a file, or deploy a branch.

**Write the per-box config, if anything differs from the defaults**
(service `babel-index`, branch `main`, health at
`http://127.0.0.1:5173/api/health`, timeout 90s). `PATH` goes here too if
node came from nvm or asdf, because a forced command runs with a minimal
environment and no login shell:

```sh
sudo tee /etc/babel-index-deploy.conf <<'EOF'
BABEL_HEALTH_URL=http://127.0.0.1:5173/api/health
# BABEL_SERVICE=babel-index
# BABEL_BRANCH=main
# BABEL_HEALTH_TIMEOUT=90
# PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH"
EOF
```

**Run a real deploy from the VPS before GitHub tries one.** This restarts the
service:

```sh
cd ~/Repos/babel-index
git fetch origin main
./deploy/deploy.sh "$(git rev-parse origin/main)"
```

It should end in `==> deployed <sha>`.

### 2. In the repository settings

Under **Settings -> Secrets and variables -> Actions**, as *secrets*:

| Secret | What goes in it |
| --- | --- |
| `DEPLOY_SSH_KEY` | the whole of `~/.ssh/babel_deploy` (the **private** half), including the BEGIN/END lines |
| `DEPLOY_KNOWN_HOSTS` | the VPS's host public keys from `ssh-keyscan -p <port> <host>`, fingerprint-checked against the box (below) |
| `DEPLOY_HOST` | the VPS hostname |
| `DEPLOY_PORT` | the non-standard ssh port |
| `DEPLOY_USER` | the user that owns the checkout |

and as a *variable* (not a secret: it appears on the deployment record and
in the job summary):

| Variable | What goes in it |
| --- | --- |
| `PUBLIC_URL` | `https://centuryglass.us/babel-index/` |

**Check the host key fingerprints against the box, not the scan.**
`ssh-keyscan` over the network is itself trust-on-first-use. On the VPS, in
your existing ssh session:

```sh
for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done
```

Then, from your own machine:

```sh
ssh-keyscan -p <port> <host> > known_hosts.scan
ssh-keygen -lf known_hosts.scan
```

Paste `known_hosts.scan` into the secret only if every fingerprint appears in
the VPS's list.

`DEPLOY_KNOWN_HOSTS` authenticates the VPS to the runner, the reverse of
`DEPLOY_SSH_KEY`. Each runner starts with an empty `known_hosts`, so without
it the runner would trust whatever key answered. An impostor could not steal
the deploy key that way, but it could answer "deployed" having deployed
nothing. The public health check would catch that, but later and less
clearly than an ssh failure.

**The pin breaks when the port or the box changes, which is intended.**
Entries are keyed by host and port (`ssh-keyscan -p` writes the
`[host]:port` form), so changing the ssh port invalidates the secret. The pin
is to the keys in `/etc/ssh/ssh_host_*_key`, so rebuilding the box fails the
deploy until you re-scan.

The workflow's `production` environment gives the repo a deployment record,
and is where a required reviewer goes if a deploy should ever wait for a
click.

### 3. The admin log viewer (optional)

`/admin/logs` (`docs/api.md`) reads the server log from a phone, without
ssh. It needs two env vars on the unit, both unset by default:

```sh
npm run hash-admin-password   # prompts for a password, prints ADMIN_PASSWORD_HASH
```

Add both to the service's environment (an `Environment=` line in the unit, or
an `EnvironmentFile=` it points at). `/etc/babel-index-deploy.conf` is
`deploy.sh`'s config and does not reach the server process.

```
LOG_FILE=/home/youruser/Repos/babel-index/server.log
ADMIN_PASSWORD_HASH=<paste from hash-admin-password>
```

Then restart the service.

- Either variable alone logs a startup warning and mounts nothing
  (`packages/server/index.ts`).
- To rotate the password, run `hash-admin-password` again and paste the new
  hash.
- The log file is untracked, so deploys leave it alone, and it rotates past
  `LOG_FILE_MAX_BYTES` (default 10 MB, `packages/server/log-file.ts`).

### 4. Have the workflow on the default branch

`workflow_run` and `workflow_dispatch` fire only for a workflow file on the
default branch. Until `deploy.yml` is on main, nothing deploys and no
*Run workflow* button appears.

## Things that will bite you

- **`deploy.sh` runs as the version already on the box.** It checks out the
  new revision partway through its own run, so a change to it takes effect
  one deploy late.
- **The checkout is the deploy's to overwrite, except for untracked files.**
  `git reset --hard` discards any hand edit to a tracked file on the box.
  `config.json`, `favorites.json` and (if `LOG_FILE` is inside the checkout)
  the log file are untracked and are the only state this deployment owns, so
  nothing here may ever run `git clean`.
- **A failed install leaves the checkout ahead of the running process.** The
  reset happens before `npm ci`, and the restart after it. If the install
  fails, the old process keeps serving, but the next restart or reboot starts
  the new checkout on a broken `node_modules`. Roll back (or redeploy) before
  anything restarts the unit.
- **`npm ci --omit=dev` deletes `node_modules`, and the CLIP weights are
  cached inside it.** `deploy.sh`'s `install_dependencies` moves that cache
  aside and back. Without it, every dependency bump re-downloads a few
  hundred MB on the first search after deploying.
- **The install carries two flags for this small, CPU-only box:**
  `--maxsockets=1` and `--onnxruntime-node-install-cuda=skip`.
  `install_dependencies` explains each. A larger host can drop both.
- **The reverse proxy must be in front of the server.** The unit's
  `--base-path /babel-index/` rewrites only the urls the page uses, not the
  routes; hit directly on `localhost:5173`, every relative fetch 404s (AGENTS.md,
  "Deployment and the base path"). The live nginx config strips the prefix,
  and must also redirect a bare `/babel-index` to `/babel-index/`.
  `deploy/babel-index.nginx.conf` is a hand-synced reference copy of those
  blocks, not a drop-in include, since the live file also holds TLS and
  unrelated vhosts.
- **With `--favorites` on, the unit also needs `--trust-proxy 1`.** Behind
  nginx, `req.ip` is the proxy, so without it every visitor shares one
  favorite-write rate bucket (AGENTS.md, "Favorite writes are rate-limited by
  `req.ip`"). The reference nginx config already sends `X-Forwarded-For`.
