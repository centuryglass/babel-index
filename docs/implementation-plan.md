# The Index of Babel — implementation plan

Pending task list. Remove tasks as they are completed, the code and git logs will
serve as completed task history.

## Priority: images proxy through the VPS in --remote mode
- `scan.mjs` always emits manifest urls as relative `/images/...` and
  `/shared/...` paths, and `remote.mjs`'s `mountProxy` answers those routes by
  `fetch()`-ing the corpus from R2/Cloudflare and streaming the response back
  through the VPS's own Express process. So every tile byte flows through the
  VPS even when the corpus is hosted remotely - Cloudflare's edge cache and
  rate limiting (`infra/abuse-protection.tf`) only protect the VPS's own
  fetches to R2, not the browser-to-VPS leg, and the CDN's edge PoPs are never
  actually used for image delivery.
- Fix: have the manifest emit absolute urls pointing at `assets_hostname`
  directly when running in `--remote` mode, so the browser fetches images
  from Cloudflare/R2 and only `/api/manifest` and `/api/search` hit the VPS.

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
