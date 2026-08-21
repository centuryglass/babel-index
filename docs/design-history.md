# Design history — reversed decisions and rejected alternatives

The implementation plan and the code describe how things work *now*. This file
records the roads not taken: decisions that were reversed, and alternatives that
look obvious enough to be worth re-proposing unless someone writes down why they
were rejected. Consult it before re-treading one; it is not a changelog and does
not need to stay exhaustive.

## Rearrangement: cross-fade → sliding-tile illusion

The map first cross-faded rooms in place: a search swapped one array and every
slot stayed put, so what changed was content, not position, and inventing motion
would have been dishonest.

That premise expired when the search density gradient made certainty an input to
placement (§3f). A search now genuinely relocates slots, so a cross-fade would be
*hiding* a movement rather than declining to invent one. The rearrangement became
a sliding-tile illusion instead: whole rows and columns rotate, and nothing is
seen to cross anything else.

Rejected alternatives for that motion, and why:

- **Free-form glide** along each room's true heading is cheap and answers the
  "leaves left, returns right" problem by construction — but it treats the
  wallpaper as empty space. The map's cells are walls, not slots on a board: the
  generic room is as much a wall as a corpus room, and 80% of cells being
  identical is a fact about the art, not a licence to slide a room *over* them. A
  room gliding across the wallpaper reads as a tile floating above a backdrop,
  and the grid stops being somewhere you are standing. A whole line moving as one
  piece is the only way a room travels without the grid ceasing to be a space.
- **Per-cell spine flip** is a card trick, not a library.
- **Plain dissolve** says less than the stagger and costs the same.

One thing the cross-fade design got right survives: sequence the rearrangement
*after* the fly home, not against it. Two animations competing for attention and
neither lands. (It is also structurally necessary — the plan is made against
exactly the cells on screen, so it cannot be made until the camera stops.)

The animation was also once strictly sequential, which put a desktop
rearrangement at four seconds. Playing a batch of parked columns as a concurrent
wave rather than a queue took it to just over one; see the reorder-animation
section of the plan for how.

## Curation: dropped

The concept (step 3) had a review tool — 1–5 scores, free-text tags,
`x`-to-reject, SQLite behind it. It is gone. Curation happens at generation time
(boring variants are discarded before they reach a corpus directory), and the
three retrieval signals make a second, manual vocabulary redundant: a hand-typed
tag is a worse keyword than the keyword the generator already knows, and a 1–5
score is a worse relevance signal than a text query against it.

What survived, and is not curation: **border drift** (mean + peak deviation from
the corpus mean frame), demoted from a review sort key to a pipeline report,
because it measures a structural defect (art reaching the frame, which tiles as a
bright blot at every junction) rather than taste. Perceptual hashing went with
the rest of the tool. Consequences: the `curate/` package, `score`/`tags`/`status`
in the room schema, and SQLite all left.

## Flight duration: source constant → config

`flightMs` first landed as a source constant, argued to belong there because it
was "the feel of a gesture, not a property of the library being displayed." That
test is the wrong one: config describes how to display a library, not which
library, so being independent of the corpus is what config is *for* —
`defaultZoom` is the same kind of number and was always config. The rule that
actually keeps things out of config is that they are *derived and asserted*
rather than tuned; `flightMs` derives from nothing and no test pins its value, so
it moved in. (`WHEEL_ZOOM_RATE`, `LONG_PRESS_MS` and `PRESS_SLOP_PX` are still in
source only because they predate `packages/config` — an argument for moving them,
not for leaving the flight behind.)

## The tile: 1024² → 1024×768

The square shelf felt cramped; 4:3 gives the books room without changing what a
tile *is*. The render, the trace and `BASE_TILE` moved together, and the only
knock-on in code was the coarsest cache budget — a shorter tile fits more rows,
so the worst-case screen went 5700 → 7500 cells and its budget 7000 → 8200.
Whether 4:3 is final is an art call; nothing downstream assumes it. Treat any
"1024²" still in prose as a stale bug, not a fact.

## The centre trace: story-exact 5×32 → a UI-sized wall, and the lamp dropped

The centre tile's book grid was traced to match Borges exactly - 5 shelves of 32
books, 160 total - and `checkAgainstStory()` failed loudly if a re-trace drifted
from those numbers. That premise broke on contact with the feature it was for:
at story-accurate spine width, a composited search-history title is a handful of
illegible pixels. Usable text needs fewer, wider books, so the centre's own book
count is now a UI choice sized for legibility, not a restatement of the story's
shelf - 3 shelves, 40 books at the time of writing, with the middle shelf split
into two runs around a baked-in "Index of Babel" nameplate that occupies no book
slot at all. `checkAgainstStory` and the STORY coupling in `geometry.js` are
gone; what is still asserted is the trace's own internal consistency (books
inside the opening, no overlap, one baseline per shelf), not any particular
count. `centre.js`'s hit-test walks per-shelf *runs* rather than per-shelf
*bands* for exactly this reason - a shelf split by art must not resolve a click
over the gap to a phantom book.

