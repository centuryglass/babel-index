# The catalog — the map's other reading

An alternate mode: the same corpus as one long scrolling list in search order,
every tile unique, story and tags beside each one, and — when a search is
running — the full score breakdown under it. Toggled deliberately, by the
reader, so they decide how much they care to *explore* against how much they
care to *query*.

**Built.** This document is the plan it was built from; where the two differ,
what landed is recorded in §12. The one preparatory step it names and did not
need in full - extracting `MapView` out of `main.jsx` - is the open item there.

Two documents govern what follows and are not restated here:
[`implementation-plan.md`](implementation-plan.md) for the map itself, and
[`accessibility-plan.md`](accessibility-plan.md) — whose §3.7 argued this
feature out of scope as an *accessibility* answer while explicitly leaving it
open as "a real toggle for everyone". This is that toggle. See §7 below for
what that distinction obliges.

---

## 1. What it is

- One vertical list. Row 0 is the centre room; every row after it is one corpus
  room, in `order` — the ranking the map is currently showing.
- Every tile unique. No wallpaper, no slots, no gradient. The catalog does not
  consult `layout` at all.
- Each row: the tile on the left, its story and keyword chips on the right.
- Under a search, each row also carries what the ranking actually did to it —
  every signal, weighted and raw, plus its certainty.
- A pinned top bar: the search field, the mode toggle, and the choice between
  pagination and infinite scroll.
- Under a search, the matched text is highlighted where it matched — in stories
  and in keyword chips, **in both modes**.
- Entering and leaving is animated, unless the reader asked for less motion.
- The paging choice and the search history survive a reload.

## 2. The shape that keeps it from being a second app

The whole risk in a second view is that it becomes a second implementation of
the first. Four rules answer that, and everything below is downstream of them.

**One state owner.** `Library` in `main.jsx` keeps every piece of shared state
it already keeps — the manifest, `order`, `result`, `metadata`, `query`,
`history`, the tile cache, the camera. It renders `<MapView>` and
`<CatalogView>` as two presenters over the same state. Neither owns anything
the other needs.

**The map is never unmounted.** This is the one structural decision worth
arguing for, because it dissolves the objection design-history records against
mode toggles — *"modes carry state, and state desyncs"*. In catalog mode the
map's container gets `display: none` and its render effect returns before
scheduling a frame; the camera ref, the tile cache, the pyramid's LRU and the
search-field DOM are all exactly as they were left. There is no resync, because
nothing was torn down.

It is also a correctness requirement rather than a preference.
`useMapCamera`'s listener effect reads `canvasRef.current` once and depends on
the ref *object*, not on the element — so a canvas that unmounts and remounts
comes back with no pointer listeners bound at all. And `cache` is memoised on
`manifest`, so an unmount would re-download every tile on the way back. Keeping
it mounted is the cheap path and the correct one at the same time.

**One primitive, two consumers, every time.** Each thing the catalog needs
already has an implementation, or should have exactly one after this:

| the catalog needs | it reuses | change required |
| --- | --- | --- |
| a room's name | `describeCell` | factor out `describeRoom`; `describeCell` delegates |
| a room's story, caption, chips | `RoomCard`'s body | extract `<RoomDetails>`; the card renders it too |
| the tile's url at a size | `rooms.js`'s `createUrlFor` | none |
| which level to ask for | `pyramid.js`'s `pickLevel` | none — read the policy, don't restate it |
| what the score was | `rankHybrid`'s inner loop | return the components it already computes |
| the shelf's titles | `centre.js`'s `assignTitles` | none |
| the toggle's affordance | `CENTRE_OVERRIDES` / `onOverride` | fill in the seam that ships empty |
| "less motion, please" | `prefersReducedMotion()` | none |
| what a search found | `describeSignals` | none — it becomes visible instead of only spoken |
| where the query matched | `fold` / `tokenise` | add `foldWithMap` and two range finders beside the two scorers |

**Pure logic lives outside the component.** `packages/web/src/catalog.js` is the
pure half — paging, the mounted window, spacer heights, thumbnail level — with
no DOM and no React, asserted browser-free in `catalog.test.mjs`. The same split
`picking.js` and `centre.js` already make.

