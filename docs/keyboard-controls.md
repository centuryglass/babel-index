# Keyboard controls - map mode

The spec for every key map mode handles, state by state. Catalog mode is out
of scope here (see the note at the end). `RoomCard` no longer exists -
`RoomOverlay.tsx` is the one room-detail dialog, reached from the card icon,
a click/tap on a room, or `Enter`/`Space` over the keyboard cursor, and it is
fully modal (Tab trapped, `Escape` closes) - there is no non-modal popover
variant to special-case.

## Focus states and tab order

Several independent key handlers exist, one per focus target. Which one is
live is decided entirely by DOM focus - there is no "am I in the search box"
style flag anywhere in the map code; focusing an element is what turns its
handler on and everything else off.

Tab order through the map subtree, top to bottom in the DOM:

1. **The canvas** (`role="application"`, `tabIndex={0}`) - the map's only
   *diegetic* forward tab stop. `MapView.tsx`'s own comment states this
   directly: "One tab stop for the entire map... so Tab always leaves the map
   in one press."
2. **The search input**, `.center-search` - *only when it is currently
   visible*. It renders positioned over the center tile and is
   `display: none` until the render loop finds it on screen and legible
   (`MapView.tsx`); while hidden it is out of the tab sequence entirely, not
   just visually hidden.
