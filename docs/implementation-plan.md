# The Index of Babel — implementation plan

Pending task list. Remove tasks as they are completed, the code and git logs will
serve as completed task history.

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
- The Cloudflare abuse protection in `infra/abuse-protection.tf` only scopes
  `assets_hostname` (the R2 bucket). `/api/search` is a much better DoS target
  than static asset serving - it's CPU-bound ML inference on an unprotected
  origin. Add a second ruleset (rate limit + short-TTL cache keyed on the
  query string) scoped to the app's hostname for that endpoint specifically.
- Although I intend to host it in my VPS, dockerizing it for the sake of
  making future hosting changes easier would be a good idea.

## Favorites:
- The sort control is in the catalog's bar and in the `?debug` panel, but can
  now move to the map, as can the shuffle button:
  1. Update the shelf_geometry.svg import to scan for the new shuffle_button,
     fav_count_toggle, and fave_mine_toggle rectangles.
  2. Update the shared asset upload code to upload the new fav_*.png files
     under assets.
  3. When running the server with favorites enabled, always render
     fav_center_switch_base over the center tile, aligned with the upper left
     corner and scaled in a similar way to how fav_on.png aligns with the
     upper right.
  4. When favorite sort=mine, render fav_mine_on.png above that, also aligned
     with the upper left corner in the same way.
  5. When favorite sort=count, do the same, except with fav_count_on.png
  6. On mouseover of any of the added button bounds parsed from the svg,
     highlight the area as we do with the book interface. On click, apply the
     change in the expected way.
  7. Ensure all of this is reflected in the DOM for a11y purposes. Make sure
     the center book/artist's statement link is there too.
- No e2e coverage yet. A spec favoriting a room from a catalog row, switching
  the sort and reloading would cover the whole path; it needs the demo server
  the suite starts to be given a throwaway `--favorites` path.
- The JSON store is one file written by one process. If a second process ever
  serves this corpus, that is the moment for the Postgres adapter behind
  `FavoriteStore` rather than a lock on the file.

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
