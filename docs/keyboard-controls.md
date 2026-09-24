# Keyboard controls - map mode

The spec for every key map mode handles, state by state. Catalog mode is out
of scope here (see "Out of scope here"). `RoomOverlay.tsx` is the one
room-detail dialog, reached from a ranked result, a click/tap on a room, or
`Enter`/`Space` over the keyboard cursor, and it is fully modal (Tab trapped,
`Escape` closes).

## Focus states and tab order

Each focus target has its own key handler, and DOM focus alone decides which
one is live. No flag in the map code tracks "am I in the search box";
focusing an element turns its handler on and every other one off.

Tab order through the map subtree, top to bottom in the DOM:

1. **The canvas** (`role="application"`, `tabIndex={0}`) - the first stop.
   The `RoomDetails` chips nested inside it are `tabIndex={-1}`, so they add
   no stops.
2. **The search input**, `.center-search` - only while it is visible. It is
   positioned over the center tile and stays `display: none` until the
   render loop finds it on screen and legible (`MapView.tsx`). While hidden it
   is out of the tab sequence, not only visually hidden.
3. **The shelf's one roving book** (`role="toolbar"`) - of the buttons
   `BOOK_COUNT` generates, only the focused one has `tabIndex={0}` and the
   rest are `tabIndex={-1}`, so the wall costs one tab stop. It is gated on
   zoom and legibility like the search input (`useMapRenderer.ts`'s
   `booksEl.style.display`).
4. **`.center-book`** (the artist's-statement hotspot traced into the shelf
   gap) - gated like the shelf.
5. **`.center-controls`' buttons** - the reorder button, plus the two
   favorite-sort toggles when `favorites` is on. Gated like the shelf.
6. **`.search-trigger`** (the "go to search" icon button) - the one stop that
   is not zoom-gated. It is always mounted and always in the tab sequence, so
   with the camera away from the center the list collapses to the canvas and
   `.search-trigger`.

Plain `Tab` walks forward through whichever of 1-6 are visible, then leaves
the map subtree for whatever follows in the document, normally the browser's
own chrome. `Shift+Tab` walks the same list backward. Neither wraps: the map
is the whole page, not a modal, so Tab past the last stop reaches the
browser's UI as it would on any page.

**Getting back to the canvas** has two routes:

- `Shift+Tab`, once per visible stop between focus and the canvas.
- `Escape`, a direct jump to the canvas from any of stops 2-6. Three handlers
  implement it:
  - `useCenterShelf.ts`'s `onBooksKeyDown`, for the shelf.
  - `main.tsx`'s `onSearchKeyDown`, for the search input.
  - `main.tsx`'s `onControlKeyDown`, for every plain center-tile button
    (`.center-book`, the `.center-controls` buttons, `.search-trigger`).

## State 1 - Canvas focused (no overlay open, no book focused)

`role="application"` canvas, `useMapCursor.ts`'s `onMapKeyDown`.

| Key | Behavior |
|---|---|
| `ArrowLeft/Right/Up/Down` | Nudge camera one cell in that direction (damped pan), move+announce cursor |
| `Shift+Arrow` | Nudge by one screenful of cells instead of one |
| `Ctrl/Cmd+Arrow` | Jump cursor to next ranked room in that direction, or announce "nothing further" |
| `PageUp` / `+` / `=` | Zoom in one step, re-centered on cursor's cell |
| `PageDown` / `-` | Zoom out one step, re-centered on cursor's cell |
| `Home` | Fly to (0, 0) at the return-to-center zoom (`overviewZoom`) |
| `Ctrl/Cmd+Home` | Fly to rank-0 room, or announce "no ranked rooms" |
| `Ctrl/Cmd+End` | Fly to the last-ranked room, or announce "no ranked rooms" |
| `Enter` / `Space` | Open the room overlay for the room (or generic cell) under the cursor - no-op only on the center, matching right-click/long-press |
| `/` | Focus search (fly home first if search is off-screen) |
| `?` | Announce nearest ranked room in each direction + distance to boundary |
| `Tab` | Leave the canvas forward, to the first visible stop after it (see "Focus states and tab order") |

