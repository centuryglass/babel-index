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
