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
   item can move. Phase B shipped first so there is something usable if the
   answer turns out to be bad.
2. **What the far-out announcement should say.** What shipped — *"the far
   field near (x, y) - too far out to name a single room"* — is a placeholder,
   not a real answer. The useful summary is probably about the gradient — how
   concentrated the current search is — not about coordinates.
3. **How far should ctrl+arrow look before giving up?** It walks `rankOf` along
   an axis to the boundary, which is nothing at 27 rooms and a 200-cell walk at
   the far edge of a full corpus. Bounded per keypress, almost certainly, but
   the bound is a feel question: too short and the key does nothing in the far
   field, too long and one press crosses half the library.
4. **Whether the dense view and this plan should share any code.** The
   dense/linear view is deferred as its own subproject, on the argument that
   it must not be built as an accessibility feature. The thing to watch when
   it does get built is `describeCell` — it is the one module both would
   want, and it is the one module that is safe to share, because it names
   rooms rather than arranging them.
5. **Does `role="toolbar"` with roving tabindex read well on the shelf?**
   Phase D chose it over one tab stop per book, and the reasoning is about the
   tab sequence, which is browser-observable. What is not: whether a reader
   announces "toolbar, 40 items" usefully for what is really a wall of books
   in rows, and whether up/down moving by shelf is discoverable without being
   told. `grid` would model the shape honestly and costs a much larger widget;
   `list` would model the queue honestly and gives back the per-book stops.
   Folds into item 1 — it is the same "nobody has run a screen reader over
   this" gap, narrowed to one widget.
6. **Does a real screen reader receive `aria-posinset`/`aria-setsize` on a
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
