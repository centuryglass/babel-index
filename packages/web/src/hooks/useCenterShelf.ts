/**
 * The center room's bookshelf - the wall of history/tag/override books, the
 * roving-tabindex focus, and what a tap or an arrow key does against it.
 *
 * `search`, `enterCatalog`, `setHelpOpen` and `forgetSearches` arrive as plain
 * arguments: `main.tsx` calls this hook only once all four exist, and
 * `centreSlots` has no reader until `useMapRenderer`, so nothing here is
 * forward-referenced.
 *
 * The tap path stays in `main.tsx`: `tapRef` routes the search box as well as
 * the books, so it is not the shelf's alone. It calls `onBook` from this hook,
 * which keeps "what does book i do" to one implementation.
 */
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { assignTitles, pickTags, bookNeighbour, BOOK_COUNT, type Slot } from '../lib/center.ts';
import type { RoomMeta } from '../../../map/metadata.ts';

/**
 * Books on the center shelf with a fixed distinct function, reserved by slot
 * index. The bottom-right "forget searches" book is layered on top of this in
 * `overrides` rather than living here, because its presence depends on
 * `history` and these never vary.
 */
const CENTER_OVERRIDES: Record<number, { text: string; action: string }> = {
  0: { text: 'READ ME', action: 'help' },
  1: { text: 'The Catalog', action: 'catalog' },
};

interface UseCenterShelfOpts {
  /** joined per-room keywords and story */
  metadata: (RoomMeta | null)[] | null;
  /** config.map.slotSeed - seeds which tags fill the wall */
  slotSeed: number;
  /** search history, newest first */
  history: string[];
  booksRef: { current: HTMLElement | null };
  /** `Escape` returns focus here - the only way back to the canvas besides `Shift+Tab` */
  canvasRef: { current: HTMLElement | null };
  /** fills the search box to match a pressed book */
  setQuery: (term: string) => void;
  /** a history/tag book repeats its search */
  search: (term: string) => void;
  /** the reserved "The Catalog" book */
  enterCatalog: () => void;
  /** the reserved "READ ME" book */
  setHelpOpen: (open: boolean) => void;
  /** the reserved "forget searches" book */
  forgetSearches: () => void;
}

export function useCenterShelf({
  metadata,
  slotSeed,
  history,
  booksRef,
  canvasRef,
  setQuery,
  search,
  enterCatalog,
  setHelpOpen,
  forgetSearches,
}: UseCenterShelfOpts) {
  // The pool of stable random corpus keywords that letter the books history
  // and the overrides have not claimed. `pickTags` is pure and seeded by
  // `slotSeed`, so this is a memo, not per-frame work.
  const tags = useMemo(() => pickTags(metadata, slotSeed), [metadata, slotSeed]);

  // The bottom-right book: the one override that is present only while there
  // is something to forget.
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

  // The center room's book titles: override books first, then past searches
  // filling the wall newest-first, then the tag pool for whatever is left
  // (docs/agents/map.md, "The center room's controls").
  const centreSlots = useMemo(
    () => assignTitles({ history, tags, overrides }),
    [history, tags, overrides]
  );

  // Which book on the shelf holds the wall's single tab stop.
  //
  // Roving tabindex - one stop in, arrows within, Tab straight out - because
  // the wall is a browsable index of keywords, and putting every book in the
  // tab sequence would tax every keyboard user with a press per book to get
  // past it. The key-by-key spec is docs/keyboard-controls.md, "State 2 -
  // Center shelf book focused".
  const [bookFocus, setBookFocus] = useState(0);

  /** What an override book does, dispatched on its `action`. */
  const onOverride = useCallback(
    (slot: Slot) => {
      if (slot?.action === 'catalog') enterCatalog();
      else if (slot?.action === 'help') setHelpOpen(true);
      else if (slot?.action === 'forgetHistory') forgetSearches();
    },
    [enterCatalog, setHelpOpen, forgetSearches]
  );

  /**
   * What book `i` does, for both entry points: a sighted click arrives
   * through `onTap` -> `bookAtPoint` in `main.tsx`, a keyboard Enter (and a
   * screen reader's activate) through the button's own click.
   *
   * A history or tag book repeats its search; an override book runs its
   * function; an untitled book does nothing, and has no button.
   */
  const onBook = useCallback(
    (i: number) => {
      const slot = centreSlots[i];
      if (!slot) return;
      if (slot.term) {
        setQuery(slot.term);
        search(slot.term);
      } else if (slot.action) {
        onOverride(slot);
      }
    },
    [centreSlots, setQuery, search, onOverride]
  );

  // Arrows move within the shelf; Tab leaves it. Left and right run along the
  // wall's flat queue across shelf ends, up and down move a shelf holding the
  // column - `bookNeighbour` owns all of it, and Home and End call it from
  // just outside the wall's ends rather than duplicating the walk, so what a
  // press does is asserted without a browser.
  //
  // `Escape` is the shortcut back to browsing the map. `Shift+Tab` also gets
  // there - the canvas is the tab stop before the shelf, and before the search
  // box when it is on screen - but it costs one or two presses depending on
  // whether the search box is currently visible, and reversing direction is
  // not the obvious move for a reader who just wants out. `Escape` is a
  // direct jump regardless.
  const onBooksKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        canvasRef.current?.focus();
        return;
      }
      const dir = ({
        ArrowLeft: { dx: -1 }, ArrowRight: { dx: 1 },
        ArrowUp: { dy: -1 }, ArrowDown: { dy: 1 },
      } as Record<string, { dx?: number; dy?: number }>)[e.key];
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
      (booksRef.current?.querySelector(`[data-book="${next}"]`) as HTMLElement | null)?.focus();
    },
    [bookFocus, centreSlots, booksRef, canvasRef]
  );

  return { centreSlots, bookFocus, setBookFocus, onBook, onBooksKeyDown };
}
