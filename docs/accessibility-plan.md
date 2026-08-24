# Accessibility plan — a second reading of the same map

## Still open

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
4. ~~**The rearrangement does not announce its new occupant at all yet.**~~
   **Built.** One live-region write carries three clauses: what decided the
   ranking (`describeSignals`, if a search caused it), what the map now looks
   like as a whole (`describeArrangement` — the size, and whether the gradient
   clustered anything), and the cell the reader ends up at. The search's note
   used to go out on its own the moment the ranking resolved; it is stashed and
   folded in instead, because two writes a few hundred milliseconds apart are
   two interruptions describing one event, and a polite region queues them
   rather than merging them.

   The timing question this item called secondary resolved itself into
   something simpler than "immediately vs. after the animation lands": the
   announcement waits for the CAMERA, not for the animation. An animated
   rearrangement parks on the center before it starts, so reading the cursor
   any earlier would name a cell the reader is about to be moved off. Under
   reduced motion — or any change that cannot be animated — nothing moves and
   the cursor's cell really does change occupant underneath them, which is
   §4.3's case exactly. Both paths read the cursor at the same point and need
   no branch.

   One consequence worth knowing, because it looks like a bug and is not: the
   cursor now moves without a keypress. Two browser tests had quietly relied on
   "the cursor only changes when a key is pressed" to assume the canvas was
   still named for the center; they establish their own precondition now. The
   interesting case is a listbox jump landing *during* a rearrangement's
   fly-home: it interrupts the flight, the library rebuilds at once, and the
   announcement names the room the reader chose. That is right, and it is the
   first time choosing a result says anything at all.
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
8. **Does `role="toolbar"` with roving tabindex read well on the shelf?**
   Phase D chose it over forty tab stops, and the reasoning (§5) is about the
   tab sequence, which is browser-observable. What is not: whether a reader
   announces "toolbar, 40 items" usefully for what is really a 5×8 wall, and
   whether up/down moving by shelf is discoverable without being told. `grid`
   would model the shape honestly and costs a much larger widget; `list` would
   model the queue honestly and gives back the forty stops. Folds into item 1 —
   it is the same "nobody has run a screen reader over this" gap, narrowed to
   one widget.
9. **Does a real screen reader receive `aria-posinset`/`aria-setsize` on a
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
