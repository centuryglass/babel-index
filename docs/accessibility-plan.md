# Accessibility plan — a second reading of the same map

This is the planning session [`implementation-plan.md`](implementation-plan.md)
§8 item 5 asked for. It replaces that placeholder: the queue there now points
here.

The starting proposal was a good instinct with one wrong premise. This document
records the instinct, what survived, what changed and why, and the ordered work
that follows. Alternatives rejected along the way are folded into
[`design-history.md`](design-history.md) so nobody re-treads them.

---

## 1. What the problem actually is

The whole map is one `<canvas>`. There is no DOM per room, book titles are
`fillText` on a tile, picking resolves a screen point to a cell, and every
gesture is a pointer gesture. To assistive technology the application is a
single unlabelled graphic; to a keyboard it is nothing at all. Right now you
cannot reach the search field, open a room, pan, zoom, or read a story without
a mouse or a touchscreen.

Worth separating two failures that get lumped together, because they need
different fixes and have different audiences:

| | who it excludes | fix |
| --- | --- | --- |
| **No keyboard interface** | keyboard-only users, switch and voice users, *and* every screen reader — AT navigation rides on focus | real focus targets and key bindings |
| **No accessible semantics** | screen reader users specifically | a DOM structure that says what the pixels say |

The first is a prerequisite for the second. A perfectly labelled DOM mirror with
nothing focusable in it is unreachable. That ordering drives the phases in §5.

There is also a third group the canvas already fails and nobody has counted:
low-vision users who zoom the page (blocked — see §6), and vestibular users
who get an unrequested 1.2-second sliding-tile animation on every search
(reduced motion is honoured for the camera flight and not for the
rearrangement — §6 again).

---

## 2. The proposal, point by point

The naive plan, and the verdict on each part. The reasoning is in §3 and §4;
this table is the summary.

| proposed | verdict |
| --- | --- |
| Entire grid structure embedded in the DOM, minus the unreachable border | **Changed.** Window it, and give the border a voice instead of removing it. §3.1 |
| Side panel controls one layer up from the grid | **Changed.** Landmarks and a skip link, not nesting depth. §3.2 |
| Stories, tags and centre controls nested in their grid squares | **Kept, with a split.** Short name on the cell, long content inside it. The centre books become real buttons — the highest-value item here. §3.3 |
| Live-region announcements for centring and reordering | **Kept, narrowed.** Announce outcomes, not motion, and let native widget semantics carry what they already carry. §3.4 |
| Cheap generated alt text for every grid image | **Settled.** Generated once, offline, with each room's story passed to the captioner as context so the two accounts cannot diverge. Never at runtime. §3.5 |
| Completely invisible to sighted users | **Rejected as a goal, kept as a default.** Three tiers instead. §3.6 |
| *(added)* An alternate linear mode, unique tiles, toggleable | **Kept as a feature, deferred as a subproject.** A real toggle for everyone, not an accessibility path. "Unique tiles" is already `contentRatio: 1`. §3.7 |
| *(added)* Arrows pan, PgUp/PgDn zoom, and still no 33,000 nodes | **Resolved.** A browsable DOM grid and arrow-key panning need opposite screen-reader modes, so the mirror goes and a single cursor replaces it. ~110 nodes. §4.1, §4.2 |

And the things the proposal did not mention that have to be decided before any
of it can be built: keyboard bindings at all, how the camera and the announced
position relate, what a rearrangement does to where you are standing, and how
any of this gets tested. Those are §4 — where the three-way conflict between
"arrows pan", "screen readers need clean room-to-room movement" and "not tens of
thousands of nodes" turns out to have only two sides.

---

## 3. Alterations

### 3.1 There is no DOM grid — the map is a cursor, not a mirror

> **Revised.** This section first proposed a *windowed* `role="grid"` mirroring
> the cells in view. That is withdrawn — see §4.1, which found that a browsable
> DOM grid and arrow-key panning need opposite screen-reader modes and cannot
> both exist. What follows is why the *full* mirror was never viable either,
> since those reasons stand on their own and explain the shape of what replaced
> it.

**Why the whole grid cannot be in the DOM.** Three independent reasons, any one
of which is enough:

- **Node count.** The board is sized by the corpus, not the screen — 157×209
  at 5000 rooms, roughly 33,000 cells. `AGENTS.md` states the constraint
  directly: *the map is virtualized canvas, do not mount thousands of DOM
  nodes.* The accessibility tree is rebuilt on mutation, so this is not only a
  paint cost — it is paid again on every reorder and every search, which are
  the production paths. (The ratio slider's O(slots) rebuild *per drag frame*
  is the worst case, but it is on its way to being dev-only, so it is the
  cheapest of these three reasons and should not be the one leaned on.)
- **Signal.** About 80% of cells are wallpaper. A reader arrowing across a row
  hears "blank wall" four times for every room. The density gradient — the
  thing a search actually produces — is invisible in a flat enumeration; you
  cannot feel a gradient one cell at a time.
- **Meaning.** Plan §7 item 3 asks whether vertical neighbours mean anything and
  answers *probably not*. Cell position encodes **rank and certainty**, not
  adjacency. Two rooms side by side are not related; they are merely
  consecutive in a spiral. A grid presented as a grid promises a relationship
  that is not there.

What replaced it is in §4.2: **one cursor, at the cell under the camera
centre**, moved by the same arrow keys that pan. The node count stops being a
budget to manage and becomes a consequence of the design — about 110 nodes in
the worst case (§4.2b).

Two things this section originally proposed do survive the change, because they
were never about the grid:

- **Semantic zoom on the announcement, not on the node count.** Close in, the
  cursor announces a cell. Far out — where one cell is a few pixels and stepping
  across a 157-cell board would take 157 presses — panning moves by screenfuls
  and the announcement goes regional: *"the far field; nothing ranked within
  four cells."* Same instinct as the pyramid, applied to what is said rather
  than to what is drawn. The hysteresis that keeps `pickLevel()` from flickering
  at a boundary applies here too, and for a sharper reason: a zoom held near the
  threshold that alternates between two kinds of announcement is worse than
  either.
- **The edge speaks.** Pan resistance (`resistanceAt`) is a *felt* affordance —
  the edge gets heavy under a dragging hand — and that feeling has no
  screen-reader analogue. An arrow key that silently does nothing reads as a
  broken app. The boundary announces itself instead: *"edge of the library —
  beyond here every wall is blank."* `layout.boundaryRadius` already knows where
  that is, and `?` (§4.2a) reports the distance to it.

### 3.2 The panel: landmarks, not nesting

DOM depth is not an accessibility affordance. Screen reader users navigate by
landmark, heading and control, not by ancestry, and "one layer up" would be
invisible to them while constraining the layout for no gain.

What actually delivers the intent — *the controls are easy to get to* — is:

- The panel is a labelled `<search>`/`role="region"` with the existing `<h1>`
  as its heading; the map is a labelled region beside it, not inside it.
- A skip link as the first tab stop: **skip to the map**, and from the map,
  **skip to controls**. Two tab stops, always available, no visual cost until
  focused.
- **One tab stop for the entire map**, so Tab never walks the library. Arrows
  pan *within* it; Tab leaves it (§4.2b). That is what makes the panel reachable
  in one keystroke from anywhere on the map, and it is the whole tab budget the
  map spends.

**And a ranked listbox, which is the part the proposal is missing.** If cell
position encodes rank and certainty (§3.1), then the ranking is the *lossless*
channel and the spatial reading is the lossy one. After a search, the panel
gains a list — "37 rooms match *brass*" — each option moving the cursor and the
camera to that room. Same objects, same handlers, same `describeCell` output the
map's cursor uses; one DOM tree with two orderings over it, not two interfaces
to keep in sync. That distinction matters: plan §8 item 5 worried about a
*parallel interface*, and this is deliberately not one.

It is also the half that survives every environment where arrows are not
available — touch, VoiceOver, a reader that ignores `role="application"` — which
is why Phase B builds it before the map's keyboard interface rather than after
(§5).

### 3.3 Cells carry their content — with a split, and the centre first

Kept, but do not put a whole story in a cell's accessible name. Grid navigation
reads the cell on arrival; a 300-word paragraph on every arrow press is
unusable. Split it:

- **Name** (short, spoken on arrival): `"Room 42, rank 3 of 511 — art nouveau,
  brass, spiral staircase"`.
- **Content** (inside the cell, reached deliberately): the story, the keyword
  chips as real buttons, the filename. This is the existing `RoomCard`, which
  already renders exactly this and merely has to become reachable and
  focus-managed (§6).
- **Honest when empty**: rooms with no metadata are ranked normally and must not
  be described as though they were — `"Room 118, rank 40 of 511 — no
  description recorded"`, never an invented one.

**The centre room is where this pays off most, and it should land first.** The
centre tile's 40 book spines are not decoration; they are the application's
primary interface — search history, and a browsable index of corpus keywords.
Clicking one runs a search. Today they are painted pixels behind a hit-test.

`assignTitles()` already returns a flat array of `BOOK_COUNT` slots each
carrying a `term` or an `action`. The DOM is a `.map()` over state that already
exists — 40 real `<button>`s, no new data, no new model. The moment that lands,
the app's main control surface becomes keyboard-operable and readable, which is
a larger win than anything else in this document.

Positioning them, concretely, and the trap to avoid: do **not** write 40
elements' geometry per frame from `bookScreenRects()`. The book rects are an
affine map of the cell rect, and `layout({width: 1, height: 1})` already returns
per-axis fractions — so mount **one** absolutely-positioned container matching
the centre cell's screen rect (one imperative style write per frame, exactly
what `.centre-search` already does) and lay the buttons inside it in percentage
coordinates, which then need no per-frame work at all. That the fractions are
per-axis is load-bearing here for the same reason it is in `render.js`: one
divisor for both axes is the silent-stretch bug, and it would put the focus ring
on the wrong book.

Reuse `.centre-search`'s `pointer-events: none` trick so the canvas keeps its
gestures — focus is not a pointer API, so the buttons stay reachable by keyboard
and by AT double-tap while a pan that crosses them still pans. Sighted mouse
clicks continue to route through `onTap` → `bookAtPoint` as they do now. That
leaves two entry points to one behaviour, so extract a single `onBook(slotIndex)`
and call it from both; two copies of "what does book *i* do" will drift.

### 3.4 Announcements: outcomes, not motion

Right instinct, three disciplines on it.

- **Announce the result, never the animation.** A rearrangement is 1.2 seconds
  of spectacle carrying no information a non-sighted user can use. The
  announcement is the outcome: *"Reordered. 511 rooms; best match room 42, near
  the centre."* After a search, say what the gradient did, because that is the
  search result made spatial — and `layout.gradedCount` already knows the
  cluster size, so "37 matches clustered near the centre" versus "no strong
  matches; rooms are spread evenly" is a read of state that already exists.
- **One polite region, and let native semantics do their own work.** A single
  `aria-live="polite"` for state changes; `assertive` reserved for errors.
  Slider values go in `aria-valuetext` ("42 of 511 rooms"), which AT announces
  natively — routing a drag through a live region would fire on every frame of
  the drag and drown everything else.
- **Do not announce panning.** Announce *arrival*, which is free: if focus moves
  with the camera (§4.2), the focused cell is announced by the AT with no live
  region at all. Live regions are for changes nothing is focused on.