## 3. What has to be built

### 3.1 Step 0 — a preparatory extraction that changes nothing

`main.jsx` is 1581 lines. The catalog adds ~400 more, and a diff mixing a
mechanical move with a new feature is unreviewable. So the first commit moves
code and changes no behaviour, and `npm test` plus the e2e suite are what prove
it inert:

- `MapView.jsx` — the canvas element, the two centre-tile overlays, the render
  effect, the map's `onKeyDown`, the HUD.
- `RoomCard.jsx` — moved as-is.
- `RoomDetails.jsx` — new. The caption, the story, the keyword chips, and (when
  passed one) the score breakdown and the highlight ranges. **Three** consumers,
  not two: `RoomCard`, every catalog row, and the canvas's own nested fallback
  content — which is the same story-and-chips markup written a second time
  today, and is where a touch screen reader reads a room. A `chipTabIndex` prop
  covers the one difference (the fallback's chips are `-1` so the map stays one
  tab stop).
- `SearchForm.jsx` — new. The controlled input and its submit. The centre tile's
  field and the catalog's top bar are then the same component in two boxes,
  which is what stops "what does Enter do" being written twice.

What stays in `main.jsx`: `App`, `Library`, and everything shared —
notably `canvasRef`, `useMapCamera`, `cache`/`renderer`, `search`, and the
rearrangement effect. `MapView` receives `canvasRef` and attaches it. The camera
hook must not move down with the canvas, or `flyTo` stops being reachable from
`openRoom`, `goToSearch` and `startRearrangement`.

### 3.2 The score breakdown needs data nobody keeps

`rankHybrid` computes every component per room and returns none of them. It
gains a `breakdown`, parallel to `order` — i.e. **by rank**, the same convention
`certainty` already uses and documents:

```js
breakdown: {
  clip:      Float32Array,  // min-maxed across the corpus for this query
  cosine:    Float32Array,  // the RAW cosine, or NaN with no blob
  keyword:   Float32Array,  // ratio, absolute
  story:     Float32Array,  // ratio, absolute
  score:     Float32Array,  // the blended total actually sorted on
}
```

Six arrays of `count` floats — 120 KB at 5000 rooms, allocated in a loop that
already runs. Always returned, not gated on a flag: a second code path that
computes scores differently for display is the bug this is meant to avoid.

Then one pure function, `explainScore(rank, { breakdown, certainty, weights })`
in `scoring.js`, returning ordered `{ label, weighted, raw, note }` rows. Three
consumers: the catalog row, the room card, and anything later.

**The reason this is worth doing carefully.** `scoring.js`'s header states the
rule — *certainty is absolute; ranking is relative* — and the catalog is the
first place a reader can actually see the difference. Some room scores CLIP 1.00
for *any* query, `cghjj` included, because the column is min-maxed. So the
breakdown must show the raw cosine next to the normalised one, and certainty as
its own line. A row reading `CLIP 1.00 (cosine 0.14 — below the floor)` is the
honest rendering, and a row reading `CLIP 1.00` alone is a lie the codebase has
a written rule against. `scoring.test.mjs` should assert exactly that pair.

### 3.3 `describe.js` gains a primitive and a sentence

- `describeRoom(id, rank, total, entry)` — the naming, with no cell to resolve.
  `describeCell` becomes: resolve the cell, then call this. One implementation
  of what a room is called, which is the file's entire premise.
- `describeCatalog({ total, query, signals })` — the live-region line for this
  mode, sibling to `describeArrangement`. `describeArrangement` speaks about
  clustering near the centre and means nothing here; reusing it would be worse
  than a second sentence.

### 3.4 `catalog.js` — the pure half

- `pageOf(order, page, perPage)` — the slice. **The one primitive both paging
  modes share**; pagination mounts one page of it, infinite scroll mounts
  several. That is the whole difference between the two options, and it is why
  they are not two features.
- `mountedPages(active, pageCount, window)` — which pages are live and which
  collapse to a spacer.
