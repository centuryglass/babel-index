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
- Fix the CLIP cosine bounds, they're way off. Branch
  claude/clip-cosine-range-analysis-r3vslg has analysis code that will help.
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
- Search on a cheap VPS: `/api/search` runs the CLIP text tower per request
  with no concurrency cap and no cache, so a burst of distinct queries piles
  up on however many threads `onnxruntime-node` uses, each paying full
  inference cost. Add an LRU cache keyed on `(query, dtype)` since repeat
  searches are common, and bound concurrency with a small queue sized to CPU
  cores so a burst degrades to latency instead of thrashing the CPU.
- The Cloudflare abuse protection in `infra/abuse-protection.tf` only scopes
  `assets_hostname` (the R2 bucket). `/api/search` is a much better DoS target
  than static asset serving - it's CPU-bound ML inference on an unprotected
  origin. Add a second ruleset (rate limit + short-TTL cache keyed on the
  query string) scoped to the app's hostname for that endpoint specifically.

## Architecture:
- **Split up `packages/web/src/main.jsx`.** It holds 19 pieces of state, 18
  refs and 8 effects, and hands `MapView` 38 props; the coordination between
  the search, the rearrangement and what gets announced lives in mutable refs
  and effect ordering rather than anywhere a reader can see it. Six extractions,
  ordered by risk, in [`state-architecture-plan.md`](state-architecture-plan.md).
- **Turn on `checkJs`.** The pure packages already carry JSDoc `@param`/
  `@returns` on ~180 declarations and nothing checks any of it. A `jsconfig.json`
  with `checkJs` plus a `tsc --noEmit` lint step costs one config file and no
  syntax change, and answers the question the entry below depends on: is the
  JSDoc that already exists actually accurate?
- **Then decide about TypeScript.** The data protocols between modules -
  Manifest, Room, Metadata, SearchResult, MapLayout, Move, Rearrangement,
  Config - are where the value would be, and they are worth typing first if
  anything is. Pending review rather than settled: run `checkJs` for a while
  first, and let what it catches (or fails to catch) decide how far to go.
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
