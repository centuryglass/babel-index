# The catalog — the map's other reading

An alternate mode: the same corpus as one long scrolling list in search order,
every tile unique, story and tags beside each one, and — when a search is
running — the full score breakdown under it. Toggled deliberately, by the
reader, so they decide how much they care to *explore* against how much they
care to *query*.

This document is the plan. Nothing in it is built yet.

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
- Entering and leaving is animated, unless the reader asked for less motion.

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
  passed one) the score breakdown. `RoomCard` renders it; so does every catalog
  row.
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

### 3.6 Images are DOM, not the tile cache

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

### 3.7 The top bar

`SearchForm`, the mode toggle, the paging-mode control, and — visible for the
first time — the result count and `describeSignals`'s note. That note already
exists and is currently only ever *spoken*; a mode built for querying is where
it earns a place on screen.

### 3.8 Row 0 — the centre room

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
}
```

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
- `smoke.e2e.mjs` — toggle in from the panel; row 0 is the centre room; a search
  makes a breakdown appear; switching to pagination and paging forward changes
  the rows; and **the camera has not moved when the map comes back**, read off
  the HUD's `x`/`y` before and after. That last one is the assertion that proves
  the mode carries no state, which is the claim §2 rests on.

## 10. Order of work

1. Step 0 — the extraction. No behaviour change; the suite is the proof.
2. `describeRoom` / `describeCatalog`, and `rankHybrid`'s breakdown +
   `explainScore`. All pure, all testable, no UI yet.
3. `catalog.js` and its tests. Still no UI.
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
2. **Whether the paging choice should persist.** Session-only React state for
   now, like the camera and the history — but this is the one preference a
   returning reader might resent re-picking.
3. **What the catalog does at `contentRatio: 1`.** Nothing, today: it never
   reads `layout`. Worth stating because a dense map and the catalog look like
   the same feature from a distance and are not — see design-history.
4. **Spelling.** New code says `catalog`, US. The existing `centre` spellings are
   untouched and inconsistent with it; that reconciliation is its own pass.