- `spacerHeight(pages, rowHeight)` — exact, not estimated (see below).
- `thumbLevel(cssWidth, dpr)` — delegates to `pyramid.js`. No budget, ladder or
  tile dimension is restated here.
- `rowHeight(cssWidth)` — from `BASE_TILE`'s aspect plus the row's padding.

### 3.5 Rows are a fixed height, and that is load-bearing

A sliding window needs spacers whose height is *exactly* what the dropped rows
would have occupied; guess wrong and the scrollbar jumps every time a page is
recycled. Stories vary in length, so a row that grows with its story cannot be
windowed by arithmetic — it needs measurement, which is a virtualiser.

So the row is fixed: the tile sets the height, and the story is clamped to fit
with `-webkit-line-clamp`. The full story is one click away in the room card,
which already exists, already manages focus, and already shows exactly this
content via `RoomDetails`. No in-place expansion — that reintroduces the
variable height the fixed row exists to remove.

### 3.6 Highlighting — the view must not invent its own idea of a match

Under a search, the matched text is marked where it matched: in every story and
every keyword chip, in the catalog's rows **and** in the map's room card. Two
things make this harder than a substring search, and both are reasons it belongs
in `scoring.js` next to the scorers rather than in a component.

**It must mirror the two match rules exactly, including their asymmetry.** The
codebase's sharpest scoring rule is that keyword partials divide by the
*keyword* while story matches divide by the *query* — opposite on purpose. The
rules they come from differ in kind too: a keyword matches by **substring**
(`k.includes(token)`), a story word matches by **prefix** (`word.startsWith(token)`,
a cheap stand-in for stemming). A single highlighter applied to both would mark
text that did not score and miss text that did, and it would do so silently.
So there are two, named for the scorers they shadow and sitting directly beneath
them:

```js
keywordMatchRanges(text, foldedQuery, queryTokens)  // substring, mirrors keywordScore
storyMatchRanges(text, queryTokens)                 // prefix-of-word, mirrors storyScore
```

Both take the *same* `foldedQuery` and `queryTokens` the ranking was computed
from, so a token dropped for being a stopword or under `minTokenLength` cannot
highlight — it did not score, so it does not mark. That falls out of reusing the
inputs rather than re-deriving them, which is the point.

**Folded offsets do not survive back to the original text.** `fold` is NFD,
strip combining marks, lowercase, trim — and each of those can change length.
Decomposed `cafe\u0301` (5) folds to `cafe` (4); `İ` lowercases to two code
points from one. Matching happens on folded text, but the `<mark>` has to land
on the *original*, so a folded index is not an original index and using one as
the other misplaces every highlight on any corpus with an accent in it.

So `foldWithMap(text)` returns `{ folded, map }`, where `map[i]` is the original
index that produced folded character `i`, built one code point at a time. `fold`
stays exactly as it is and becomes a one-line caller of it, so there is still one
definition of what folding means.

Two smaller decisions, both recorded because they are choices:

- A story highlight marks the **whole matched word**, not just the prefix that
  scored. `survey` marks all of `surveyed`. Marking three-quarters of a word
  reads as a rendering bug; marking the word reads as "this is why it is here",
  which is what the reader is asking.
- Ranges are merged and sorted before rendering, because two query tokens can
  overlap on the same span and nested `<mark>` elements are not what anyone
  wants.

Rendering is `<Highlight text ranges />` — splits into text nodes and `<mark>`s
and nothing else. The ranges are pure and tested; the component is four lines
and has nothing to get wrong.

### 3.7 What persists, and what deliberately does not

`packages/web/src/persist.js` — `load(key, fallback)` and `save(key, value)`
over `localStorage`, both wrapped in try/catch. That is not defensive padding:
Safari's private mode throws on `setItem`, and a storage exception on a search
would otherwise take the whole search down with it. A read that throws returns
the fallback, and the app behaves exactly as it did before this file existed.

Two things persist, under `babel:` keys:

- **The paging choice.** The one preference a returning reader would resent
  re-picking, and §11 already flagged it.
