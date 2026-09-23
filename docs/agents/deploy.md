# Deployment and releases

Hazards for coding agents working on the base path, deploying to the VPS,
and releases. `AGENTS.md`'s "Things that will bite you" routes here, and its
conventions still apply.

## Deployment and the base path

- **`--base-path` does not change how Express routes anything.** Every route
  in `app.ts` is mounted unprefixed. The VPS's nginx config
  (`deploy/babel-index.nginx.conf`, `deploy/README.md`) strips the prefix:
  `location /babel-index/ { proxy_pass http://localhost:5173/; }`, trailing
  slash on both sides. An Express-side mount at the same prefix would strip
  twice and 404 everything.
- **Every url this server hands the browser is relative.** A root-absolute
  url (`/api/manifest`) resolves against the origin root, above the subpath,
  and never reaches the proxy. `scan.ts`'s `IMAGES_BASE`/`SHARED_BASE` and
  the client's `fetch()` calls (`main.tsx`, `useSearch.ts`) have no leading
  slash. A new one with a leading slash works at the root and breaks the
  deployment.
- **`<base href>` makes a relative url resolve under the subpath,** so
  `app.ts` injects it immediately after `<head>`. `base-path.ts`'s
  `normalizeBasePath` is the one place the flag's slashes are decided.
- **A bare visit to the subpath must redirect to add the trailing slash**
  (nginx's `location = /babel-index { return 301 ... }`). Until the page has
  loaded and set `<base href>`, a relative url resolves against the last
  `/`-terminated segment of the document location.
- **`--base-path` is meaningless without the proxy.** Hitting
  `localhost:5173` directly with the flag set serves a page whose every
  relative fetch 404s. That is expected; test the subpath behind nginx.

## Deploying to the VPS

Setup and rollback are in `deploy/README.md`. The invariants:

- **A 200 is not a successful deploy.** An old process surviving a failed
  restart, a unit pointing at another checkout, or a moved `--images` dir all
  answer 200. `/api/health` reports the running commit, and
  `health-check.mjs` compares it to the sha being deployed. A release on the
  right commit with zero rooms fails immediately rather than retrying.
- **`version.ts` is read once at startup, never per request.** Re-reading
  `.git` would report the checkout, not the code in memory - the mismatch
  the health check exists to catch.
- **The deploy key is an SSH forced command pinned to `deploy/deploy.sh`.**
  The requested sha must match 40 hex characters and already be an ancestor
  of `origin/main`, so the key can deploy or roll back only what reached
  main. Loosening either check turns a narrow credential into a login.
- **Both halves of the health check run.** `deploy.sh` checks `127.0.0.1`
  (did the unit come back on the new code?). The workflow re-checks the
  public url (can anyone reach it?), which is the only one that sees a
  broken reverse proxy.
- **A failed deploy is not rolled back automatically.** It stops and prints
  the previous sha, and the workflow's dispatch input takes a sha, so a
  rollback is one manual run. An automatic rollback would pair a
  working-looking site with a red workflow, easily misread as flaky CI.
- **`deploy.sh` runs as the version already on the box**, since it checks out
  the new revision partway through its own run. A change to it takes effect
  one deploy late.

## Release discipline

- **Releasing is a second PR.** `release-please.yml` keeps a standing release
  PR up to date; nothing is tagged, versioned or changelogged until a human
  merges it. Never hand-edit `package.json`'s `version` or
  `.release-please-manifest.json`.
- **`deploy.yml` deploys only the release merge.** Its `if` matches a head
  commit starting `chore(main): release `, so an ordinary merge to main
  builds and tests but never ships. `workflow_dispatch` is the hatch for an
  urgent fix between releases.
