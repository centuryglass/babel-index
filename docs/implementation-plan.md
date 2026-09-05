# The Index of Babel — implementation plan

Pending task list. Remove tasks as they are completed, the code and git logs will
serve as completed task history.

## Distill mode:
1. Parse distill_on and distill_off paths from shelf_geometry.svg. They're
   complex shapes, so use the same approach we use for center_book.
2. Add raster overlays distill_on.png and distill_off.png to the set of files
   uploaded by the R2 upload script.
3. When rendering (standard, slide mode, and catalog), render either
   distill_off or distill_on over the center tile as appropriate. They use
   the same corner alignment trick as the fav_* assets, except these anchor on
   the bottom right corner.
4. On mouseover of the active distill_* path, highlight the traced path for
   the current distill state, drawing highlighting after/on-top of the overlay
   PNG, and show either "Enable distillation" or "Disable distillation" in a
   tooltip.
5. When clicking on the current distill_* path, toggle distill mode. Ensure
   the PNG overlay and active vector are swapped appropriately before animating
   the transition.

## A11y:
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
- No e2e coverage yet. A spec favoriting a room from a catalog row, switching
  the sort and reloading would cover the whole path; it needs the demo server
  the suite starts to be given a throwaway `--favorites` path.
- The JSON store is one file written by one process. If a second process ever
  serves this corpus, that is the moment for the Postgres adapter behind
  `FavoriteStore` rather than a lock on the file.

## Other:
- **Check the in-tile search field on an actual iOS device.** Its font size
  is whatever `.center-search input` inherits (13px, the app's body size),
  well under the ~16px that keeps iOS Safari from auto-zooming the viewport
  on focus. The page's `maximum-scale=1, user-scalable=no` viewport meta
  likely suppresses that already, but it needs testing.