- **The search history.** This is the bigger change, and it is not only a
  convenience: history is what titles the centre room's shelf, so persisting it
  means **the wall of books now survives a reload** instead of resetting to
  keyword tags each session. The shelf becomes a record of what this reader has
  asked the library, which is closer to what the concept describes than a wall
  that forgets. Still bounded by `HISTORY_SLOT_COUNT` — the wall's size is the
  cap, as it already is.

  Two consequences to accept deliberately. A reader's past searches now sit on
  their machine and on their screen, so the panel gains a **"forget searches"**
  control — persisting someone's typed input without giving them a way to clear
  it is not a thing to ship. And the shelf is no longer identical on every
  first load, which matters to screenshots and to anyone reasoning about the
  opening view.

What stays session-only, and why it is not an oversight: the camera, the current
ranking, the mode, and the two dev sliders. Restoring a reader to a camera
position they cannot remember choosing is disorienting, and the opening view is
derived from the display precisely so it is right on the device in front of
them.

### 3.8 Images are DOM, not the tile cache

`<img loading="lazy" decoding="async">` with `width`/`height` set from
`BASE_TILE`'s aspect so the browser reserves the space before the bytes arrive.
`src` comes from `createUrlFor(manifest)` at `thumbLevel(...)`.

`tiles.js` is deliberately *not* involved. Its LRU and frame-aware eviction
exist to serve a canvas render loop that draws thousands of cells per frame;
a scrolling list of twenty `<img>` elements wants the browser's own cache, and
wiring the canvas cache into DOM images would be a second consumer for machinery
whose invariants are all about frames.

The honest cost: a room seen in both modes may be downloaded at two levels.
Bounded, and cheaper than the alternative.

### 3.9 The top bar

`SearchForm`, the mode toggle, the paging-mode control, and — visible for the
first time — the result count and `describeSignals`'s note. That note already
exists and is currently only ever *spoken*; a mode built for querying is where
it earns a place on screen.

### 3.10 Row 0 — the centre room

The tile on the left; on the right, the shelf as real links. The forty slots
`assignTitles` already returns: search history newest-first, then keyword tags,
each one clickable and running the same `onBook` the painted spines run. This is
the one view where the whole shelf is legible at once, and it costs no new logic
— the same array, rendered as text instead of as geometry.

## 4. The toggle

**Primary — an override book.** The seam already exists and ships empty
precisely for this:

```js
const CENTRE_OVERRIDES = { 0: { text: 'the catalog', action: 'catalog' } };
```

and `onOverride` grows its first `case`. Slot 0 is the top-left book, reserved
before history fills the wall. `assignTitles` already displaces history past a
reserved slot rather than overwriting it, and `centre.test.mjs` already asserts
that — so filling this in is genuinely the only change.

**Secondary — a button in the dev panel.** A book is only reachable while
`areSpinesLegible` says the spines can carry a title, which means zoomed in on
the centre. A reader out in the far field needs a way in that does not require
flying home first, and a keyboard reader needs one that exists at every zoom.
Both call the same `setMode`.

**Back out — the top bar's toggle.**

**On load** — `?catalog` in the query string opens straight into it, read once
at module scope exactly as `?touchdebug` is. Read-only: the toggle does not
write the URL back, so there are no history-entry semantics to design. It makes
the mode linkable and lets the e2e suite land in it without a click.

## 5. What a search does in catalog mode

`search()` sets `animateNext.current = true`, which today lands in the
rearrangement layout-effect and flies a camera nobody is looking at. The effect
gains one early return for `mode !== 'map'`.

The consequence is already a supported path, not a new one: the map's `layout`
and `order` still update, so on returning to the map the new arrangement is
simply *there*, rebuilt instantly. That is exactly the fallback
`buildRearrangement` returning null already takes, and it needs no code.

## 6. The transition

Reduced motion swaps at once — `prefersReducedMotion()`, the same escape hatch
`startRearrangement` uses, checked before anything else happens.

Otherwise it is a FLIP on one element, not a rAF loop:

1. Read the centre cell's screen rect — `centreCellRect(cam.current, viewport)`,
   which exists and is tested.
2. Mount the catalog hidden, measure row 0's tile rect.
3. Transform row 0's tile from the first rect to the second on a CSS transition,
   cross-fading the canvas out and the rest of the list in.