The case uprights, the shelf boards and the lamp were traced for the same reason
the story-exact count was: fidelity to the render, not because anything read
them. Nothing in the app ever drew the lamp - it was baked into the tile pixels
from the start - and once the case frame stopped needing uprights to compute (the
opening is now just the bounding box of the books themselves), tracing them was
effort spent on numbers nothing consumed. The trace is now exactly two kinds of
rect: `book<n>` and one `search_box`, the latter reserving where a live search
field will eventually sit on the tile - traced and exposed as
`CENTRE_SEARCH_RECT`, but not yet wired to the DOM search form.

## Search history: one anchor shelf → the whole wall

History first lived on a single anchor shelf (`HISTORY_SHELF = 1`, `historySpines`
in the original concept doc) - every other book stayed a keyword tag, and
confining history to one shelf was the thing that kept it legible as *history*
rather than blurring into the tag wall. That premise was sized for a 32-book
shelf. Once the redesign above shrank shelves to as few as 8 books, one shelf
of history turned over almost immediately - a handful of searches and the
oldest was already gone.

History now fills the entire wall as one queue, top left to bottom right,
skipping any book an override has claimed - the same precedence as before
(override → history → tags), just no longer gated on which shelf a book sits
on. `HISTORY_SHELF` and the shelf-scoped `HISTORY_SLOTS` are gone;
`HISTORY_SLOT_COUNT` is simply `BOOK_COUNT`. The "browsable index of keywords"
role tags always played is unchanged - it is what still shows on every book
history has not yet reached.

## Accessibility: three rejected shapes

Planned in [`accessibility-plan.md`](accessibility-plan.md); these are the
shapes considered and dropped, because each is the obvious first idea.

- **The whole grid in the DOM.** Mirroring every cell as a node is the intuitive
  reading of "make the map accessible", and it fails three ways at once: the
  board is corpus-sized rather than screen-sized (157x209 at 5000 rooms, and the
  accessibility tree is rebuilt on every reorder and every frame of a slider
  drag); ~80% of cells are identical wallpaper, so a row reads as "blank wall"
  four times per room; and cell position encodes rank and certainty, not
  adjacency, so a grid presented as a grid promises a relationship that is not
  there. The mirror is windowed instead, with its own two-rung granularity
  ladder - the same instinct as the pyramid, applied to detail rather than
  resolution.

- **A separate accessible view of the corpus.** The earlier placeholder in the
  plan proposed a *parallel* interface over the same dataset. Two interfaces are
  two things to keep in sync, and the one nobody looks at is the one that rots.
  What replaced it is one DOM tree with two orderings over it - a spatial grid
  and a ranked list - sharing handlers and one naming module (`describeCell`),
  the same "one implementation, two consumers" rule `metadata.js` already
  follows.

- **Alt text generated at runtime from the images.** The demo's data layer is a
  directory of images and two text sidecars, and `npm test` needs no network; a
  per-view model call would put latency, cost and non-determinism on the path to
  a first frame. Captioning happens once, offline, alongside the stories, as an
  optional `alt` in the filename-keyed sidecar - so nothing in `packages/` grows
  a model dependency. The near-miss worth recording: the first objection to a
  generated caption at all was that it could contradict the room's story, since
  both describe an image the reader cannot see. That objection dissolved rather
  than being weighed, because the captioner is given the story as context - the
  two accounts cannot diverge if one is written from the other. The wallpaper is
  separate again: a handful of hand-written sentences, because the same generated
  one repeated hundreds of times per screen is noise, not access.

- **A windowed DOM grid mirroring the cells in view**, with focus authoritative
  and the camera following it. This was the accessibility plan's own first
  answer to "the whole grid cannot be in the DOM" - keep the grid, make it a
  window. It survived until the keyboard bindings were specified, and then died
  on a constraint that has nothing to do with cost: in browse mode a screen
  reader owns the arrow keys and the page never sees them, so a browsable DOM
  grid needs browse mode while arrow-key panning needs focus mode. **No node
  budget buys both.** Recorded because "just mirror fewer cells" is the obvious
  fix to try, and it does not address the actual obstacle.

  What replaced it inverts the coupling: the map is one `role="application"`
  region with a single **cursor** at the cell under the camera centre
  (`floor(cam.x), floor(cam.y)` - the camera is already in world cells). Arrows
  pan, the cursor rides along and is announced, and ctrl+arrow jumps to the next
  room the way ctrl+arrow jumps a word. The camera leads and the cursor follows,
  where the mirror had focus leading and the camera following. Three things fall
  out for free: the cursor cannot be scrolled off screen or stranded by a
  rebuild, a pointer pan and a keyboard pan produce the same "where am I", and
  the node count drops from ~33,000 to ~110. The rule that survives unchanged is
  that the camera and the announced position must never disagree; only the
  direction of the arrow changed.