### 3.5 Alt text: the descriptions already exist

This is the part to change most.

**Do not call a model at runtime.** The demo's entire data layer is a directory
of images plus two text sidecars; `npm test` needs no network and no browser.
Adding a per-view API call would put latency, cost, key handling and
non-determinism on the path to a first frame, in a repo whose dependency rule is
"can this be twenty lines instead?". If a description must be generated, it is
generated **once, offline, into the corpus**.

**And mostly it does not need generating.** Every described room already ships
three stylistic keywords and a short story from the corpus generator (§3c). The
story *is* the description, written by the same process that made the image. A
second, model-written description of an image the reader cannot see would sit
beside the first and be free to contradict it. So:

```
short name  = keywords     (already there)
long text   = story        (already there)
```

**Settled:** captioning happens once, offline, alongside the stories, and the
room's story is passed to the captioner as context. That is a better answer than
this document originally reached for — the contradiction risk above was the main
objection to a second description, and writing the caption *from* the story
removes it at the source rather than papering over it downstream. The map never
has to reconcile two accounts of one image, because there was only ever one.

Mechanically: an optional `alt` field in `metadata.json`. The sidecar is joined
per filename and already tolerant of partial data (`metadata.js` is deliberately
liberal about shape, and "exactly three keywords" is not enforced), so an
optional field costs nothing, lands per room, and degrades to keywords when
absent. Producing it is the generator's job, upstream of this repo — nothing in
`packages/` grows a model dependency.

One rule to carry into the captioner: it must be free to say *nothing*. A room
whose story is thin should get no `alt` rather than a padded one, because §3.3's
honesty rule ("no description recorded") is a better answer than a confident
sentence about a wall of books that could be any wall of books.

**And the wallpaper does not want per-cell alt text at all.** There is a handful
of distinct base variants covering ~80% of every screen. They need one
hand-written sentence each, once — a few minutes of work — and repeating a
generated description hundreds of times per screen would be noise, not access.

### 3.6 "Invisible to sighted users" — a default, not a goal

Rejected as stated, for two reasons.

**It targets the wrong population.** Most people helped by this work do not use
a screen reader: keyboard-only users, motor-impaired users, low-vision users who
zoom, vestibular users who need motion to stop. Several fixes here *must* be
visible — a focus ring that cannot be seen is not a focus ring, and
`prefers-reduced-motion` changes what sighted users see by definition.

**Invisible interfaces rot.** Nobody sees them break. A screen-reader-only layer
that nothing on the team looks at will silently desync from the canvas the first
time the layout changes, and no test written by someone who cannot see it
failing will catch that. That is an argument for the automated checks in §7, and
against the goal as stated.

The workable version is three tiers:

| tier | example | visible? |
| --- | --- | --- |
| 1 — everyone | focus rings, reduced motion, associated labels, page zoom | always |
| 2 — on demand | skip links, the focused cell's ring drawn on the canvas | only once a keyboard is used |
| 3 — semantics | the mirrored grid, live regions | never |

Tier 2 is the interesting one: **draw the focused cell's ring on the canvas.**
It is a few lines in `render.js`, it is the keyboard affordance, and it keeps
the mirror honest — if the ring is on the wrong cell, the desync is visible to
everyone instead of only to the person it breaks.

Tier 3 needs the usual care: hide with a clip-based visually-hidden class, never
`display: none` or `visibility: hidden`, both of which remove the node from the
accessibility tree along with the pixels. And the canvas itself gets
`aria-hidden="true"` — it has no focusable descendants, so this is safe, and
without it every room is announced twice.

### 3.7 The wallpaper problem: two orderings, not two modes

> **Deferred.** The dense/linear view is its own subproject — a real feature for
> everyone, on an intentional toggle, not an accessibility accommodation and not
> an automatic one. It is recorded here because the reasoning about *why* it is
> not the accessibility answer still governs what is. Ctrl+arrow (§4.2a) is what
> answers the wallpaper problem in the meantime, and it answers it without a
> mode.

The sharpest objection to a faithful reading of the map is the one §3.1 raises
and does not answer: at the default ratio, four in five arrow presses land on a
blank wall.
Enumerating the map faithfully means enumerating mostly nothing.

The proposal on the table is an alternate mode — the same corpus presented as a
single list in search order, every tile unique, toggleable so a reader can take
the map or take the list. Three things about it, in order.

**The dense map is not new machinery.** "100% unique tiles" is already a runtime
parameter. `isContentSlot` is `cellHash(x, y, seed) < contentRatio`, and
`createLayout` validates `contentRatio` on `(0, 1]` — so at exactly 1 every
non-centre cell holds a ranked room, the wallpaper disappears, and `collectSlots`
lays the whole corpus out nearest-first by rank. No new layout code, no new
board, and `board.js` and `illusion.js` need to know nothing about it. That is
worth knowing before anyone builds a second map.

**But dense is not linear, and dense does not fix the real problem.** At
`contentRatio: 1` the map is still two-dimensional and its adjacency is still
arbitrary: rank spirals outward from the centre, so pressing Down from rank 5
lands on rank 23 or 41 depending on where the spiral happened to be. Removing
the wallpaper solves the *sparseness* — perhaps a fifth of the problem — and
leaves the *meaninglessness*, which is the other four fifths and the reason
§3.1 argues position encodes rank rather than adjacency in the first place. A
reader who wants "the next best match" wants one keystroke, not a spiral.

So the alternate reading should be genuinely one-dimensional. And once it is,
`role="grid"` is the wrong role for it: a `listbox` announces "3 of 511"
natively, supports type-ahead to jump by name, and carries none of the
row/column noise a single-row grid still emits.

**And it should not be a mode.** Four reasons, the last one being the one that
actually settles it:

- **An accessible path that is opt-in is one most people never take.** Defaulting
  a screen reader into the structure we have just argued is hostile, and asking
  them to discover a toggle, means the reader who does not find it gets the worse
  experience — which is most of them.
- **But routing them *away* from the map is the other failure.** The map is the
  artwork. "You get the list version" is precisely the paternalism this work
  exists to avoid, and a mode makes it a fork in the road where someone has to
  choose wrong.
- **Modes carry state, and state desyncs.** Which mode is a reorder announced
  against? What happens to focus when the mode flips under it? Every one of those
  is a bug that does not exist if there is no mode.
- **The two readings are not duplicates, so nothing forces a choice.** This is
  the crux. The map is **where you are standing** — one cursor, the cell under
  the camera centre (§4.2). The list is **the ranking** — *what matched*, all of
  it. Different questions, and neither answers the other's. That is what defuses
  the "two landmarks holding the same rooms" objection to having both, and it is
  why the two tab stops in §4.2b are not redundant.

So: both live in the DOM at all times, both are reachable by Tab, both are named
for the question they answer ("Library map — what is in view" / "Search results —
ranked"). Focusing a room in either moves the camera and the focused cell for
both, so moving between them is coherent rather than a context switch. This is
exactly §3.2's *one DOM tree, two orderings* — the proposal arrived at it from
the other direction, which is a good sign for it.

The cost to respect is verbosity: two places a reader can find rooms. That is
paid down by naming them sharply, and by the far-out rung in §3.1 — zoomed out,
the grid collapses to a summary, so at most zooms the two are not competing for
attention at all.

**Where the toggle idea does belong: the canvas, for everybody. Settled.** A
dense view — *show me only the matches, packed* — is a real feature on its own
merits, fully functional for sighted users, on a deliberate toggle. It is
`contentRatio: 1` plus a button, and if the ratio slider is becoming a dev-only
control (§6.1) it is the production-facing thing that should replace it.

It also earns its place thematically rather than merely technically, which is
the strongest argument for it: the project is about what happens when you gain
the capacity to sieve out the noise and keep only the iterations that hold
meaning. A control that drops the wallpaper and leaves the corpus *is* that
sieve, made operable. Deciding the grid is getting in the way of the content is
a legitimate reading of the work, not an accommodation for people who cannot see
it.

Which is precisely why it must not be built as an accessibility feature. Ship it
because it is worth shipping; the moment it exists to serve screen readers, the
accessible interface owns a map of its own and there are two things to keep in
sync again.

---

---

## 4. The decisions the proposal does not make

### 4.1 The conflict, and why two of its three sides are the same side

Three requirements that look like a triangle:

1. Arrows pan and PgUp/PgDn zoom, as in any simulated 2D space.
2. A screen reader user can move between rooms cleanly.
3. No tens of thousands of DOM nodes.

**1 and the grid mirror are not merely expensive together — they are mutually
exclusive.** In browse mode (the default for NVDA and JAWS) the screen reader
owns the arrow keys: they walk the virtual document and the page never sees
them. A page gets raw arrows only when focus is in a form field, in a widget
role that flips the reader into focus mode (`grid`, `listbox`, `tree`…), or
inside `role="application"`. A browsable DOM grid needs browse mode; arrows that
pan need focus mode. **No node budget buys both**, because the obstacle is not
cost, it is that the two want opposite modes of the same reader.

That resolves the triangle by collapsing it. §3.1's windowed `role="grid"` is
**withdrawn** — not because 33,000 nodes is too many (it is), but because even
33,000 free nodes would not deliver requirement 1. Once the map is an
application region, the DOM's job changes completely: it is no longer a *map to
explore*, it is a **readout of where you are** plus a **jump table for getting
elsewhere**. And a readout needs one node, not one per cell.

Requirement 3 stops being a constraint to manage and becomes a consequence.

### 4.2 The cursor: the cell at the centre of the viewport

**Panning *is* moving a cursor, if the cursor is what you are standing in front
of.** When a sighted user pans, the thing that changed is which room is in the
middle of the screen. That is exactly what a screen reader user needs announced
— not "the camera moved 40 pixels" but "you are now at Room 42".

So the cursor is the cell under the camera centre. It costs nothing to compute:
camera `x`/`y` are already in world cells, so the cursor is
`floor(cam.x), floor(cam.y)`, and `cameraAtCell`'s `+ 0.5` is the existing
statement of the same convention. Three things fall out of it for free:

- **The cursor is always on screen**, by construction. §4.2's old rule — *the
  window must always contain the focused cell, or focus is stranded* — becomes
  vacuous rather than something to enforce.
- **A pointer pan and a keyboard pan produce the same cursor**, so a sighted
  user and a screen reader user handing the laptop back and forth are looking at
  the same place. There is no second notion of "where I am" to keep in step.
- **One DOM node**, whose accessible name is `describeCell()` output and whose
  contents are the current room's story and keyword chips. Move → update one
  node's content and announce.

**This inverts §4.2's original direction, deliberately.** The plan first had
*focus authoritative, camera follows*, because focus was on a cell node among
many. With one cursor, the camera leads and the cursor follows. The coupling
requirement is unchanged — the camera and the announced position must never
disagree — and the new direction is what makes arrows pan rather than step
between grid cells.

### 4.2a Bindings

| key | in the map |
| --- | --- |
| arrows | pan one cell — the cursor moves with it, and is announced |
| **ctrl/cmd + arrows** | jump to the **next room** in that direction, skipping wallpaper |
| shift + arrows | pan a screenful |
| PgUp / PgDn | zoom, through `zoomBy` — the same fixed-point path the wheel uses |
| Home | the centre room; **ctrl + Home** the best match, via `cellOfRank(0)` |
| Enter / Space | open the cursor's room card |
| Escape | close the card, return to the map |
| `/` | the search field, via the existing `goToSearch` |
| `?` | what is near me — see below |

**Ctrl+arrow is the answer to the wallpaper problem**, and it needs no
explanation to anyone who has used a text editor: arrow is a character, ctrl +
arrow is a word. Here arrow is a cell and ctrl + arrow is the next thing worth
stopping at. It is a *movement*, not a mode, so nothing has to be toggled,
remembered, or announced — and it is as useful to a sighted keyboard user
skimming a sparse map as it is to a screen reader.

`layout.rankOf(x, y)` makes finding it a walk of Map lookups along one axis,
bounded by `boundaryRadius`. No new index.

**Announce briefly on move, in full on request.** Verbose-by-default is the
classic mistake: "Room 42, rank 3 of 511" on arrival, and `?` for the
surroundings — *"blank wall. Room 42 two east, Room 17 three north-west; the
edge of the library is six west."* That is the screen-reader equivalent of
peripheral vision, and without something like it, spatial navigation is blind
groping. Cheap, for the same reason ctrl+arrow is: a bounded scan of
`rankOf`.

### 4.2b What is actually in the DOM

| | nodes |
| --- | --- |
| the map region (one tab stop, `role="application"`) | 1 |
| the cursor: name, story, keyword chips | ~6 |
| live regions (one polite, one assertive) | 2 |
| the ranked listbox, windowed with `aria-setsize`/`aria-posinset` | ~50 |
| the centre room's book buttons, only while the centre is on screen | 40 |
| the panel | ~10 |
| **worst case** | **~110** |

Against roughly 33,000 for the mirrored board. The listbox is windowed for the
same reason anything else is — 5,000 rooms is 5,000 options — and
`aria-setsize` lets fifty mounted options still announce "3 of 5,000" honestly.

**Two tab stops, and arrows mean whatever the focused one says they mean.**
That is not a conflict to resolve; it is how every widget on the web already
behaves. In the map, arrows pan. In the listbox, arrows move through the
ranking. Choosing a room in the listbox moves the cursor and the camera, so the
two readings stay coherent: the listbox is *jump to*, the map is *where I am*.

**Scope `role="application"` to the map region and nowhere else.** Inside it,
browse-mode reading is off and everything must arrive through focus and live
regions — which is a real commitment, and the reason it must not creep onto the
panel. The room card in particular has to open **outside** the application
region, as an ordinary dialog, or its story cannot be read with the virtual
cursor, which is the one thing a reader most wants to do with it.

**And it must degrade to no arrows at all.** VoiceOver does not have the same
browse/focus split, and a phone has no arrow keys whatsoever. Touch users get
the DOM: the listbox, the cursor's contents, the centre books. That is the
argument for the listbox being the load-bearing half and the spatial cursor
being the part that makes the map *a map* — and for building them in that order
(§5).

### 4.3 What a rearrangement does to focus

The cursor is a **cell**, and a reorder changes which room is in that cell. The
cursor stays put — it is where the reader is standing, and the rearrangement
parks the camera anyway — and the new occupant is announced. Do not try to
follow a room as it slides; the sliding-tile illusion moves whole lines, and the
room's identity travelling across the screen is precisely the fiction the
animation maintains for the eye. Chasing it in the accessibility tree would be
describing a fiction as fact.

This is one place the cursor model is strictly simpler than the mirror would
have been: there is no focused node to be unmounted, re-keyed or stranded when
the board rebuilds under it. The camera did not move, so neither did the
cursor.

Also: under `prefers-reduced-motion`, skip the rearrangement entirely. **The
code path already exists** — `board.js` returns null when a slide is impossible
and the caller falls back to an instant rebuild — so reduced motion is one
condition routed into a path that is already written and already tested, not a
new branch.

### 4.4 Touch

Long-press-to-open collides head-on with VoiceOver and TalkBack, which
intercept touch before the page sees it. Once the cells are real DOM, AT
double-tap activates them for free — so the requirement is not to make
long-press accessible, it is to **stop long-press being the only way in**. Enter
on a focused cell (§4.1) and the card's own controls cover it.

---

## 5. Phases

Ordered by dependency, and by value delivered per unit of work. Each phase is
independently shippable; nothing later is required for something earlier to be
worth having.

**Phase A — the existing bugs. Landed.** Everything in §6, each with a browser
test confirmed to fail against the unfixed app, plus an axe sweep over the
opening view as the broad net under them. Two things it taught, both folded in
above: Chrome puts CSS `text-transform` into the accessible name (§6.3), and the
card's focus *restore* cannot be exercised until something other than a pointer
can open it (phase C).

**Phase B — `describeCell`, and the ranked listbox. Landed.** The pure naming
module (`packages/map/describe.js`) now names a cell for both consumers this
phase has: the room card's accessible name (replacing the bare "room N" from
phase A) and the search results list in the panel. The list is a plain `<ul>`
of buttons rather than `role="listbox"` with arrow-key roving — that widget
pattern needs the keyboard model phase C brings, and a listbox that does not
implement roving is a broken widget, worse than none. Every result is
independently reachable by Tab today, which is the point of shipping this
*before* the map's keyboard interface: it works with no arrow keys at all,
which is every touch device and every VoiceOver user, and it needs no
`role="application"` commitment.