Leaving reverses it, and needs no fly-home: the camera is exactly where it was
left, so the target rect is `centreCellRect` again on the same camera.

**The edge case that matters:** if the centre cell is off screen — the reader
panned away before toggling — there is no rect to fly from, and the transition
degrades to a plain cross-fade. `overlapsViewport` already answers "is it on
screen" and is already exported.

Duration goes in config as `catalog.transitionMs`: nothing derives from it and
no test pins its value, which is the stated test for what belongs there.

## 7. What this owes the accessibility plan

`accessibility-plan.md` §3.7 rejected a linear list *as an accessibility mode*,
for four reasons. Three of them are about routing screen-reader users away from
the artwork, and none of them apply to a control every reader chooses for
themselves. Three obligations follow, and they are not optional:

- **The catalog is not the accessible mode, and nothing may present it as one.**
  Nothing detects a screen reader, nothing defaults into it, and the map's
  ranked listbox stays exactly where it is in the panel. The map remains fully
  usable; the catalog is an artistic control about exploring against querying.
- **`role="application"` stays scoped to the canvas.** The catalog is ordinary
  DOM throughout — the rule that it must not creep onto the panel or the card
  covers this too.
- **One live region for the whole app.** The `role="status"` node currently
  lives inside the panel, which the catalog replaces. A mode flip would unmount
  and remount the region, and a screen reader loses a region that vanishes. It
  moves up to `Library`, outside both views, so there is exactly one.

Two smaller notes. §3.7 argued the linear reading should be a `listbox` rather
than a list; that argument was about the panel's ranked results, and it does not
carry here — a listbox option cannot contain the keyword chips every row has, so
the catalog is a `<ul>` of rows whose primary action opens the card. And row
heights being fixed means the sliding window never reflows under a reader
mid-scroll, which is a real accessibility property and not only a performance
one.

## 8. Config

```js
catalog: {
  perPage: 20,        // rows per page; the unit both paging modes slice by
  windowPages: 1,     // pages kept mounted either side of the active one
  transitionMs: 380,  // 0, or reduced motion, means swap at once
  paging: 'scroll',   // the DEFAULT only - a stored choice wins over it
}
```

`paging` is the default for a reader who has never chosen, not the setting
itself. A stored choice overrides it, which is the ordinary relationship between
config and a preference and is worth stating because every other value in this
block is the live number.

## 9. Tests

Everything below has to be able to fail. Per the repo's rule, each new e2e
assertion gets broken on purpose before it is believed.

- `catalog.test.mjs` — paging, the mounted window, spacer arithmetic against
  fixed row heights, and that `thumbLevel` never asks for a level the corpus
  lacks.
- `scoring.test.mjs` — `explainScore`'s rows, and the one that guards the
  written rule: a room with normalised CLIP 1.00 and a raw cosine under
  `clipLow` must render as uncertain.
- `describe.test.mjs` — `describeRoom` names the same room `describeCell` does,
  and `describeCatalog`.
- `scoring.test.mjs` again, for the ranges, and the cases are the ones that
  actually break: a decomposed accent (`cafe\u0301`) marking the right span in
  the ORIGINAL text; a stopword and an under-length token marking nothing,
  because they scored nothing; `survey` marking the whole of `surveyed` in a
  story but a keyword matching by substring rather than prefix; and two
  overlapping tokens producing one merged range rather than two nested ones.
  The invariant worth asserting directly: **anything marked scored, and anything
  that scored is marked** — run the scorer and the range finder over the same
  inputs and assert they agree on whether there was a match at all.
- `persist.test.mjs` — a throwing `localStorage` (private mode) leaves `load`
  returning the fallback and `save` silent, and stored junk does not crash a
  load. Injected, not mocked globally.
- `smoke.e2e.mjs` — toggle in from the panel; row 0 is the centre room; a search
  makes a breakdown appear; switching to pagination and paging forward changes
  the rows; and **the camera has not moved when the map comes back**, read off
  the HUD's `x`/`y` before and after. That last one is the assertion that proves
  the mode carries no state, which is the claim §2 rests on.

