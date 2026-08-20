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
| Cheap generated alt text for every grid image | **Mostly declined.** The descriptions already exist; where they do not, generate them offline in the corpus, never at runtime. §3.5 |
| Completely invisible to sighted users | **Rejected as a goal, kept as a default.** Three tiers instead. §3.6 |

And five things the proposal did not mention that have to be decided before any
of it can be built: keyboard bindings at all, how focus and camera relate,
what the mirror does when 1600 cells are on screen, what a rearrangement does
to a focused cell, and how any of this gets tested. Those are §4.

---

## 3. Alterations

### 3.1 The grid: window it, and let the edge speak

**Why the whole grid cannot be in the DOM.** Three independent reasons, any one
of which is enough:

- **Node count.** The board is sized by the corpus, not the screen — 157×209
  at 5000 rooms, roughly 33,000 cells. `AGENTS.md` states the constraint
  directly: *the map is virtualized canvas, do not mount thousands of DOM
  nodes.* The accessibility tree is rebuilt on mutation, so this is not only a
  paint cost; it is a cost paid again on every reorder, every slider drag, and
  every one of the O(slots) rebuilds the ratio slider does *per drag frame*.
- **Signal.** About 80% of cells are wallpaper. A reader arrowing across a row
  hears "blank wall" four times for every room. The density gradient — the
  thing a search actually produces — is invisible in a flat enumeration; you
  cannot feel a gradient one cell at a time.
- **Meaning.** Plan §7 item 3 asks whether vertical neighbours mean anything and
  answers *probably not*. Cell position encodes **rank and certainty**, not
  adjacency. Two rooms side by side are not related; they are merely
  consecutive in a spiral. A grid presented as a grid promises a relationship
  that is not there.

**So: the mirror is windowed, and it has its own ladder.** The canvas drops
*resolution* as the camera pulls back; the mirror drops *granularity* at the
same kind of threshold, for the same reason — past a certain point, per-cell
detail is cost without information.

```
mounted cells = (cells in the viewport, if few enough) ∪ { the focused cell }
```

Two rungs, with hysteresis so a zoom held near the boundary does not thrash the
accessibility tree (the same problem `pickLevel()` already solves, and worth
imitating rather than re-deriving):

- **Close in** (viewport under ~150 cells): a real `role="grid"`, one row per
  world row, `aria-rowindex`/`aria-colindex` carrying **absolute world
  coordinates** and `aria-rowcount`/`aria-colcount` describing the whole board.
  This is the sanctioned virtualized-grid pattern; the window is honest about
  being a window.
- **Far out**: the grid collapses to a summary — "1,664 walls in view, 38 of
  them rooms; nothing is legible at this distance" — and the ranked results
  list (§3.2) carries everything. Zooming in is a real navigation act, not a
  cosmetic one, and it is fine for the mirror to say so.

Two details that will bite:

- **`aria-rowindex` is 1-based and positive.** World coordinates are signed and
  centred on the origin. Offset by the board radius when writing the attribute
  and keep world coordinates everywhere else; do not let the offset leak into
  the layout module.
- **Runs of wallpaper collapse.** Consecutive generic cells in a row become one
  `role="gridcell"` with `aria-colspan`, named "12 blank walls". Legal ARIA,
  roughly a 5× cut in nodes, and it reads the way the wall looks.

**On excluding the border.** The proposal excludes the unreachable outer region.
Do the opposite. Pan resistance (`resistanceAt`) is a *felt* affordance — the
edge gets heavy under a dragging hand — and that feeling has no screen-reader
analogue. An arrow key that silently does nothing reads as a broken app. The
boundary should announce itself: *"edge of the library — beyond here every wall
is blank."* `layout.boundaryRadius` already knows where that is.

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
- One tab stop for the entire map (roving `tabindex`), so Tab does not walk
  1,600 gridcells. Arrows move *within* the grid; Tab leaves it. Standard grid
  keyboard pattern, and it is what makes the panel reachable in one keystroke
  from anywhere on the map.