Windowed to `RESULTS_WINDOW` (50) and to `layout.gradedCount` — the number of
ranks the search's density gradient actually lifted above the baseline, not
the whole corpus. One interaction worth knowing before it looks like a bug:
**at `contentRatio: 1` (the "non-generic" slider maxed) the list is always
empty.** `gradedCount` counts ranks *above* the baseline, and there is no
"above" left once the baseline already is the maximum — every cell already
holds a room regardless of match quality, so a search has nothing left to
cluster. That is the ratio slider working as designed, not the listbox
failing; `main.jsx`'s `searchResults` memo says so in a comment, because the
next person to hit it in the browser will not have this document open.

Selecting a result opens the room's card and flies the camera there, without
waiting on the flight — the card is an independent DOM dialog, reachable the
instant it mounts regardless of how fast (or whether, under reduced motion)
the camera arrives. This is the first real path into a room's content that
does not require a pointer: right-click and long-press still cannot be reached
without one.

One thing the e2e work surfaced and is now §8 item 8: Chrome's CDP
accessibility tree does not surface `aria-posinset`/`aria-setsize` for a
native `<li>` at all, confirmed by dumping a node in full rather than trusting
an empty read. The attributes are on the DOM and are spec-correct where they
are (`listitem`, not the button inside it — a bare `button` does not support
them), but whether a real screen reader's platform API receives them is
unverified by anything in this repository.

