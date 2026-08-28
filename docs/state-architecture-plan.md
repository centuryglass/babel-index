# The application-state plan

How `packages/web/src/main.jsx` gets taken apart, and what it is allowed to
become. Written after an outside review of the repo argued the algorithmic
architecture is modular and the application-state architecture is not; that
half of the critique held up, so this is the response to it.

Companion to [`implementation-plan.md`](implementation-plan.md), which carries
the entry pointing here.

## 1. What is actually wrong

`main.jsx` is ~1590 lines, of which about a third are comments - so ~980 lines
of code, ~190 of them JSX. It holds **19 `useState`, 18 `useRef` and 8 effects**,
and hands `MapView` **38 props**.

The prop count is the honest symptom. `MapView`'s own header already says it is
"a presenter, not an owner", and that is true and worth keeping - the catalog
reads the same state and two copies would be two chances to disagree. But
"everything lives in `Library`" only stays a design while `Library` is small
enough to read. It is not any more.

Two things are NOT wrong, and the plan must not damage them:

- **The search result is already one immutable object.** `setResult({ order,
  certainty, breakdown, signals, term })` is a single piece of state describing
  a single search, with `layout`, `order`, `catalogOrder`, `cellById` and
  `highlight` derived from it by memo. The review proposed exactly this shape as
  a design target; it already shipped. Nothing here re-derives it.
- **The derivation chain is already a chain.** `result -> layout -> order ->
  cellById -> renderer` runs one way, through memos. There is no back-edge to
  break.

What is genuinely implicit is the part that is *not* derived: three mutable refs
(`animateNext`, `pendingNote`, `arrangement`) coordinating with one
`useLayoutEffect` to decide whether a change to the map animates, what gets said
about it, and when. That sequence is the real state machine, it is written in
refs and effect ordering, and it is the thing a reader cannot see by looking at
any one place.

## 2. The rule this refactor runs under

**A hook earns its place if it hides state nobody outside it needs to see.**

A hook that takes fifteen parameters and returns fifteen values has moved lines
without moving responsibility, and has made things worse: the coupling is now
invisible *and* spread across two files. That is the failure mode to check for
at every step. If an extraction's signature is as wide as the state it
encapsulates, abandon it and leave the code where it is.

Corollaries:

- **Refactor only.** No behavioral change in any step here. A step that wants
  one is a different PR with its own justification.
- **The e2e suite is the safety net,** and the file-level rule applies: if a
  step could have broken something and no test noticed, break it on purpose and
  find out why not before moving on.
- **One step per PR.** These are individually reviewable and individually
  revertable; a single "split main.jsx" PR is neither.
- **Numbers do not move.** Every by-feel value stays in `packages/config`; a
  hook restating a duration locally is the drift this repo already warns about.

## 3. What comes out, in order

Ordered by risk, cheapest and best-covered first, so the file is smaller and
clearer by the time the hard one is due.

### Step 1 - `useMapCursor` (largest, most mechanical)

**Takes in:** `layout`, `order`, `metadata`, `cam`, `canvasRef`, `flyTo`,
`nudgeBy`, `flightTarget`, `config.camera`, `setStatus`, and the two callbacks
it cannot own (`goToSearchRef`, `setCard`).
**Gives back:** `{ cursor, cursorLabel, cursorEntry, cursorDesc, onMapKeyDown,
announceCursorMove, announceArrangement, announceSurroundings, keyboardUsed }`.

**Hides:** `granularityRef`, `wasBeyondBoundary`, `cursorNow`, the announcement
assembly, and the whole ~180-line `onMapKeyDown` switch. Those four are read
nowhere else in the file, which is what makes this the clearest win available -
roughly 300 lines out for a seam that is genuinely narrow.

`announceArrangement` is the awkward member: the rearrangement effect calls it,
and it consumes `pendingNote`. Leave `pendingNote` in `main.jsx` for now and
pass the lead string *in* as an argument. Step 5 gives it a proper home.

**Watch for:** `cursorNow()` must keep reading `flightTarget()`, never
`cam.current` - the compounding-keypress rule. `announceCursorMove` after
`nudgeBy` must still re-read where the move actually landed rather than where it
aimed.
**Covered by:** `packages/web/e2e/keyboard-cursor.e2e.ts` (~10 tests,
including the compounding-presses and boundary-glide cases).

### Step 2 - `useCenterShelf`

**Takes in:** `metadata`, `config.map.slotSeed`, `history`, `booksRef`, and the
actions a book can run (`search`, `setQuery`, `enterCatalog`, `setHelpOpen`,
`forgetSearches`).
**Gives back:** `{ centreSlots, bookFocus, setBookFocus, onBook, onBooksKeyDown }`.

**Hides:** `tags`, `overrides`, `onOverride`. The `overrides` memo exists only
to add the forget-searches book when history is non-empty, and `tags` only feeds
`assignTitles` - neither is anyone else's business.

`tapRef.current` stays in `main.jsx`: it routes the search box *and* the books,
so it is not the shelf's alone. It calls `onBook` from the hook, which is
already the "one implementation, two entry points" the shelf's comment insists
on - and this step must not accidentally make it two.

