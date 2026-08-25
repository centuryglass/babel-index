# The Index of Babel — implementation plan

Pending task list. Remove tasks as they are completed, the code and git logs will
serve as completed task history.

## Map interface:
 - Inpaint the "Catalog" volume in the center tile to give it a more
   distinctive appearance.
 - Generic rooms should probably display some sort of bare minimum RoomDetails,
   so no one tries right-clicking/long pressing on one of those first and
   doesn't bother trying the same on a unique room.

## Help icon:
 - A small circled "?" icon button. (TODO: center tile book, or another
   floating overlay?) Clicking it brings up a description of the basic
   interface and functionality: Navigation, switching to catalog, opening
   room info, etc.

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
