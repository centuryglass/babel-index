/**
 * The center room's bookshelf - the wall of history/tag/override books, the
 * roving-tabindex focus, and what a tap or an arrow key does against it.
 *
 * Split out of `main.jsx` per `docs/state-architecture-plan.md` §3 step 2. The
 * three pieces this hides - `tags`, `overrides` and `onOverride` - had no
 * reader anywhere else in that file, which is what made this the second
 * cleanest seam after the cursor.
 *
 * `search`, `enterCatalog`, `setHelpOpen` and `forgetSearches` arrive through
 * one ref (`actionsRef`) rather than as plain arguments. This hook has to run
 * early enough that `centreSlots` is ready before the render loop needs it
 * (`useMapRenderer` reads it), and all four of those are declared much further
 * down `main.jsx` - `search` closes over the fetch machinery, `enterCatalog`
 * over the camera. Same trick `useMapCursor` uses for `goToSearchRef`, and for
 * the same reason: `main.jsx` fills in `actionsRef.current` once everything it
 * needs exists, and every book press after that reads the live functions
 * rather than a closure captured before they were.
 *
 * `tapRef.current` stays in `main.jsx`: it routes the search box AND the
 * books, so it is not the shelf's alone. It calls `onBook` from this hook,
 * which keeps "what does book i do" to one implementation - a second copy
 * here would make it two.
 */
import { useCallback, useMemo, useState } from 'react';
import { assignTitles, pickTags, bookNeighbour, BOOK_COUNT } from './center.js';

/**
 * Books on the center shelf with a fixed distinct function, reserved by slot
 * index. The bottom-right slot (a "forget searches" book, present only while
 * there is history to forget) is layered on top of this in `overrides` below
 * rather than folded in here, because this list has nothing to react to and
 * that slot does.
 */
const CENTER_OVERRIDES = {
  0: { text: 'READ ME', action: 'help' },
  1: { text: 'The Catalog', action: 'catalog' },
};

/**
 * @param {object} opts
 * @param {object[]|null} opts.metadata   joined per-room keywords and story
 * @param {number} opts.slotSeed          config.map.slotSeed - seeds which tags fill the wall
 * @param {string[]} opts.history         search history, newest first
 * @param {{current: HTMLElement|null}} opts.booksRef
 * @param {Function} opts.setQuery        fills the search box to match a pressed book
 * @param {{current: {search: Function, enterCatalog: Function, setHelpOpen: Function, forgetSearches: Function}}} opts.actionsRef
 */
export function useCenterShelf({ metadata, slotSeed, history, booksRef, setQuery, actionsRef }) {
  // The center room's book titles. Every book shows a stable random corpus
  // keyword until history reaches it: past searches fill the wall newest
  // first, top left to bottom right. Reserved override books are never
  // overwritten. `assignTitles` is pure, so this is a memo, not per-frame work.
  const tags = useMemo(() => pickTags(metadata, slotSeed), [metadata, slotSeed]);

  // The bottom-right book is a second override, present only while there is
  // something to forget. Built alongside `CENTER_OVERRIDES` rather than
  // folded into it because that one is a fixed constant with nothing to react
  // to, and this slot's presence depends on `history`.
  const overrides = useMemo(() => {
    if (!history.length) return CENTER_OVERRIDES;
    return {
      ...CENTER_OVERRIDES,
      [BOOK_COUNT - 1]: {
        text: `forget searches (${history.length})`,
        action: 'forgetHistory',
      },
    };
  }, [history.length]);

  const centreSlots = useMemo(
    () => assignTitles({ history, tags, overrides }),
    [history, tags, overrides]
  );

  // Which book on the shelf holds the wall's single tab stop.
  //
  // Roving tabindex, the ordinary toolbar pattern: forty buttons each in the
  // tab sequence would put forty presses between the map and the panel, which
  // is a tax on every keyboard user for a wall that is mostly a browsable
  // index of keywords. One stop in, arrows within, Tab straight out - the same
  // shape the map itself has (accessibility-plan.md §4.2b's "arrows mean
  // whatever the focused thing says they mean").
  const [bookFocus, setBookFocus] = useState(0);

  /**
   * What an override book does. The seam this file has carried empty since the
   * shelf was built; the catalog is the first thing to claim a slot.
   */
  const onOverride = useCallback(
    (slot) => {
      const { enterCatalog, setHelpOpen, forgetSearches } = actionsRef.current;
      if (slot.action === 'catalog') enterCatalog();
      else if (slot.action === 'help') setHelpOpen(true);
      else if (slot.action === 'forgetHistory') forgetSearches();
    },
    [actionsRef]
  );

  /**
   * What book `i` does. ONE implementation, two entry points: a sighted click
   * arrives through `onTap` -> `bookAtPoint` in `main.jsx`, a keyboard Enter
   * (and a screen reader's activate) through the button's own click. Two
   * copies of "what does book i do" would drift, which is the whole reason
   * this is not written inline in either.
   *
   * A history or tag book repeats its search; an override book runs its
   * function; an untitled book does nothing, and has no button.
   */
  const onBook = useCallback(
    (i) => {
      const slot = centreSlots[i];
      if (!slot) return;
      if (slot.term) {
        setQuery(slot.term);
        actionsRef.current.search(slot.term);
      } else if (slot.action) {
        onOverride(slot);
      }
    },
    [centreSlots, setQuery, actionsRef, onOverride]
  );

  // Arrows move within the shelf; Tab leaves it. Left and right run along the
  // wall's flat queue across shelf ends, up and down move a shelf holding the
  // column - `bookNeighbour` owns both, so what a press does is asserted
  // without a browser. Home and End reuse it from outside the wall rather than
  // being a second way to say "first" and "last".
  const onBooksKeyDown = useCallback(
    (e) => {
      const dir = {
        ArrowLeft: { dx: -1 }, ArrowRight: { dx: 1 },
        ArrowUp: { dy: -1 }, ArrowDown: { dy: 1 },
      }[e.key];
      const next = dir
        ? bookNeighbour(bookFocus, dir, centreSlots)
        : e.key === 'Home'
          ? bookNeighbour(-1, { dx: 1 }, centreSlots)
          : e.key === 'End'
            ? bookNeighbour(BOOK_COUNT, { dx: -1 }, centreSlots)
            : null;
      if (next === null) return;
      e.preventDefault();
      setBookFocus(next);
      booksRef.current?.querySelector(`[data-book="${next}"]`)?.focus();
    },
    [bookFocus, centreSlots, booksRef]
  );

  return { centreSlots, bookFocus, setBookFocus, onBook, onBooksKeyDown };
}