**Covered by:** the shelf block (one tab stop in, arrows within, a book
searches) plus the axe sweep with the shelf on screen.

### Step 3 - `useModeTransition`

**Takes in:** `canvasRef`, `cam`, `config.catalog`, `firstTileRef`.
**Gives back:** `{ mode, leaving, enterCatalog, exitCatalog, firstTileRef }`.

**Hides:** `flipFrom`, `centreRectNow`, `animatedSwitch`, and the FLIP
`useLayoutEffect`. This is the most self-contained block in the file - it is
already fenced off by a section comment and touches nothing but the DOM and its
own three values.

**Watch for:** the map must stay HIDDEN, never unmounted. The hook returns
`mode`; it must not acquire an opinion about what gets rendered.
**Covered by:** the catalog fold-out test, and the drag-after-mode-switch test
that exists precisely because every cheaper assertion passes under the remount
bug.

### Step 4 - `useCorpus`

**Takes in:** `manifest`.
**Gives back:** `{ metadata, embeddings, searchIndex, described }`.

Small and obvious: two fetch effects, one memo, one derived count. Worth doing
mostly because it is the natural place for the manifest fetch in `App` to move
to as well, putting "everything the corpus is" behind one call.

**Watch for:** `embeddings` stays a ref holding `{ data, dim }`. It is a
megabyte-scale `Int8Array` that must not become React state.

### Step 5 - `useRearrangement` (the point of the exercise)

**Takes in:** `layout`, `order`, `mode`, `canvasRef`, `searchFormRef`, `cam`,
`flyTo`, `requestDraw`, `config`, `anim`, and an `announce(lead)` callback.
**Gives back:** `{ requestAnimation(note), rearranging }`.

**Hides:** `animateNext`, `arrangement`, `pendingNote`, `startRearrangement`,
and the `useLayoutEffect` that ties them together.

This is where the implicit state machine becomes explicit, and the whole reason
the previous four steps happen first. Today a caller says "the next layout
change should animate" by assigning `animateNext.current = true` and, separately,
leaves a sentence in `pendingNote.current` for whatever eventually speaks. Those
are one act, and the extraction should say so: **one call, `requestAnimation(note)`,
carrying both.** Then `reorder`, `rescatter` and `search` each make one
statement of intent instead of two coordinated writes, and the failure mode that
produced the `animateNext` half of the search-error bug - a flag set before an
await and stranded when it threw - stops being expressible.

`anim` itself stays a ref owned by `main.jsx` and passed in, because
`useMapRenderer` reads it every frame and the render loop must not be rebuilt
when it changes.

**Watch for:** all four standing invariants -
the `useLayoutEffect` ordering (the hold must be in place before the first paint
of the new arrangement); `anim.current.before` holding the OLD arrangement
during the flight home; the supersede check (`anim.current?.before !== before`)
returning `true` rather than `false`; and the announcement firing only when
`arrangement.current === current`.
**Covered by:** the rearrangement announcement test, the reduced-motion rebuild
test, and the searches that drive both.

### Step 6 - `useSearch`, last and smallest

**Takes in:** `total`, `config.search`, `searchIndex`, `embeddings`,
`requestAnimation`, `pushHistory`.
**Gives back:** `{ query, setQuery, result, search, runSearch, clearSearch,
highlight }`.

Deliberately last. By this point `search()` has one way to ask for an animation
rather than two, so the hook is a thin thing worth having; done first it would
have to reach out and set `animateNext` and `pendingNote` on someone else's
behalf, which is the fifteen-parameter failure this plan is trying to avoid.

`searchSeq` and the fetch's error handling move in with it. `history` and
`pushHistory` stay outside: the shelf reads them, the panel's forget button
writes them, and they survive a reload - a search is a consumer of history, not
its owner. (This is the review's `useSearchHistory` and it is declined: it would
be four lines behind a call.)

## 4. What is deliberately NOT extracted

- **`useLibraryLayout`.** `layout`, `order`, `catalogOrder` and `cellById` are
  four memos with one input each, sitting in dependency order. They are already
  the clearest thing in the file. A hook around them would hide nothing and cost
  a reader one indirection to learn that.
- **`useCatalog`.** The catalog's own state is `paging` (persisted, five lines)
  and its scroll ref. Step 3 takes the transition; the remainder is not a
  subsystem.
- **A global store (Redux, Zustand, context).** The prop-drilling is real but the
  cure is worse here: the render discipline in this app is deliberate - refs
  where a re-render per frame would be fatal, state only where JSX needs it -
  and a store invites exactly the re-render-everything pattern `cam`,
  `keyboardUsed` and `anim` exist to avoid.
- **Component decomposition inside `MapView`.** The 38 props shrink on their own
  as the hooks above start returning grouped objects (`shelf`, `cursor`,
  `panel`); that is the right time to look again, not before.

## 5. Definition of done

`main.jsx` reads as: load the corpus, derive the layout from the search, wire
six subsystems together, render two views. Under ~500 lines, with no mutable ref
in it that two different subsystems both write.

That last clause is the actual goal. The line count is how it will be noticed;
it is not what is being fixed.