3. **The shelf's one roving book** (`role="toolbar"`) - forty book buttons
   exist, but only the currently-focused one has `tabIndex={0}`; the rest are
   `tabIndex={-1}` so the wall costs one tab stop, not forty. Zoom/legibility
   gated exactly like the search input (`useMapRenderer.ts`'s `booksEl.style
   .display`), so hidden and out of the tab sequence when not legible.
4. **`.center-book`** (the artist's-statement hotspot traced into the shelf
   gap) - same zoom/legibility gating as the shelf.
5. **`.center-controls`**' buttons - the reorder button (always present when
   its rect is legible) and the two favorite-sort toggles (`favorites`-gated
   on top of that). Same zoom/legibility gating as the shelf.
6. **`.search-trigger`** (the "go to search" icon button) - the one control
   in this list that is **not** zoom-gated. It is always mounted and always
   in the tab sequence regardless of where the camera is, which is why
   panning away from the center collapses this whole list down to just
   "canvas, then search-trigger" - every zoom-gated stop in between drops out
   of the tab order along with its `display: none`.

Plain `Tab` walks forward through whichever of 1-6 are currently visible, in
order, then leaves the map subtree entirely into whatever follows in the
document (normally nothing - the browser's own chrome). Plain `Shift+Tab`
walks the same list backward. Neither one *wraps* - there is no code making
the map subtree a closed loop, so pressing `Tab` on `.search-trigger` (or
whichever control is currently last) does not cycle back around to the
canvas; it exits into the browser, exactly as the last focusable element on
any ordinary, non-modal page would. See "Why doesn't Tab wrap back to the
canvas?" below for why that's deliberate rather than an oversight.

**Getting back to the canvas** therefore has two routes:

- `Shift+Tab`, repeated once per stop currently between focus and the
  canvas - one press from the search input or `.search-trigger` when nothing
  else is visible between them and the canvas, more the further out zoom has
  put you (up to all of 2-6 when everything is legible and `favorites` is
  on).
- `Escape`, a direct jump to the canvas from *any* of stops 2-6, regardless
  of how many are visible. `useCenterShelf.ts`'s `onBooksKeyDown` handles it
  for the shelf; `main.tsx`'s `onSearchKeyDown` and `onControlKeyDown` handle
  it for the search input and every plain center-tile button (`.center-book`,
  the three `.center-controls` buttons, `.search-trigger`) respectively -
  three call sites rather than one only because the shelf's handler already
  existed as part of `bookNeighbour`'s dispatch and had no reason to move,
  while the five plain buttons share nothing else worth factoring a hook
  around.

### Why doesn't Tab wrap back to the canvas?

It could - trapping Tab at the edges of the map subtree and cycling it back
onto the canvas is the same technique `RoomOverlay.tsx` already uses
internally. The reason it's *not* done here is what that technique is for:
`RoomOverlay`, `HelpDialog` and `ArtistStatementOverlay` trap Tab because
they are modal - the rest of the page is inert while they're open, so
nothing is lost by making them a closed loop, and a reader tabbing past the
last button is never trying to reach anything else.

The map is not modal. It's the whole page. A reader tabbing past
`.search-trigger` is not stuck inside a dialog by mistake; they're doing
exactly what `Tab` is supposed to do on any ordinary page - moving on to
whatever the browser or the rest of the document offers next (the address
bar, another extension's toolbar button, a browser tab strip). Trapping
that would mean the map hijacks Tab for as long as the page is open, which
is a much bigger intervention than a modal trap: it would cut off a keyboard
user's only way to reach the browser's own UI without switching input
method. That's the actual reason "make canvas first, or last, in a closed
cycle" isn't the fix - canvas already *is* first, and being last as well
only means something if the ends are joined, which is the same trap by
another name.

`Escape`, not a wrap, is the intended fix for "I ended up on a control I
didn't mean to press and want back on the map" - it's a direct jump rather
than a cycle, so it works the same regardless of how many zoom-gated
controls happen to be visible.

## State 1 - Canvas focused (no overlay open, no book focused)

`role="application"` canvas, `useMapCursor.ts`'s `onMapKeyDown`.

| Key | Behavior |
|---|---|
| `ArrowLeft/Right/Up/Down` | Nudge camera one cell in that direction (damped pan), move+announce cursor |
| `Shift+Arrow` | Nudge by one screenful of cells instead of one |
| `Ctrl/Cmd+Arrow` | Jump cursor to next ranked room in that direction, or announce "nothing further" |
| `PageUp` / `+` / `=` | Zoom in one step, re-centered on cursor's cell |
| `PageDown` / `-` | Zoom out one step, re-centered on cursor's cell |
| `Home` | Fly to (0, 0) at default zoom |
| `Ctrl/Cmd+Home` | Fly to rank-0 room, or announce "no ranked rooms" |
| `Ctrl/Cmd+End` | Fly to the last-ranked room, or announce "no ranked rooms" |
| `Enter` / `Space` | Open the room overlay for the room under the cursor (no-op on the center/generic cell, matching click) |
| `/` | Focus search (fly home first if search is off-screen) |
| `?` | Announce nearest ranked room in each direction + distance to boundary |
| `Tab` | Leave the canvas forward - to whichever of the search input/shelf/`.center-book`/`.center-controls`/`.search-trigger` is first among those currently visible (see "Focus states and tab order" above) |

Plain `End` (no modifier) is intentionally unbound: unlike `Home`, there is
no cell "End" obviously means on its own.

**The cursor ring is the only visible sign the canvas has focus**, and it
shows the instant focus arrives - it does not wait for a first arrow press.
`useMapRenderer.ts` attaches `focus`/`blur` listeners to the canvas
alongside its other DOM listeners; on `focus` it checks `canvas.matches(
':focus-visible')` and shows the ring if true, and `blur` always hides it.
`:focus-visible`, not plain `:focus`, is what keeps a mouse click on the map
from lighting up a permanent reticle for someone who never touched a
keyboard - the same distinction every other focus ring in this app already
draws (`index.html`'s global `:focus-visible` rule). This replaced an
earlier design where the ring only appeared after the first *handled*
keypress (gated on a `keyboardUsed` ref) - that hid the ring for exactly the
span between successfully tabbing onto the canvas and the first arrow press,
which is the one moment a keyboard user most needs confirmation that the tab
stop was real.

**Precedence rules, restated from code comments:**
- A pointer/wheel/touch event always interrupts an in-flight keyboard-
  triggered flight ("a hand on the map beats anything the map was doing to
  itself").
- Repeated key-repeat presses in the same tick read the flight's *target*
  (`flightTarget()`), not its interpolated position, so they compound
  instead of cancelling.
- The ranked-content boundary is not a hard stop for arrows; crossing it is
  announced once per direction, not blocked.
- `prefers-reduced-motion` collapses every keyboard-triggered flight to an
  instant jump.
- A rearrangement animation in progress is ended by any keyboard action
  here, falling back to an instant rebuild rather than sliding under it -
  the same rule the pointer path already follows.

## State 2 - Center shelf book focused (roving tabindex)

`role="toolbar"`, `useCenterShelf.ts`'s `onBooksKeyDown`.

| Key | Behavior |
|---|---|
| `ArrowLeft/Right` | Move roving focus along the flat book queue, wrapping at row ends |
| `ArrowUp/Down` | Move roving focus by shelf/column |
| `Home` | Jump to first book slot |
| `End` | Jump to last book slot |
| `Escape` | Return focus to the canvas |
| `Enter` / `Space` | Not intercepted - native `<button>` click activation fires `onBook(i)` |
| `Tab` | Not intercepted - leaves the shelf forward, out of the map subtree |

The shelf and the canvas are deliberately different key vocabularies, not
one handler gated by focus target - none of the canvas's Ctrl+Arrow,
PageUp/Down, `/`, or `?` bindings apply here, because none of them are
meaningful with a book focused rather than a map cell.

## State 3 - Search input focused

`SearchForm.tsx`. Every key not listed below is plain native
`<input type="search">` behavior - arrows move the caret, Enter submits the
form, standard text editing/selection applies unmodified.

| Key | Behavior |
|---|---|
| `Escape` | Return focus to the canvas (map's copy only - see below) |

This is the *only* difference from standard text entry, and it is opt-in per
instance: `SearchForm` takes an optional `onKeyDown` prop, and only the map's
copy (`MapView.tsx`) passes one (`main.tsx`'s `onSearchKeyDown`). The
catalog's copy of the same component passes nothing, because "return to the
canvas" isn't meaningful there - the catalog has no canvas to return to.

Everything else about "am I in the search box" is implicit: canvas keys
(`/`, `?`, arrows-as-pan, etc.) simply never fire while the input has DOM
focus, because there is no code anywhere checking focus target to suppress
them - focus ownership is the entire mechanism. One consequence worth
calling out explicitly: `/`, typed while already in the search box, inserts
a literal `/` character rather than doing anything special, since the
global `/`-to-focus binding lives on the canvas's handler alone.

## State 4 - A plain center-tile control button focused

`.center-book`, `.center-controls`' reorder/mine/count buttons, and
`.search-trigger` - five plain `<button>`s with no other keyboard behavior
of their own (activation is native click, same as the shelf's books), sharing
one `onKeyDown` (`main.tsx`'s `onControlKeyDown`).

| Key | Behavior |
|---|---|
| `Escape` | Return focus to the canvas |
| `Enter` / `Space` | Native button activation |
| `Tab` / `Shift+Tab` | Not intercepted - ordinary DOM tab order (see above) |

## State 5 - `RoomOverlay` open

`role="dialog"`, `aria-modal="true"`. One handler, reached however the
overlay was opened (icon, click/tap on a room, or `Enter`/`Space` on the
keyboard cursor).

| Key | Behavior |
|---|---|
| `Escape` | Close the overlay |
| `Tab` / `Shift+Tab` | Trapped - wraps between the first and last focusable element inside the dialog |
| `Enter` / `Space` | Native button activation only |

While open, canvas and shelf handlers are inert by construction: focus moves
into the dialog root on mount, so `onMapKeyDown`/`onBooksKeyDown` simply
never fire - the same "focus ownership is the whole gating mechanism"
pattern as the search box, and deliberately not backed by a redundant "is a
dialog open" flag anywhere.

`HelpDialog` and `ArtistStatementOverlay` follow the identical pattern
(their own independent `window`-level `keydown` listener, `Escape` closes,
Tab trapped) and are not restated here since they are not part of the center
tile's own control surface.

## Out of scope here

Catalog mode's own keyboard behavior (list navigation, pagination, the
overlay reached from a catalog row) is a separate spec - the states above
cover map mode only, per the scope this document was written to.