## 10. Order of work

1. Step 0 — the extraction. No behaviour change; the suite is the proof.
2. `describeRoom` / `describeCatalog`, `rankHybrid`'s breakdown + `explainScore`,
   and `foldWithMap` + the two range finders. All pure, all testable, no UI yet.
3. `catalog.js` and `persist.js`, and their tests. Still no UI.
3a. Highlighting and persistence reach the MAP first — `RoomDetails` with
   `<Highlight>` in the room card and the canvas fallback, history and the
   "forget searches" control in the panel. Both features ship and are visible
   before the catalog exists, which means neither is entangled with it and the
   catalog inherits them already working.
4. `CatalogView` with pagination only, reached from the panel button.
5. Infinite scroll — the second mount rule over the same `pageOf`.
6. The override book, and `?catalog`.
7. The transition.
8. The e2e pass.

Steps 2 and 3 land useful, tested code before any of it is visible, which is
what keeps the UI commit small enough to read.

## 11. Still open

1. **Does the catalog respect "rooms on the map"?** Decided: no. It lists the
   whole corpus in `order`. That slider is a dev control over *placement*, and a
   catalog that hid rooms because of it would misreport the corpus size. Worth
   revisiting only if the slider ever becomes a reader-facing control.
2. **Whether a stored history should expire.** It is capped by the wall's size,
   not by age, so a search from months ago can still be titling a book. Cheap to
   add a timestamp; not obviously wanted, since the shelf reading as a long
   record is arguably the point.
3. **What the catalog does at `contentRatio: 1`.** Nothing, today: it never
   reads `layout`. Worth stating because a dense map and the catalog look like
   the same feature from a distance and are not — see design-history.
4. **Spelling.** New code says `catalog`, US. The existing `centre` spellings are
   untouched and inconsistent with it; that reconciliation is its own pass.

---

## 12. What changed on the way

Four things the plan got wrong or under-specified, all found by measuring or by
sabotaging a test rather than by reading:

1. **The step-0 extraction was only half needed.** `RoomDetails`, `SearchForm`
   and `RoomCard` came out as planned and each earned it - `RoomDetails` has
   three consumers, and the canvas's fallback content turned out to be a second
   copy of the card's markup nobody had noticed. `MapView` did not come out:
   once the map was going to be HIDDEN rather than unmounted, the canvas, its
   two overlays and the render effect stayed where they were behind one
   `display: contents` wrapper, and moving them would have been churn without a
   reader. `main.jsx` is still long. That remains worth doing and is now the
   only unpaid part of this plan.

2. **The row height needed the text column, not just the tile.** §3.5 assumed
   the thumbnail sets the height. On a narrow display it does not - the tile
   shrinks and the story, chips and score do not - so `rowHeight` takes the max
   of the two. Found by comparing a row's `offsetHeight` against its own
   `scrollHeight`, which is the only way this shows up: the clipped content is
   simply invisible.

3. **The score breakdown needed a second LAYOUT, not a second computation.** The
   card's table is 108px in a 202px row and clipped its own last line. So
   `explainScore` still runs once and `ScoreBreakdown` renders it either as that
   table or as a one-line strip that never wraps. The two can disagree about
   shape and never about the score. The strip being exactly one line whatever
   the query matched is what keeps rows uniform, which the spacers depend on.

4. **The centre row cannot be a fixed height.** It holds forty shelf titles,
   which wrap to as many lines as the width needs, and cropping them to a tile's
   height hides the newest searches - the whole point of the wall being a
   record. It is allowed to size itself precisely because it sits outside the
   paging arithmetic, and its measured height became the scroll conversion's
   lead offset.

And one thing the plan called for that turned out to matter more than it
sounded: **the e2e assertion that the camera survives a mode switch is not
enough on its own.** Sabotaging the design by remounting the map (`key={mode}`)
left the camera, the zoom and the tile cache all correct, because that state
lives in `Library` and never moved - and the map silently stopped panning,
because `useMapCamera` binds its listeners once against the ref object. The test
now drags after switching back. Every assertion cheaper than that one passed
under the bug.
