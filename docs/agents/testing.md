# Testing

Hazards for coding agents working on tests, CI checks and the e2e suite.
`AGENTS.md`'s "Things that will bite you" routes here, and its conventions
still apply.

## Testing and CI

- **`check:requirements` maps tests to `docs/search_requirements.md` by tag.**
  A test names the requirement it covers in its own name
  (`test('... [SR-18]', ...)`); the checker rebuilds the mapping from
  `git ls-files` each run. An `SR-nn` id is permanent (that file's header
  states the rule). The check fails on a tag naming no requirement, and on a
  requirement losing coverage `baseline.json` says it had. Gaining coverage
  prints the command that lowers the baseline. A `_(judged)_` requirement
  has no failing assertion and is counted apart from the gaps.
- **`check:file-map` diffs `docs/file_map.md` against `git ls-files`** (see
  `AGENTS.md`, "Layout"; `tools/check-file-map/index.ts`'s header has the exact rules).
- **`npm run test:parity` is a deploy gate, not a merge gate.** The
  `.parity.ts` suffix matches neither the unit nor the e2e glob. `deploy.yml`
  runs it before the ssh call, and a failure stops the deploy. It runs on a
  CI runner's GPU-less Chromium (SwiftShader WebGL2). Its header explains
  the scene choices.
- **`openLibrary()` pins every e2e spec's renderer, defaulting to Canvas2D.**
  It always puts `webgl=0` or `webgl` on the query string, and only
  `webgl-map.e2e.ts` and `render-parity.parity.ts` pass `webgl: true`. The
  blank/repaint probes (`fingerprint`, `getImageData`) need a 2D context. A
  spec that loaded the page some other way would switch renderer with the
  production default.
- **When to run e2e locally.** On the maintainer's machine (Arch Linux per
  `/etc/os-release`) Chromium is preinstalled and the suite is cheap: run it
  whenever a change touches tested behavior. In a cloud agent container it
  is slow; run it only when editing e2e specs or behavior they exercise
  (the rearrangement, camera or search state machines), and otherwise rely
  on `npm test`, lint, and CI's e2e gate.
- **Wait on a condition, never a duration.** A flaky browser test blocks
  every merge. `settled()` waits until the HUD stops starting with
  `"rearranging"`, which covers prepare, flight and slide, but not the
  network: anything asserting on `blank` tiles or HUD text polls (bounded)
  rather than trusting the first read.
- **Where settling matters, poll for two agreeing reads with a real gap
  between them.** Two reads either side of a slow call can describe two
  different renders; two back-to-back reads prove nothing.
- **Test cleanup belongs in `finally`.** The tests in one `*.e2e.ts` file
  share one `page`, so skipped cleanup strands slider and camera state for
  every later test, turning one flake into several failures.
- **A green e2e test that cannot fail is worse than none.** When you change
  one, break the app and confirm the test fails. That includes
  its cleanup.
- **Assert on the accessible name, not raw ARIA attributes.** Attribute
  behavior differs across Chromium builds, and CI and local can run
  different ones (`BABEL_E2E_CHROMIUM`). Anything a reader must hear belongs
  in the label.
- **An accessibility assertion dumps the node it failed on,** since the
  failing run is usually on a machine you can't open a browser on.
- **CDP touch injection bypasses real gesture arbitration.** The touch tests
  in `map-gestures.e2e.ts` can't see `touch-action`, `pointercancel` or the
  real capture lifecycle. Confirm suspected gesture bugs on a device with
  `?touchdebug`.
- **A 'center' click during a rearrangement does nothing** (see
  `rearrangement.md`, "The board is finite only because the camera is
  parked"). A test whose setup may
  follow a search uses `e2e/support.ts`'s `recentre()`, not a bare click.