- **An accessible mode toggle** - the map for sighted users, an alternate linear
  list of unique tiles for everyone else - was the natural answer to "four in five
  arrow presses land on blank wall", and it is one toggle away from being right.
  Three things sank it as a *mode*: an accessible path that is opt-in is one most
  people never take; routing screen readers away from the map is the paternalism
  this work exists to avoid; and a mode carries state that can desync (which mode
  is a reorder announced against?). What replaced it costs nothing extra, because
  the two readings are not duplicates: the grid is **windowed to the viewport**
  (what is around you now) and the ranked listbox is **the whole ranking** (what
  matched). Different questions, so both can be present at once and nothing forces
  a choice. Also recorded so it is not rediscovered as new machinery: "100% unique
  tiles" is already `contentRatio: 1` - `isContentSlot` is `cellHash < contentRatio`
  and `createLayout` validates the range on `(0, 1]`. A dense map is a runtime
  parameter, not a second layout. It is a fine feature to ship to everyone; it is
  not an accessibility feature, and building it as one would give the accessible
  interface a map of its own to keep in sync.

- **Forty tab stops for the centre room's forty books.** The plan's own phase D
  text says "40 real `<button>`s", and the literal reading is one tab stop each -
  no widget pattern, no roving state, nothing to get wrong. What sinks it is
  that the shelf sits between the map and the panel in the tab order, so every
  keyboard user pays forty presses to get past a wall that is mostly a
  browsable index of random corpus keywords. The ordinary `role="toolbar"`
  roving-tabindex pattern instead: one stop in, arrows within, Tab straight
  out. Recorded because the simpler shape is the one the plan appears to ask
  for, and because the objection phase B raised against a half-built listbox
  applies here and had to be answered rather than dodged - roving is fully
  implemented, and what a press does lives in a pure `bookNeighbour` that is
  asserted without a browser. What is *not* settled is whether "toolbar, 40
  items" is how a real screen reader should hear a 5x8 wall; that is
  `accessibility-plan.md` §8 item 8, and `grid` and `list` are both live
  alternatives if it reads badly.

- **Hand-written captions for the wallpaper variants, now.** §3.5 asks for one
  sentence per base variant - a few minutes of work, and the only reason it was
  not done alongside the sidecar's `alt` is that `assets/base_variations/` is
  placeholder art explicitly meant to be swapped for real inpainting output. A
  sentence written against art that is not the shipping art describes nothing,
  which is the same failure the sample corpus's `metadata.json` is already
  labelled for. Deferred until those files are real, not rejected.

Also rejected as a *goal*: **"invisible to sighted users."** Kept as the default
for semantics, but most people this work helps do not use a screen reader -
keyboard-only, motor-impaired, low-vision and vestibular users all need changes
that are visible by definition (focus rings, reduced motion, page zoom). And an
invisible layer nobody can see breaking desyncs from the canvas silently. Hence
drawing the focused cell's ring on the canvas: it is the keyboard affordance and
it makes a desync visible to everyone rather than only to the person it breaks.

## Rejected in passing

- **Tiering the search** (an exact-match bucket sorted ahead of a CLIP bucket)
  would let one weak partial keyword beat a room CLIP is certain about. The blend
  normalises every signal to [0, 1] first and sorts the whole corpus by one
  score; a test fails against a faithful tiering implementation.
- **A single global tile-cache LRU** would break "a cell never blanks": zooming
  in floods the cache with level 0 and evicts the entire coarse field the
  fallback depends on, so zooming back out flashes blank. Budgets are per level,
  and levels never evict each other.
- **Gather-as-you-go in the illusion planner** (extracting values one column at a
  time instead of parking a batch) passes every randomized test, because a board
  with a small alphabet always has a copy of each value off camera. It fails on
  the board the density gradient actually builds — distinct values all starting
  on camera — where extracting a later value rotates the column holding an
  earlier one. `illusion.test.mjs` carries that case.
- **Enforcing seam accuracy** with a `verify-seams` step and committed seam-mask
  assets was deleted: inpainting every variant from a shared base with an
  edge-clear mask makes the frame invariant by construction, so there is nothing
  to enforce.