**Phase C — the cursor, and the keyboard. Landed**, with real gaps flagged
rather than papered over. `role="application"` on the canvas (nowhere else),
every binding in §4.2a, the cursor as canvas fallback content, `nextRoom`'s
walk for ctrl+arrow, `?`, the boundary crossing, and the visible ring - all in
`main.jsx`/`camera.js`/`render.js`/`packages/map`. Still the phase to test
with a real screen reader before believing any of it (§8 item 1 - unchanged
and unverified; everything below is confidence from browser/ARIA semantics and
axe, not from NVDA or JAWS actually running it).

Four scope decisions made while building it, none of them in the original
text:

- **Announcements are keyboard-driven only, not continuous.** `cam` is a ref
  precisely so panning does not re-render React on every pointer-drag frame
  (see `useMapCamera.js`'s own comment on why); the cursor honours that rather
  than fighting it. A pointer drag moves the camera and therefore the
  UNDERLYING cursor cell, but nothing is pushed to the live region or the
  canvas's `aria-label` until the next KEYBOARD action re-syncs it. The
  alternative - announcing on every pixel of a mouse drag - would spam a
  screen reader running alongside a sighted user's mouse, which is a real
  combination (low vision, or someone else driving). The coupling requirement
  (camera and announced position must never DISAGREE) still holds: a stale
  announcement is not a wrong one, it is simply not yet re-asked-for, and the
  next arrow press or Enter reads the camera fresh.
- **One live region, not two.** §4.2b budgeted a polite and an assertive
  region. Only the polite one exists, because nothing yet has anything to say
  assertively - Phase A's status span carries every announcement here,
  including the boundary crossing (judged informational, not an error). The
  assertive region is deferred until something actually needs it, rather than
  shipped empty and untested.
- **`?` checks four directions, not eight.** The plan's own example
  ("Room 17 three north-west") implies a true nearest-room search across
  diagonals; what shipped is `nextRoom` run straight in each cardinal
  direction, reusing the exact primitive ctrl+arrow already uses rather than
  inventing a second search. Simpler, and a diagonal answer was judged more
  geometry than a `?` press needs to earn its keep - revisit if it turns out
  to matter in practice.
- **The boundary is not a hard stop for the keyboard.** §8 item 3 left this
  open; it is decided now. Arrows cross the boundary freely - the map really
  is infinite, and stopping the keyboard at an edge the pointer never respects
  would be a keyboard-only restriction to explain. The crossing itself is
  announced once, in either direction, not repeated on every step already past
  it (verified: sabotaging the once-only tracking is what the e2e suite's
  boundary test exists to catch, and does).

And the visible ring (§8 item 6) is answered too: it appears only once a
keyboard action has actually happened (`render.js`'s `cursor` param is `null`
until then), so a reader who never touches a key never sees a reticle
appended to a page they did not ask to look different.

**One real gap, not a decision: the rearrangement does not announce its new
occupant.** §4.3 states that as settled design; §8 item 4 is where the honest
status lives. Standing still while the library reorders around you and
hearing nothing about what arrived is not a finished accessible experience,
and this document does not claim it is.

**Phase D — the centre room's books.** The 40 spines as real buttons (§3.3).
Independent of B and C — it is a control surface, not a navigation model — and
placed last only because B and C are what make the corpus reachable at all. Move
it earlier if the centre's controls matter more than the map's, which is a
defensible reading.

**Phase E — the sidecar's optional `alt`.** §3.5. Format change plus a fallback;
depends on a corpus that carries the field, so it is gated on the generator
rather than on anything here.

The phase that used to be here and is gone: **the windowed grid mirror**. §4.1
withdrew it. Most of its work was the machinery that no longer exists — the two
rungs of node granularity, the absolute row/column indices, the wallpaper run
collapsing, the "window must contain the focused cell" union. What it was *for*
survives in Phase C at a fraction of the cost.

---

## 6. Already broken, and cheap to fix

Found by audit, in rough order of severity. All are Phase A.

> **Phase A has landed.** Every item below is fixed, each with a browser test
> that was confirmed to fail against the unfixed app. Two are struck through
> with a note rather than simply removed, because what was learned fixing them
> outlived the fix. Kept as a record of what the audit found — delete it when it
> stops being useful.

1. ~~**The panel's sliders have no accessible name.**~~ **Fixed.**
   `<label>rooms on the map</label>` was a *sibling* of its
   `<input type="range">`, with no `htmlFor` and no wrapping, so both sliders
   announced as bare numbers. Both now carry an explicit `htmlFor`/`id` pair and
   an `aria-valuetext` that says what the number counts. Noted for whoever
   touches the panel next: **the sliders are headed for dev-only**, so this was
   tidiness rather than an investment — do not build further on them, and see
   §3.7 for the production-facing control that could replace the ratio one.
2. ~~**Page zoom is disabled.**~~ **Fixed.** `maximum-scale=1, user-scalable=no` in the
   viewport meta is a documented WCAG 1.4.4 failure and locks out exactly the
   low-vision users this map is hardest on. It is there to stop iOS treating a
   two-finger map pinch as a page zoom — but `touch-action: none` is already
   set all the way up the tree for that reason, which is the mechanism that
   actually does the work. Recommend dropping both attributes and verifying on
   a device; this ties into plan §7 item 11, which already wants an iOS pass on
   the in-tile search field.
3. ~~**The room card is unreachable and unmanaged.**~~ **Partly fixed.** It opens only on right-click
   or long press — no keyboard path at all. It is `role="dialog"` with
   `aria-label="room"`, which tells a reader nothing; focus never moves into it,
   Escape does not close it (it did), and focus is not restored on close. It now
   takes focus on open, is named by `aria-labelledby` on its room line, and
   restores focus to whatever opened it.

   **Resolved by phase C.** Enter on the map cursor opens the card with the
   canvas as its opener, so the restore-on-close path — written in phase A,
   unexercised until now — is finally reachable and asserted where it can
   fail: closing a card Enter opened returns focus to the canvas. A
   pointer-opened card (right-click) still has no opener, for the reason
   given above; that gap is inherent to the gesture, not something phase C
   was expected to close.

   One thing found while testing it, worth knowing before naming anything after
   an acronym: **Chrome folds CSS `text-transform: uppercase` into the computed
   accessible name.** `.card-id` is styled uppercase, so the reader is handed
   "ROOM 21 · 022.JPG" rather than the DOM's own text. Harmless for a word that
   is still pronounceable, and it goes away when the card's label comes from
   `describeCell` (phase B) rather than from a visually-transformed node.
4. ~~**Reduced motion is honoured for the flight and not for the rearrangement.**~~ **Fixed.**
   `useMapCamera.js` checks `prefers-reduced-motion` per flight; `slide.js`'s
   five durations run unconditionally, so someone who asked for less motion
   still gets 1.2 seconds of sliding tiles on every search. See §4.3 — the
   fallback path already exists.
5. ~~**The focus indicator on the search fields is `outline: none` plus a
   border-colour change.**~~ **Fixed.** A one-pixel hue shift is a weak indicator and is
   unlikely to clear the contrast requirement. Replace with a visible ring.
6. ~~**The canvas has no role, no label and no fallback content.**~~ **Fixed.** Per §3.6 it
   should be `aria-hidden="true"` once the mirror exists; until then it needs a
   label, or it is an unnamed graphic that is also the entire application.
7. ~~**The status note is not a live region.**~~ **Fixed.** `status` already carries exactly
   the text §3.4 wants announced — search results, rearrangement outcomes — and
   silently updates a `<div class="note">`. Making it the polite region is
   nearly free.
8. ~~**The in-tile search field has no label**~~ **Fixed.** It relying on its placeholder, and
   leaves the tab order entirely when the centre tile is off screen (it is
   `display: none` until the render loop finds it legible). The second part is
   defensible — the panel's labelled 🔍 button is the entry point, and
   `goToSearch` already flies the camera and then focuses — but it must be
   written down, or someone will "fix" it into a focusable target that is
   invisible and positioned nowhere.

---

## 7. Testing

The repo's rule is that a green end-to-end test which cannot fail is worse than
none, and that the part with a right answer gets asserted browser-free. Both
apply cleanly.

**Pure, and tested with `node --test`:**

- `packages/map/describe.js` — `describeCell(x, y, {layout, order, metadata})`
  → `{name, description, kind}`. No DOM, no imports, in `packages/map` because
  it is the same kind of module as `metadata.js`: one implementation, more than
  one consumer (the grid, the results list, the card's label). This is the
  established split — `picking.js` and `centre.js` did the same thing for
  hit-testing.
- The cursor arithmetic — `(cam) → cell`, and the granularity rung a zoom
  selects. Both are pure. Assert that the cursor is the cell the renderer draws
  at the centre of the frame (one statement of that fact, not two), and that a
  zoom held near the rung threshold does not oscillate between announcement
  kinds.
- `nextRoom(layout, from, direction)` — ctrl+arrow's walk. Pure, bounded, and
  the one piece of navigation with a right answer: it must skip wallpaper, stop
  at the boundary, and never return the cell it started from.

**In the browser, `smoke.e2e.mjs`:** tab order reaches the map in one stop and
leaves it in one; arrows move focus and the camera follows; Enter opens the
card, Escape closes it and focus returns to the cell it came from; the live
region holds the expected text after a search. Per the repo's own rule, break
each of these on purpose once and confirm it fails.

**`@axe-core/playwright`, in.** It catches the whole class of regression in §6
automatically, which matters precisely because tier-3 semantics are invisible and
rot unwatched (§3.6). A devDependency used only by the browser suite, so
`npm test` stays what it is — a second of `node --test` with no browser and no
network. The opening view reports zero violations across `wcag2a`/`wcag2aa`/
`wcag21a`/`wcag21aa`, and removing a slider's label brings it back as a critical
`label` violation, so the sweep is doing work rather than passing vacuously.

Two mechanics worth knowing before adding to it. **`page.accessibility` is gone**
as of Playwright 1.51, so computed properties are read over CDP
(`Accessibility.getFullAXTree`, wrapped as `axNodes`); `locator.ariaSnapshot()`
reports a slider's raw value and not the `valuetext` that replaces it. And **axe
refuses a page whose context it did not see created**, which is why the suite now
makes an explicit `browser.newContext()` rather than letting `newPage()` make one
implicitly.

**And e2e is a merge gate now**, which is what makes any of this load-bearing: a
keyboard interface that CI never drives is a keyboard interface nobody knows is
broken. `ci.yml` calls `e2e.yml` as a reusable workflow and the aggregate `ci`
job needs both, so branch protection still requires exactly one check and
`e2e.yml` keeps its manual dispatch. The cost to respect, now that a red browser
run blocks everyone: **a flaky smoke test is no longer merely annoying.** Wait on
conditions, never on durations — the existing suite's `landed()`/`settled()`
distinction, and its habit of reading timings off the manifest rather than
hard-coding them, is the pattern to keep.

Promoting the suite already surfaced one instance. The pyramid test read `blank`
from the first settled frame, but `settled()` waits out a rearrangement and two
frames — the camera and the animation, not the network — so a level still
decoding failed it about one run in five. It polls for the condition now, and
still fails when the tiles genuinely never arrive. Expect the keyboard tests to
have the same shape of hazard: a focus move is asynchronous, and a camera
follows it.

**Phase C confirmed the prediction.** `zoomStep` is instant - no flight, no
promise - but "instant" still means "on the next animation frame," not "before
`page.keyboard.press` returns": a test reading the HUD immediately after
PageUp raced that frame and read the stale zoom about one run in four. Fixed
by polling for the change, same discipline as the pyramid fix. Not every new
read had the same exposure - the live region's text comes from a React state
commit, not a `requestAnimationFrame` callback, and empirically never raced
across a dozen runs - but the HUD specifically, wherever a keyboard test
touches it, needs the same poll `settled()` already uses for other reasons.

Phase C's pure modules landed as specified: `packages/map/nextRoom.js`
(ctrl+arrow's walk - skips wallpaper, stops at the boundary, never returns the
start cell) and `cursorCell`/`pickGranularity` in `camera.js` (the cursor
arithmetic and its hysteresis, mirroring `pickLevel`'s shape). `render.js`
gained a third pure-ish surface: the cursor ring is asserted through the same
recording `fakeCtx` pattern `render.test.mjs` already uses for `drawImage`/
`fillRect`, extended to record `strokeRect` calls too.

---

## 8. Still open

1. **Does `role="application"` survive contact with a real screen reader?**
   Still open, and still the single highest-risk item in this document — Phase
   C landed the whole cursor model on top of it, which raises the stakes rather
   than lowering them. Nothing here has run against NVDA, JAWS or VoiceOver;
   the confidence behind Phase C is browser-observable (CDP's computed roles
   and properties, axe's WCAG sweep, `:focus-visible` behaviour) and none of
   that is the same claim as "a real reader announces and reacts correctly."
   It needs a person with a screen reader, in that order of doubt, before this
   item can move. Phase B shipped first precisely so there is something usable
   if the answer turns out to be bad.
2. **What the far-out announcement should say.** What shipped in Phase C —
   *"the far field near (x, y) - too far out to name a single room"* — is a
   different placeholder than the one originally sketched here, not a real
   answer either. The useful summary is probably about the gradient — how
   concentrated the current search is — not about coordinates.
3. ~~**Whether the boundary should be a hard stop for the keyboard.**~~
   **Decided in Phase C: no.** Arrows cross it freely; the crossing is
   announced once, in either direction, and not repeated on every step already
   past it. The map really is infinite, and a keyboard-only stop the pointer
   does not share would be a restriction that needs explaining rather than one
   that reads as obviously correct.
4. **The rearrangement does not announce its new occupant at all yet.** Not a
   timing question to weigh, as this item first framed it — Phase C simply
   never wired it up. `announceCursorMove` fires only from the discrete
   keyboard actions in §4.2a; nothing calls it when a reorder lands, so a
   screen reader user hears whatever `describeSignals` already said about the
   search (`"ranked by keywords"`) and nothing about what is now actually under
   their cursor. §4.3's "the new occupant is announced" is written as settled
   design; it is not built. Worth doing before this document claims the
   rearrangement is accessible at all — the timing question (immediately vs.
   after the animation lands) is real but secondary to simply existing.
5. **How far should ctrl+arrow look before giving up?** It walks `rankOf` along
   an axis to the boundary, which is nothing at 27 rooms and a 200-cell walk at
   the far edge of a full corpus. Bounded per keypress, almost certainly, but
   the bound is a feel question: too short and the key does nothing in the far
   field, too long and one press crosses half the library.
6. ~~**Does the cursor want a visible twin for sighted keyboard users?**~~
   **Landed in Phase C**, with the suggested resolution: the ring in
   `render.js` draws only once a keyboard action has actually happened, so a
   reader who never touches a key never sees a reticle appended to a page they
   did not ask to look different.
7. **Whether the dense view and this plan should share any code.** §3.7 defers
   the dense/linear view as its own subproject and argues it must not be built
   as an accessibility feature. The thing to watch when it does get built is
   `describeCell` — it is the one module both would want, and it is the one
   module that is safe to share, because it names rooms rather than arranging
   them.
8. **Does a real screen reader receive `aria-posinset`/`aria-setsize` on a
   native `<li>` at all?** The ranked listbox (phase B, landed) puts both on
   the `<li>` per spec — `listitem` is where they belong, a bare `button` does
   not support them — but Chrome's CDP `Accessibility.getFullAXTree` does not
   surface either property for a native list item, confirmed by dumping a node
   in full rather than trusting an empty read. CDP is not the platform
   accessibility API a screen reader actually queries (UIA on Windows, AT-SPI
   on Linux, AX API on macOS), so this may be a CDP gap rather than a real one
   — but it has not been checked against NVDA or JAWS, and the e2e suite can
   only assert the DOM attributes are present, not that a reader announces
   position from them. Folds into item 1's need for a real screen reader pass.