Plain `End` (no modifier) is unbound: unlike `Home`, it names no obvious cell.

**The cursor ring is the only visible sign the canvas has focus**, and it
shows as soon as focus arrives, before any arrow press. `useMapRenderer.ts`
listens for `focus`/`blur` on the canvas:

- On `focus`, it shows the ring if `canvas.matches(':focus-visible')`.
- On `blur`, it hides the ring.

`:focus-visible`, not `:focus`, keeps a mouse click on the map from lighting
up the ring, matching every other focus ring in the app (`style.css`'s
`:focus-visible` rules).

**Precedence rules:**
- A pointer/wheel/touch event always interrupts an in-flight keyboard-
  triggered flight.
- Repeated key-repeat presses in the same tick read the flight's *target*
  (`flightTarget()`), not its interpolated position, so they compound
  instead of cancelling.
- The ranked-content boundary is not a hard stop for arrows; crossing it is
  announced once per direction, not blocked.
- `prefers-reduced-motion` collapses every keyboard-triggered flight to an
  instant jump.
- A keyboard action does not end a rearrangement animation in progress. Its
  flight is overridden by the rearrangement's next camera move; only a
  pointer grab ends one. Issue #306 tracks these keys staying enabled while
  inert.

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
| `Tab` | Not intercepted - moves to the next visible stop in the tab order |

None of the canvas's `Ctrl+Arrow`, `PageUp/Down`, `/` or `?` bindings apply
with a book focused.

## State 3 - Search input focused

`SearchForm.tsx`. Every key not listed below is plain native
`<input type="search">` behavior - arrows move the caret, Enter submits the
form, standard text editing/selection applies unmodified.

| Key | Behavior |
|---|---|
| `Escape` | Return focus to the canvas (map's copy only - see below) |

The `Escape` binding is opt-in per instance: `SearchForm` takes an optional
`onKeyDown` prop, and only the map's copy (`MapView.tsx`) passes one
(`main.tsx`'s `onSearchKeyDown`). The catalog's copy passes none, since the
catalog has no canvas.

Canvas keys (`/`, `?`, arrows-as-pan) never fire while the input has focus,
because they are bound on the canvas alone. A `/` typed in the search box
inserts a literal `/`.

## State 4 - A plain center-tile control button focused

`.center-book`, `.center-controls`' reorder/mine/count buttons, and
`.search-trigger` - plain `<button>`s with no other keyboard behavior
(activation is native click, as for the shelf's books), sharing one
`onKeyDown` (`main.tsx`'s `onControlKeyDown`).

| Key | Behavior |
|---|---|
| `Escape` | Return focus to the canvas |
| `Enter` / `Space` | Native button activation |
| `Tab` / `Shift+Tab` | Not intercepted - ordinary DOM tab order (see "Focus states and tab order") |

## State 5 - `RoomOverlay` open

`role="dialog"`, `aria-modal="true"`. One handler, reached however the
overlay was opened (a ranked result, a click/tap on a room, or `Enter`/`Space`
on the keyboard cursor).

| Key | Behavior |
|---|---|
| `Escape` | Close the overlay |
| `Tab` / `Shift+Tab` | Trapped - wraps between the first and last focusable element inside the dialog |
| `Enter` / `Space` | Native button activation only |

While the overlay is open, the canvas and shelf handlers are inert: focus
moves into the dialog root on mount, so `onMapKeyDown`/`onBooksKeyDown` never
fire.

`HelpDialog` and `ArtistStatementOverlay` behave the same way: `Escape`
closes, Tab is trapped, and a `window`-level `keydown` listener acts only
while that dialog is topmost. `HelpDialog` inlines its listener;
`ArtistStatementOverlay` gets it from `useDialog`'s dialog stack.

## Out of scope here

Catalog mode's own keyboard behavior (list navigation, pagination, the
overlay reached from a catalog row) is a separate spec - the states above
cover map mode only.
