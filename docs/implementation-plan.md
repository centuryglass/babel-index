# The Index of Babel — implementation plan

Pending task list. Remove tasks as they are completed, the code and git logs will
serve as completed task history.

## Map interface:
 - Inpaint the "Catalog" volume in the center tile to give it a more
   distinctive appearance.
 - Generic rooms should probably display some sort of bare minimum RoomDetails,
   so no one tries right-clicking/long pressing on one of those first and
   doesn't bother trying the same on a unique room.

## Search:
- The rules of search ranking and certainty are very approximate, and differ
  from unstated expectations in a lot of subtle ways. Establish a basic set of
  conditions that define how search should act, making sure to cover all the
  odd edge cases.
- Decide on a user-friendly way to present search ranking and certainty to
  users in the catalog mode.


## A11y:
- Add alt text:  The corpus supports alt text but doesn't have it yet.
  Generate via a cheap local LLM, validate, add to metadata under
 [filename]['alt'].
- No actual screen reader testing has happened yet. Learn orca and test
  manually. See accessibility-plan.md for more details on what to check, and
  other lingering questions.
- The ranked results listbox (accessibility-plan.md §3.2) now lives in the
  dev panel, which is `?debug`-only. Give it a non-debug home before this
  matters for anyone relying on the lossless reading of a search.

## Hosting:
- Price out what it'll cost to host somewhere I can target with Terraform CD,
  compare with the hassle of just kludging it onto my VPS with other projects.
- The CORS follow-up for `--remote` mode is done: `infra/r2.tf`'s
  `cloudflare_r2_bucket_cors` (schema confirmed against the provider version
  pinned in `versions.tf`) covers `embeddings.bin`/`metadata.json`'s
  cross-origin `fetch()` calls. Set `app_origins` in `terraform.tfvars` and
  apply before relying on `--remote` mode in production - not yet applied or
  tested against a real Cloudflare zone.
- The Cloudflare abuse protection in `infra/abuse-protection.tf` only scopes
  `assets_hostname` (the R2 bucket). `/api/search` is a much better DoS target
  than static asset serving - it's CPU-bound ML inference on an unprotected
  origin. Add a second ruleset (rate limit + short-TTL cache keyed on the
  query string) scoped to the app's hostname for that endpoint specifically.

## Architecture:
- **`checkJs` is on.** `jsconfig.json` (project-wide, `skipLibCheck`, JSX via
  `react-jsx` since the app uses the automatic runtime) plus `npm run typecheck`
  (`tsc --noEmit`) and `typescript`/`@types/{node,react,react-dom,express}` as
  devDependencies. Not wired into CI yet - it's a local signal for now, same
  spirit as `npm run lint`.
  - First run surfaced two real JSDoc bugs, now fixed: an `import('../../map/
    metadata.js')` / `scoring.js` type reference off by one `../` in
    `useCorpus.js`/`useSearch.js` (silently resolved to nothing, so the linked
    type was never checked), and a `@returns {MapLayout}` in `ordering.js`
    referencing a typedef that was never declared anywhere. Also gave
    `packages/map/metadata.js` a real `RoomMeta` typedef (`joinMetadata` was
    typed as returning `(object|null)[]`, so every downstream reader of a
    room's `keywords`/`story`/`alt` was checked as `object` and silently
    unchecked), and added the `slide`/`catalog` sections `resolveConfig`
    (`config.mjs`) actually returns but its `@returns` didn't mention.
  - After those fixes, ~227 diagnostics remain (`npm run typecheck` to see
    them), almost all the same root cause repeated: hook/function params
    documented as `@param {object} opts` rather than a typed shape, so every
    property and every `.current` read off a ref inside comes back as
    `TS2339` on bare `object`. Heaviest concentrations: `useMapRenderer.js`,
    `slide.js`, `useRearrangement.js`, `tiles.js`, `useMapCursor.js`,
    `useMapCamera.js`, `main.jsx`, `scoring.js`. A few other shapes worth
    knowing about before writing more JSDoc: `useRef(fn)` for a stable-identity
    ref reassigned later (`main.jsx`'s `tapRef`) infers the ref's type from the
    initial closure, not what it's reassigned to, so calls through it come back
    arity-mismatched; a `@param {unknown} raw` narrowed by `typeof x ===
    'object'` still can't be property-accessed without a cast (see
    `normaliseEntry`'s `entry` pattern) because TS's `object` is deliberately
    property-less; asset imports (`.svg`) and CSS custom properties in style
    objects need a small `.d.ts` if imports of them should typecheck at all.
  - So: the JSDoc that exists is basically accurate where it names a real
    type, and wrong or absent in the two ways above. Confirms the plan below -
    typing the data protocols (`RoomMeta`/`MapLayout` now exist; `Manifest`,
    `SearchResult`, `Move`, `Rearrangement`, `Config` don't yet) is where
    `checkJs` earns the most, cheaply, for the size of file it clears.
- **Decided: migrating to TypeScript, file by file.** See AGENTS.md's
  TypeScript bullet for the two file kinds (pure type contract vs. real
  module) and how each runs. `packages/map/manifest.ts` (the `Manifest`
  contract) and `packages/server/port.ts` (a first real-module conversion,
  proving out `build/`'s Node loader hook) are done; `Room`, `Metadata`,
  `SearchResult`, `MapLayout`, `Move`, `Rearrangement`, `Config` are the
  remaining data protocols worth typing early, same reasoning as before -
  they're where a bare `object` currently swallows the most real bugs.
  Application logic converts opportunistically, not on a schedule; the
  deliberately loose shapes called out in AGENTS.md (metadata sidecar
  parsing, `center.js`'s `RUNS`, the animation state in `slide.js`/`camera.js`)
  are the ones to leave for last, once there's a real type worth writing for
  them.
## Other:
- Config variables are still mostly untuned, make sure to take care of that.
- Fonts and text rendering are unpolished, try some alternatives. The
  (uncommitted) font-lab tool can help.
- **Check the in-tile search field on an actual iOS device.** Its font size
  is whatever `.center-search input` inherits (13px, the app's body size),
  well under the ~16px that keeps iOS Safari from auto-zooming the viewport
  on focus. The page's `maximum-scale=1, user-scalable=no` viewport meta
  likely suppresses that already, but it needs testing.
- Should users be able to constrain search to CLIP/keyword/story only?
  Wouldn't be hard to insert some toggles.