**And a ranked results list, which is the part the proposal is missing.** If
cell position encodes rank and certainty (§3.1), then the ranked list is the
*lossless* channel and the spatial grid is the lossy one. After a search, the
panel gains a list — "37 rooms match *brass*" — each entry a link that focuses
its cell and moves the camera there. Same objects, same handlers, same
`describeCell` output as the grid uses; one DOM tree with two orderings over
it, not two interfaces to keep in sync. That distinction matters: plan §8 item 5
worried about a *parallel interface*, and this is deliberately not one.

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
a larger win than the entire grid mirror.

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

Where a genuine short description is wanted, it belongs in `metadata.json` as an
optional `alt` field — the sidecar is joined per filename and already tolerant
of partial data, so an optional field costs nothing and degrades to keywords
when absent. Producing it is the generator's job, upstream of this repo. Haiku
is a perfectly good way to write it; that just happens offline, in the corpus,
not in `main.jsx`.

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

---

## 4. The decisions the proposal does not make

### 4.1 Keyboard bindings

Nothing works until these exist. Proposed set, all overridable later:

| key | in the map |
| --- | --- |
| arrows | move focus one cell; camera follows |
| PgUp/PgDn, shift+arrows | move a screenful |
| `+` / `-` | zoom, through `zoomBy` — the same fixed-point path the wheel uses |
| Enter / Space | open the focused room's card |
| Escape | close the card, restore focus to its cell |
| Home | the centre room (the existing "centre" button's target) |
| `/` | the search field, via the existing `goToSearch` — which already flies then focuses, and already handles the field being off screen |

`zoomBy` taking a factor is exactly right for this; do not grow a keyboard-
specific zoom path beside it.

### 4.2 Focus and camera: focus is authoritative

The hardest question here, and it must be settled before any code.

- **Keyboard focus moves the camera, instantly.** No `flyTo`. A 400 ms eased
  flight between every arrow press is unusable, and it races: `cam.current` is
  unchanged when `flyTo` returns, so a second arrow press mid-flight plans
  against the old camera.
- **A pointer pan does not move focus.** It re-windows the mirror and leaves
  focus where it was.
- **Therefore the window always includes the focused cell**, viewport or not.
  A focused node that has been unmounted, or is inside an `aria-hidden` subtree,
  is a real bug — focus lands nowhere and the reader is stranded. This is why
  the windowing rule in §3.1 is a union rather than a viewport slice.
- **The "centre" button moves focus too.** Anything that moves the camera
  deliberately should move focus with it, or the two drift apart and the next
  arrow press jumps the view back.

### 4.3 What a rearrangement does to focus

Focus is on a **cell**, and a reorder changes which room is in that cell. Keep
focus on the cell coordinate — it is stable, it is where the reader is standing
— and announce the new occupant. Do not try to follow a room as it slides; the
sliding-tile illusion moves whole lines and the room's identity travelling
across the screen is precisely the fiction the animation maintains for the eye.
Chasing it in the accessibility tree would be describing a fiction as fact.

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

**Phase A — the existing bugs.** Everything in §6. Small, isolated, no new
architecture, and several are outright conformance failures today. Land first
regardless of what follows.

**Phase B — keyboard, and the centre books.** The bindings in §4.1, the focus
rule in §4.2, the canvas focus ring, and the 40 centre books as real buttons
(§3.3). This is the phase that converts the app from unusable-without-a-mouse to
usable, and it delivers the main control surface. If only one phase ever lands,
this is the one.

**Phase C — `describeCell`, and the results list.** The pure naming module
(§7), plus the ranked results list in the panel (§3.2). Gives a screen reader
the lossless channel — every room, in rank order, with keywords and story —
before any grid mirror exists. Cheap, because it is a list over data already in
memory.

**Phase D — the windowed grid mirror.** §3.1: the two rungs, the hysteresis, the
absolute row/column indices, the wallpaper runs, the boundary announcement. The
largest and least certain piece, and deliberately last, because B and C between
them already make the corpus reachable. If D turns out to be more machinery than
it is worth, C is a complete answer and D is polish.

**Phase E — the sidecar's optional `alt`.** §3.5. Format change plus a fallback;
depends on a corpus that carries the field, so it is gated on the generator
rather than on anything here.

---

## 6. Already broken, and cheap to fix

Found by audit, in rough order of severity. All are Phase A.

1. **The panel's sliders have no accessible name.** `<label>rooms on the
   map</label>` is a *sibling* of its `<input type="range">`, with no `htmlFor`
   and no wrapping, so both sliders announce as bare numbers. Add the
   association, and `aria-valuetext` so the value means something ("42 of 511
   rooms" rather than "42").
2. **Page zoom is disabled.** `maximum-scale=1, user-scalable=no` in the
   viewport meta is a documented WCAG 1.4.4 failure and locks out exactly the
   low-vision users this map is hardest on. It is there to stop iOS treating a
   two-finger map pinch as a page zoom — but `touch-action: none` is already
   set all the way up the tree for that reason, which is the mechanism that
   actually does the work. Recommend dropping both attributes and verifying on
   a device; this ties into plan §7 item 11, which already wants an iOS pass on
   the in-tile search field.
3. **The room card is unreachable and unmanaged.** It opens only on right-click
   or long press — no keyboard path at all. It is `role="dialog"` with
   `aria-label="room"`, which tells a reader nothing; focus never moves into it,
   Escape does not close it, and focus is not restored on close. Give it a real
   label from `describeCell`, move focus in, close on Escape, restore focus to
   the originating cell.
4. **Reduced motion is honoured for the flight and not for the rearrangement.**
   `useMapCamera.js` checks `prefers-reduced-motion` per flight; `slide.js`'s
   five durations run unconditionally, so someone who asked for less motion
   still gets 1.2 seconds of sliding tiles on every search. See §4.3 — the
   fallback path already exists.
5. **The focus indicator on the search fields is `outline: none` plus a
   border-colour change.** A one-pixel hue shift is a weak indicator and is
   unlikely to clear the contrast requirement. Replace with a visible ring.
6. **The canvas has no role, no label and no fallback content.** Per §3.6 it
   should be `aria-hidden="true"` once the mirror exists; until then it needs a
   label, or it is an unnamed graphic that is also the entire application.
7. **The status note is not a live region.** `status` already carries exactly
   the text §3.4 wants announced — search results, rearrangement outcomes — and
   silently updates a `<div class="note">`. Making it the polite region is
   nearly free.
8. **The in-tile search field has no label**, relying on its placeholder, and
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
- The windowing function — `(bounds, focus, budget) → cells to mount` — is pure
  arithmetic and carries the hysteresis. Assert that the focused cell is always
  in the result, that the far-out rung engages before the node count runs away,
  and that a zoom held near the threshold does not oscillate.
- Wallpaper run-collapsing: a row of cells in, `aria-colspan` groups out.

**In the browser, `smoke.e2e.mjs`:** tab order reaches the map in one stop and
leaves it in one; arrows move focus and the camera follows; Enter opens the
card, Escape closes it and focus returns to the cell it came from; the live
region holds the expected text after a search. Per the repo's own rule, break
each of these on purpose once and confirm it fails.

**One open dependency question.** `@axe-core/playwright` would catch the whole
class of regression in §6 automatically, which matters precisely because tier-3
semantics are invisible and rot unwatched (§3.6). It would be e2e-only —
`e2e.yml` is manual dispatch, not a merge gate — so it never touches `npm test`
or the required check. Still a dependency in a repo that is deliberately short
on them, so it is a call to make rather than assume.

---

## 8. Still open

1. **Is the grid mirror worth building at all?** Phase C's ranked list is the
   lossless channel; Phase D is the *experience*, and it is most of the work
   here. Worth deciding with a real screen reader user rather than by argument.
2. **What the far-out rung should say.** "1,664 walls, 38 rooms" is a
   placeholder. The useful summary is probably about the gradient — how
   concentrated the current search is — not about counts.
3. **Whether the boundary should be a hard stop for the keyboard.** Pan
   resistance is analogue and a key press is not. Either arrows stop at the
   boundary (crisp, but the map really is infinite) or they cross it and the
   announcement carries the change (honest, but nothing out there is worth
   arrowing through).
4. **Focus during a rearrangement.** §4.3 keeps focus on the cell, but the cell
   is being animated for a second-odd. Whether the announcement waits for the
   animation to land or fires immediately is a real choice, and the answer is
   probably "fires immediately, because the animation is not for this reader".
5. **Does the results list survive a 5,000-room corpus?** It is a list of every
   ranked room. It will want its own windowing, which is the same problem as
   §3.1 with none of the spatial complications.
