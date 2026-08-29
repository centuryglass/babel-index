import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createLayout, shuffledOrder } from '../../map/ordering.ts';
import { availableSensitiveTags, countBlocked, filterBlockedIds } from '../../map/metadata.ts';
import { RoomCard } from './components/RoomCard.tsx';
import { MapView } from './components/MapView.tsx';
import { CatalogView } from './components/CatalogView.tsx';
import { RoomOverlay } from './components/RoomOverlay.tsx';
import { HelpDialog } from './components/HelpDialog.tsx';
import { alphabeticalOrder } from './lib/catalog.ts';
import { load, save, clear, KEYS } from './lib/persist.ts';
import { TOUCH_DEBUG, appendTouchLog } from './lib/touchDebug.ts';
import { roomAtPoint } from './lib/picking.ts';
import { describeCell, describeRoom, describeCatalog } from '../../map/describe.ts';
import {
  bookAtPoint,
  centerCellRect,
  searchBoxScreenRect,
  isSearchBoxUsable,
  searchBoxAtPoint,
  areSpinesLegible,
  overlapsViewport,
  HISTORY_SLOT_COUNT,
  CENTER_OPENING_RECT,
  minZoomForSearchBox,
} from './lib/center.js';
import { CELL_ASPECT, fitZoom } from './lib/camera.ts';
import { createTileCache, CENTER, genericId } from './lib/tiles.ts';
import { createUrlFor, createTileLocator } from './lib/rooms.ts';
import { createRenderer } from './lib/render.ts';
import { createSlideRenderer } from './lib/slide.js';
import { BASE_TILE } from './lib/pyramid.ts';
import { useMapCamera } from './hooks/useMapCamera.ts';
import { useMapRenderer } from './hooks/useMapRenderer.ts';
import { useMapCursor } from './hooks/useMapCursor.ts';
import { useCenterShelf } from './hooks/useCenterShelf.ts';
import { useModeTransition } from './hooks/useModeTransition.ts';
import { useCorpus } from './hooks/useCorpus.ts';
import { useRearrangement } from './hooks/useRearrangement.ts';
import { useSearch, describeSignals } from './hooks/useSearch.ts';

function App() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('api/manifest')
      .then((r) => r.json())
      .then(setManifest)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="panel">Could not load the corpus: {error}</div>;
  if (!manifest) return <div className="panel">Opening the library…</div>;
  return <Library manifest={manifest} />;
}

function Library({ manifest }) {
  const canvasRef = useRef(null);
  // The live search field lives on the center tile, not in the panel; its
  // position is driven imperatively from the render loop below, the same way
  // the canvas itself is - see `positionSearchBox`.
  const searchFormRef = useRef(null);
  // The book buttons' container - one absolutely-positioned box matching the
  // center cell, positioned imperatively from the render loop exactly as the
  // search field is. The forty buttons inside it are laid out in percentages,
  // so this is the only per-frame geometry the shelf costs.
  const booksRef = useRef(null);
  // The search badge's orbiting arrow - not diegetic content, but it still
  // moves every frame with the camera (it points at wherever the center tile
  // currently is on screen), so it gets the same imperative-ref treatment as
  // the two center-tile overlays above rather than being React state.
  const searchArrowRef = useRef(null);
  const total = manifest.count;

  // Every by-feel starting value comes from the manifest's config block rather
  // than from a literal here - see packages/config. The sliders still move
  // freely afterwards; config decides where they start.
  const config = manifest.config;

  // How the catalog advances, and one of the two things that survive a reload.
  // Config supplies the DEFAULT for a reader who has never chosen; a stored
  // choice wins over it.
  const [paging, setPaging] = useState(() =>
    load(KEYS.paging, manifest.config.catalog.paging, {
      validate: (v) => v === 'scroll' || v === 'pages',
    })
  );
  useEffect(() => {
    save(KEYS.paging, paging);
  }, [paging]);

  const [roomCount, setRoomCount] = useState(total);
  const [contentRatio, setContentRatio] = useState(config.map.contentRatio);
  const [seed, setSeed] = useState(config.map.slotSeed);
  const [orderSeed, setOrderSeed] = useState(1);
  const [status, setStatus] = useState('');
  // Search history, newest first, one book per entry - and one of the two
  // things in this app that survives a reload (see `persist.js` for why so few
  // do). It is not only a convenience: this is what titles the center room's
  // shelf, so persisting it makes the wall of books a record of what this
  // reader has asked the library rather than something that resets to keyword
  // tags every session.
  //
  // Read once at mount, through a validator - storage is hand-editable and
  // outlives any given version of this code, so "it parsed" is not the same as
  // "it is a list of search terms". Capped at the wall's size, because the wall
  // is the only place it is ever shown.
  const [history, setHistory] = useState(() =>
    load(KEYS.history, [], {
      validate: (v) => Array.isArray(v) && v.every((term) => typeof term === 'string'),
    }).slice(0, HISTORY_SLOT_COUNT)
  );
  const pushHistory = useCallback((term) => {
    setHistory((prev) => [term, ...prev.filter((t) => t !== term)].slice(0, HISTORY_SLOT_COUNT));
  }, []);
  // Cleared rather than stored empty, so forgetting really does leave nothing
  // behind rather than an empty key that reads the same but looks different.
  useEffect(() => {
    if (history.length) save(KEYS.history, history);
    else clear(KEYS.history);
  }, [history]);

  // Sensitive-content tags a reader has chosen to block, from HelpDialog's
  // collapsible panel. Seeded from `?blockTags` on first visit only - once
  // there is a stored choice it wins, the same "read once, then the reader
  // owns it" rule `paging` and `history` already follow. Persisted for the
  // same reason `history` is: it is a standing choice about the library, not
  // session state, and forgetting it on reload would mean re-blocking by hand
  // every time.
  const [blockedTags, setBlockedTags] = useState(() =>
    load(KEYS.blockedTags, URL_BLOCKED_TAGS, {
      validate: (v) => Array.isArray(v) && v.every((t) => typeof t === 'string'),
    })
  );
  const toggleBlockedTag = useCallback((tag) => {
    setBlockedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }, []);
  useEffect(() => {
    if (blockedTags.length) save(KEYS.blockedTags, blockedTags);
    else clear(KEYS.blockedTags);
  }, [blockedTags]);
  const blockedTagSet = useMemo(() => new Set(blockedTags), [blockedTags]);

  // Everything the corpus IS - the sidecar, the embedding blob, the search
  // index built over them. See useCorpus.ts.
  const { metadata, embeddings, searchIndex, described, tagLinks } = useCorpus(manifest);

  // Every sensitive-content tag the corpus actually has, for the panel's
  // checklist - not a fixed vocabulary, so a corpus with none renders no
  // panel at all. And how many rooms the current choice actually removes,
  // for the panel itself and the debug HUD (`useMapRenderer`).
  const availableTags = useMemo(() => availableSensitiveTags(metadata), [metadata]);
  const blockedCount = useMemo(() => countBlocked(metadata, blockedTagSet), [metadata, blockedTagSet]);

  // `requestAnimation` doesn't exist yet - it comes back from `useRearrangement`
  // below, which itself needs `announce`, which needs this hook's `result` to
  // say what a change was for. `useSearch` has to run before that circle closes,
  // so it takes a ref and `main.jsx` fills it in once `useRearrangement` has
  // returned - see useSearch.ts's file comment.
  const requestAnimationRef = useRef(() => {});
  const { query, setQuery, result, search, runSearch, clearSearch, highlight } = useSearch({
    total,
    searchConfig: config.search,
    searchIndex,
    embeddings,
    requestAnimationRef,
    pushHistory,
    setStatus,
  });

  // Both of these are runtime parameters: changing either re-derives the
  // layout without touching a single byte of downloaded image data.
  //
  // The cell aspect goes in so the library is round on screen rather than round
  // in the index - the edge should be the same distance away whichever way you
  // drag, and with a non-square cell those are not the same thing.
  //
  // The search's certainty profile rides in as `density`, which is what makes
  // the matches cluster toward the center rather than scatter at the slider's
  // ratio. No search means no profile, and no profile means the uniform map -
  // so clearing the box restores it exactly, without a second code path.
  // How many generic tiles the corpus shipped, and the seed that scatters
  // them. Both are positional and order-independent, so they never change under
  // a search or a reorder - which is why the rearrangement can treat every
  // generic cell as one interchangeable value.
  const genericCount = manifest.shared?.generic?.length ?? 0;
  const genericSeed = config.map.genericSeed;

  const layout = useMemo(
    () =>
      createLayout({
        roomCount: Math.min(roomCount, total),
        contentRatio,
        seed,
        aspect: CELL_ASPECT,
        genericCount,
        genericSeed,
        density: result?.certainty
          ? { ...config.search.density, certainty: result.certainty }
          : null,
      }),
    [roomCount, contentRatio, seed, total, result, config, genericCount, genericSeed]
  );

  const order = useMemo(() => {
    // A search ranks the whole corpus; the layout takes as many as it has slots.
    const base = result ? result.order : shuffledOrder(total, orderSeed);
    // A blocked room drops out of the ranking entirely - not hidden behind a
    // cell, absent from it - so it never gets a slot on the map at all.
    return filterBlockedIds(base, metadata, blockedTagSet);
  }, [total, orderSeed, result, metadata, blockedTagSet]);

  // The catalog's own order: a shuffle is not a list order anyone can read by
  // eye, so its idle default is alphabetical rather than a second read of the
  // map's random `order`. The two only agree while a search is running -
  // `result.order` is the one array both views take a rank from - which is
  // why a search and a clear are the only things that can move a room's
  // catalog row, exactly as they are the only things that move it on the map.
  const catalogOrder = useMemo(() => {
    const base = result ? result.order : alphabeticalOrder(manifest.rooms);
    return filterBlockedIds(base, metadata, blockedTagSet);
  }, [manifest, result, metadata, blockedTagSet]);

  // Which cell a room id sits in on the map right now, keyed by id rather
  // than by rank - the catalog's rank in `catalogOrder` and the map's rank in
  // `order` are the same number only while a search is active, so "show on
  // the map" has to look a room up by what it IS, not by its row position.
  const cellById = useMemo(() => {
    const cells = new Map();
    order.forEach((id, rank) => {
      const cell = layout.cellOfRank(rank);
      if (cell) cells.set(id, cell);
    });
    return cells;
  }, [order, layout]);

  const draw = useRef(() => {});
  const requestDraw = useCallback(() => {
    draw.current();
  }, []);

  // Where a room's tile lives, at a level. `createTileLocator` is the full
  // answer - a url plus a source rect when the level is packed into a shared
  // sheet - which the canvas cache needs to draw sub-rects cheaply.
  // `createUrlFor` is the same lookup narrowed to a bare url (null for a
  // sheet-packed level, which an `<img src>` cannot address), for the catalog
  // and the overlay. Both read the manifest, because it is the scan that
  // discovered which levels the corpus actually has and two readings of that
  // would be two chances to be wrong.
  const locateTile = useMemo(() => createTileLocator(manifest), [manifest]);
  const urlFor = useMemo(() => createUrlFor(manifest), [manifest]);

  const cache = useMemo(() => {
    const tiles = createTileCache({
      locateTile,
      onLoad: () => requestDraw(),
    });
    // The shared tiles are rule 1's floor: pinned and preloaded so every cell has
    // something to draw however little of its own room has arrived. That is now
    // the blank center plus one entry per generic tile - a bounded handful,
    // so pinning them all still fits under the level's budget. They are served
    // flat (level 0), so preload and pin there rather than at the coarsest rung.
    for (const id of [CENTER, ...(manifest.shared?.generic ?? []).map((_, i) => genericId(i))]) {
      tiles.pin(id);
      tiles.request(id, 0);
    }
    return tiles;
  }, [manifest, requestDraw, locateTile]);

  const renderer = useMemo(() => createRenderer({ cache }), [cache]);
  const slideRenderer = useMemo(() => createSlideRenderer({ cache }), [cache]);

  // The rearrangement animation, when one is running.
  //
  // A ref rather than state on purpose: it changes every frame, and the render
  // effect must not be torn down and rebuilt sixty times a second. What it
  // holds is the whole animation - its board, how far through it is, and the
  // camera it was planned for, which is the one the frame must be drawn at
  // however the live camera has been nudged since.
  const anim = useRef(null);

  const resistanceAt = useCallback((x, y) => layout.resistanceAt(x, y), [layout]);

  // The catalog's expanded room: the tile at full size and the whole story.
  // A row is a fixed height and its thumbnail is a thumbnail, so this is how a
  // reader sees either without going back to the map - see `RoomOverlay`.
  const [overlay, setOverlay] = useState(null);
  const expandRoom = useCallback((id, rank) => setOverlay({ id, rank }), []);

  // A reserved book on the center shelf opens this instead of running a
  // search - see useCenterShelf.ts's CENTER_OVERRIDES and onOverride.
  const [helpOpen, setHelpOpen] = useState(false);

  // Right-click or long press opens the room's card. The pick is anchored to
  // where it happened rather than tracking the tile: the card names its room,
  // so a pan underneath it is harmless, and a panel that chases a moving cell
  // would be the more distracting of the two.
  const [card, setCard] = useState(null);
  const onPick = useCallback(
    (px, py, camera) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = { width: canvas.clientWidth, height: canvas.clientHeight };
      const hit = roomAtPoint(px, py, camera, rect, layout, order);
      setCard(hit && { ...hit, at: { x: px, y: py } });
    },
    [layout, order]
  );

  // The card's accessible name and its story text, from the one function that
  // also names a listbox option: `describeCell`. Computed here rather than
  // inside `RoomCard`, because this is where `layout`/`order`/`metadata` are
  // already in scope - the card itself only knows the cell it was opened for.
  const cardDescription = useMemo(
    () => (card ? describeCell(card.x, card.y, { layout, order, metadata }) : null),
    [card, layout, order, metadata]
  );

  // The ranked listbox: every rank the search's gradient actually lifted above
  // the baseline (`gradedCount` - "the size of the cluster", 0 for a uniform
  // map), each named by the same `describeCell` the card uses. This is the
  // LOSSLESS channel accessibility-plan.md §3.2 argues for - position on the
  // map is lossy (rank and certainty, not adjacency), the ranking is not.
  //
  // Windowed to `RESULTS_WINDOW`: `gradedCount` is normally tens of rooms, not
  // thousands, but nothing bounds it against a corpus where it could be. Capped
  // a second way too - only ranks that actually landed a cell (`cellOfRank`)
  // are listed, because there is nowhere to fly a reader to otherwise. Pulling
  // the "rooms on the map" slider down can make that the tighter of the two
  // bounds; either way `total` still reports the true match count via
  // `aria-setsize`, so the list stays honest about what it is not showing.
  //
  // Worth knowing before "fixing" an empty list that looks wrong: at
  // `contentRatio: 1` (the "non-generic" slider maxed) `gradedCount` is ALWAYS
  // 0. It counts ranks the gradient lifts above the baseline, and there is no
  // "above" left once the baseline already is the maximum - every cell already
  // holds a room regardless of match quality, so there is nothing left for a
  // search to cluster. That is the ratio slider's own logic working as
  // designed, not a bug in this list.
  const searchResults = useMemo(() => {
    if (!result) return null;
    const total = Math.min(layout.gradedCount, RESULTS_WINDOW);
    const rooms = [];
    for (let rank = 0; rank < total; rank++) {
      const cell = layout.cellOfRank(rank);
      if (!cell) continue;
      // Blocking can leave `order` shorter than the layout's own slot count -
      // a rank past the end of a filtered order holds no room, generic or
      // otherwise, so it is skipped rather than listed with no id.
      if (order[rank] === undefined) continue;
      rooms.push({
        id: order[rank], rank, x: cell.x, y: cell.y,
        name: describeCell(cell.x, cell.y, { layout, order, metadata }).name,
      });
    }
    return { rooms, total: layout.gradedCount };
  }, [result, layout, order, metadata]);

  // A tap selects a book on the center room. Stable identity - so the pointer
  // listeners are not re-bound every render - over a ref that always holds the
  // latest logic, since the handler closes over `search` and `centreSlots`,
  // which are redefined below and on every render.
  const tapRef = useRef(() => {});
  const onTap = useCallback((px, py, camera) => tapRef.current(px, py, camera), []);

  // `?touchdebug` puts the raw pointer stream on screen. A gesture can only
  // really be judged on a device, and a phone has no console you can read with
  // both thumbs busy - so this is how "what did the browser actually send"
  // stays answerable without a USB cable.
  const onDebug = useMemo(() => (TOUCH_DEBUG ? appendTouchLog : undefined), []);

  // Where the map opens: centered on the center room's bookshelf and zoomed so it
  // fills the display, rather than at a fixed zoom that is too far out on a phone
  // and too far in on a wide monitor. Capped at the tile's NATIVE width so a page
  // never loads already upscaled - a reader can still zoom to the 2x ceiling by
  // hand, and this cap rises once the center tile earns a finer pyramid rung.
  // Computed once at mount from the viewport; a resize afterwards is the reader's
  // camera to move, not ours, so this deliberately does not track window size.
  const opening = useMemo(() => {
    const rect = CENTER_OPENING_RECT;
    const zoom = Math.min(
      BASE_TILE.w,
      fitZoom({
        width: window.innerWidth,
        height: window.innerHeight,
        target: rect,
        aspect: CELL_ASPECT,
        limits: { min: config.camera.minZoom, max: config.camera.maxZoom },
        margin: OPENING_MARGIN,
      })
    );
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, zoom };
    // Intentionally empty deps: the opening view is a one-time mount decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { cam, flyTo, nudgeBy, flightTarget } = useMapCamera({
    canvasRef,
    resistanceAt,
    onChange: requestDraw,
    camera: config.camera,
    opening,
    onPick,
    onTap,
    onDebug,
  });

  // Where the center tile is on screen, and whether each of the two overlays it
  // carries - the live search field and the book buttons - is currently usable
  // there. One computation, because both the render loop (to position and
  // show/hide them) and the panel's search trigger (to decide whether to fly
  // home first) need it and neither should restate the other's notion of
  // "usable".
  //
  // A rearrangement disqualifies both: mid-slide the center tile is drawn from
  // the animation's own board at a camera this function knows nothing about, so
  // an overlay placed from the live camera would sit over the wrong pixels.
  const centreOverlay = useCallback(
    (w, h) => {
      const cellRect = centerCellRect(cam.current, { width: w, height: h });
      const box = searchBoxScreenRect(cellRect);
      const settled = !anim.current;
      return {
        cellRect,
        box,
        usable: settled && overlapsViewport(box, w, h) && isSearchBoxUsable(cellRect),
        // The buttons exist exactly while the titles are legible, so tabbing
        // into the shelf never reaches a book nobody can see named. Off-screen
        // is the other half: a focus ring somewhere past the edge of the
        // display is not a focus ring.
        books: settled && overlapsViewport(cellRect, w, h) && areSpinesLegible(cellRect),
      };
    },
    [cam]
  );

  // The panel's one remaining search affordance: reach the live field on the
  // center tile. If it is already on screen and legible, just focus it -
  // otherwise fly home to the opening view first, the same framing the map
  // loads on, and focus once landed. A dropped flight (the reader grabbed the
  // map mid-flight) leaves the field alone rather than fighting for focus.
  //
  // Defined here, right after its own inputs (`flyTo`, `opening`,
  // `centreOverlay`) exist, rather than down with the rest of the search
  // wiring - `useMapCursor` needs it for `/` and takes it directly. There is
  // no listener-rebind cost to protect against by holding it behind a ref:
  // `onMapKeyDown` is a plain JSX prop, not something an effect re-subscribes
  // when it changes.
  const goToSearch = useCallback(async () => {
    const canvas = canvasRef.current;
    const input = searchFormRef.current?.querySelector('input');
    if (!canvas || !input) return;
    if (centreOverlay(canvas.clientWidth, canvas.clientHeight).usable) {
      input.focus();
      return;
    }
    // flyTo always routes through cameraAtCell, which adds +0.5 to aim at a
    // cell's MIDDLE - every other caller flies to a whole cell by its corner
    // index. `opening` is already a raw camera target, not a cell index (see
    // useMapCamera's mount-time use of it, unmodified), so that offset has to
    // be cancelled here or the flight lands half a cell short on each axis.
    //
    // `opening.zoom` alone is not enough: it fits the shelf+box UNION to the
    // viewport, and on a narrow/portrait screen that fit binds on the wide
    // shelf, landing a zoom where the box itself - gated on height, not
    // width - is still under its usable minimum. Floor the landing zoom at
    // what the box alone needs so this flight actually reaches a usable field.
    const zoom = Math.max(opening.zoom, minZoomForSearchBox());
    const landed = await flyTo(opening.x - 0.5, opening.y - 0.5, zoom);
    if (landed) input.focus();
  }, [flyTo, opening, centreOverlay]);

  // --- the keyboard cursor ---------------------------------------------------
  //
  // Everything about it - the cell, what gets said, and every key - is
  // `useMapCursor`. It is derived from the camera rather than tracked beside
  // it, so it goes in after `useMapCamera` and takes that hook's movers.
  const { cursorLabel, cursorEntry, cursorDesc, onMapKeyDown, announceArrangement, keyboardUsed } =
    useMapCursor({
      layout,
      order,
      metadata,
      cam,
      canvasRef,
      flyTo,
      nudgeBy,
      flightTarget,
      camera: config.camera,
      setStatus,
      requestDraw,
      onOpenCard: setCard,
      goToSearch,
    });

  // --- switching between the two readings ----------------------------------
  //
  // The map is hidden rather than unmounted, so neither direction rebuilds
  // anything: the camera is exactly where it was left, the tile cache is
  // warm, and `useMapCamera`'s pointer listeners - bound once against a ref
  // object rather than an element - are still attached to a canvas that
  // never went away. See `useModeTransition.ts` for the FLIP itself.
  const { mode, leaving, enterCatalog, exitCatalog, firstTileRef } = useModeTransition({
    canvasRef,
    cam,
    catalogConfig: config.catalog,
    onModeChange: useCallback(() => setCard(null), []),
    initialMode: INITIAL_MODE,
  });

  // Cleared rather than emptied one at a time - see the shelf's "forget
  // searches" book. Defined here, ahead of `useCenterShelf` just below, which
  // is the only thing that runs it.
  const forgetSearches = useCallback(() => setHistory([]), []);

  // The center room's bookshelf. Called here rather than earlier in the file
  // because two of the four actions a book can run - `enterCatalog` (just
  // above) and `search` (from `useSearch`, already in scope) - have to exist
  // first; `centreSlots` has no reader of its own until `useMapRenderer`
  // just below, so nothing is lost by waiting this long to call it.
  const { centreSlots, bookFocus, setBookFocus, onBook, onBooksKeyDown } = useCenterShelf({
    metadata,
    slotSeed: config.map.slotSeed,
    history,
    booksRef,
    setQuery,
    search,
    enterCatalog,
    setHelpOpen,
    forgetSearches,
  });

  // --- rendering -----------------------------------------------------------
  //
  // The frame loop itself is `useMapRenderer.ts`. `draw` stays here because the
  // tile cache above is built with `onLoad: requestDraw`, so the request has to
  // exist before the hook that fulfils it - one ref, and the cycle is broken.
  useMapRenderer({
    canvasRef, searchFormRef, booksRef, searchArrowRef, draw, anim, keyboardUsed, cam, mode,
    layout, order, renderer, slideRenderer, cache, centreSlots, centreOverlay, blockedCount,
  });

  // --- the rearrangement animation -----------------------------------------
  //
  // Everything about it - whether a layout/order change animates, what plays
  // out on screen while it does, and what gets said once it lands - is
  // `useRearrangement`. `announce` is the one thing it cannot own: which
  // voice speaks for a change is a fact about which reading is on screen, and
  // that lives here, not in the hook. The catalog has no map to rearrange, so
  // it says what happened in its own voice instead - the arrangement sentence
  // talks about clustering near a center that reading does not have.
  const announce = useCallback(
    (note) => {
      if (mode !== 'map') {
        setStatus(describeCatalog({ total: order.length, query: result?.term ?? '', note }));
        return;
      }
      announceArrangement(note);
    },
    [mode, order, result, setStatus, announceArrangement]
  );

  // `useSearch`'s `search()` needs `requestAnimation`, but `useRearrangement`
  // needs `announce`, which needs `useSearch`'s own `result` (by way of
  // `layout`/`order`) - a genuine cycle, not just an ordering accident, so
  // `requestAnimationRef` (filled in below) is the one forward reference left
  // in this file that reordering cannot remove.
  const { requestAnimation } = useRearrangement({
    layout,
    order,
    mode,
    canvasRef,
    searchFormRef,
    cam,
    flyTo,
    requestDraw,
    config,
    anim,
    announce,
  });
  requestAnimationRef.current = requestAnimation;

  // A chip on the card is a live search: reading a room becomes a way of moving
  // through the library rather than a dead end. The card closes because the map
  // is about to rearrange under it, and it would be describing a cell that no
  // longer holds that room.
  const searchKeyword = (text) => {
    setQuery(text);
    setCard(null);
    // The overlay names a rank, and a search rebuilds the ranking - leaving it
    // open would have it describing a position that now holds another room.
    setOverlay(null);
    search(text);
  };

  // Choosing a result in the ranked list (below) moves the camera AND opens
  // the room's card, in that order but not waiting on one another. The card is
  // an independent DOM dialog with its own position, so its content is
  // reachable the instant this runs regardless of whether - or how fast - the
  // camera arrives; the flight is for the sighted reader's continuity, not a
  // precondition for anyone else's access. This is the touch/VoiceOver path
  // into a room's content that right-click and long-press never gave them.
  const openRoom = useCallback(
    (x, y, id, rank) => {
      const canvas = canvasRef.current;
      const at = canvas
        ? { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }
        : { x: 0, y: 0 };
      setCard({ id, rank, x, y, at });
      flyTo(x, y, config.camera.defaultZoom);
    },
    [flyTo, config]
  );

  // The catalog's own scroll position - not part of the mode transition, so
  // it stays here rather than moving into `useModeTransition`.
  const catalogScrollRef = useRef(null);

  /** A row's "show on the map" - aim the camera, then go and look. */
  const showOnMap = useCallback(
    (x, y) => {
      flyTo(x, y, config.camera.defaultZoom);
      exitCatalog();
    },
    [flyTo, config, exitCatalog]
  );

  // The panel's three map controls, as handlers rather than as inline bodies in
  // the markup: "a reorder" is bumping a seed AND asking for the next layout
  // change to animate, which is a fact about this file's machinery and not
  // something a presenter should have to know.
  const reorder = useCallback(() => {
    requestAnimation('');
    setOrderSeed((s) => s + 1);
  }, [requestAnimation]);
  const rescatter = useCallback(() => {
    requestAnimation('');
    setSeed((s) => s + 1);
  }, [requestAnimation]);
  const recentre = useCallback(
    () => flyTo(0, 0, config.camera.defaultZoom),
    [flyTo, config]
  );

  // Selecting a book on the center room. Off the center cell or on an empty
  // book, nothing happens - the tap is not otherwise claimed.
  tapRef.current = (px, py, camera) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = { width: canvas.clientWidth, height: canvas.clientHeight };
    const cell = centerCellRect(camera, rect);

    // A tap on the live search field focuses it - checked before the books,
    // since the box sits above the shelf and never overlaps one. Routing
    // through `onTap` rather than the field's own pointer events is what lets
    // a real click activate it while a pan or pinch that merely crosses its
    // screen rect keeps doing what it was doing: `onTap` only ever fires for
    // a genuine tap in the first place.
    if (searchBoxAtPoint(px, py, cell)) {
      searchFormRef.current?.querySelector('input')?.focus();
      return;
    }

    const slotIndex = bookAtPoint(px, py, cell);
    if (slotIndex != null) onBook(slotIndex);
  };

  return (
    <>
      <MapView
        mode={mode}
        canvasRef={canvasRef}
        searchFormRef={searchFormRef}
        booksRef={booksRef}
        searchArrowRef={searchArrowRef}
        manifest={manifest}
        total={total}
        described={described}
        status={status}
        query={query}
        setQuery={setQuery}
        onSearch={runSearch}
        onClearSearch={clearSearch}
        onGoToSearch={goToSearch}
        maxQueryLength={config.search.maxQueryLength}
        cursorLabel={cursorLabel}
        cursorEntry={cursorEntry}
        cursorDesc={cursorDesc}
        highlight={highlight}
        tagLinks={tagLinks}
        onMapKeyDown={onMapKeyDown}
        onKeyword={searchKeyword}
        centreSlots={centreSlots}
        bookFocus={bookFocus}
        setBookFocus={setBookFocus}
        onBook={onBook}
        onBooksKeyDown={onBooksKeyDown}
        searchResults={searchResults}
        onOpenRoom={openRoom}
        roomCount={roomCount}
        setRoomCount={setRoomCount}
        contentRatio={contentRatio}
        setContentRatio={setContentRatio}
        onReorder={reorder}
        onRescatter={rescatter}
        onRecentre={recentre}
        history={history}
        onForgetSearches={forgetSearches}
        onEnterCatalog={enterCatalog}
      />

      {(mode === 'catalog' || leaving) && (
        <CatalogView
          manifest={manifest}
          config={config}
          urlFor={urlFor}
          order={catalogOrder}
          metadata={metadata}
          result={result}
          highlight={highlight}
          tagLinks={tagLinks}
          query={query}
          setQuery={setQuery}
          onSearch={runSearch}
          onClearSearch={clearSearch}
          paging={paging}
          setPaging={setPaging}
          onExit={exitCatalog}
          onShowOnMap={showOnMap}
          onKeyword={searchKeyword}
          onExpand={expandRoom}
          centreSlots={centreSlots}
          onBook={onBook}
          cellOfId={(id) => cellById.get(id) ?? null}
          history={history}
          onForgetSearches={forgetSearches}
          note={
            result
              ? describeSignals(result.signals ?? { clip: false, keyword: false, story: false }, Boolean(searchIndex))
              : ''
          }
          scrollRef={catalogScrollRef}
          firstTileRef={firstTileRef}
          leaving={leaving}
        />
      )}

      {/*
        ONE live region for the whole app, and it lives out here rather than in
        the panel for a structural reason: the panel is part of the map, so a
        region inside it would be unmounted and remounted on every mode switch,
        and a screen reader loses a live region that goes away. What it says
        differs by mode - a cursor move, or what the catalog is showing - but
        the node a reader is listening to never changes.

        `role="status"` announces every change to its subtree, so nothing else
        may share it; the map's static hint stays in the panel where it cannot
        be read aloud on every update.
      */}
      <div className="live">
        <span role="status">{status}</span>
      </div>

      {overlay && mode === 'catalog' && (
        <RoomOverlay
          room={overlay}
          desc={describeRoom(
            overlay.id,
            overlay.rank,
            order.length,
            metadata?.[overlay.id] ?? null
          )}
          entry={metadata?.[overlay.id] ?? null}
          file={manifest.rooms[overlay.id]?.file}
          src={urlFor(overlay.id, 0)}
          onClose={() => setOverlay(null)}
          onKeyword={searchKeyword}
          highlight={highlight}
          tagLinks={tagLinks}
          result={result}
          weights={config.search.weights}
        />
      )}

      {helpOpen && (
        <HelpDialog
          onClose={() => setHelpOpen(false)}
          availableTags={availableTags}
          blockedTags={blockedTags}
          onToggleTag={toggleBlockedTag}
          blockedCount={blockedCount}
        />
      )}

      {card && cardDescription && (
        <RoomCard
          card={card}
          desc={cardDescription}
          entry={metadata?.[card.id] ?? null}
          file={manifest.rooms[card.id]?.file}
          onClose={() => setCard(null)}
          onKeyword={searchKeyword}
          highlight={highlight}
          tagLinks={tagLinks}
          result={result}
          weights={config.search.weights}
        />
      )}
    </>
  );
}

/**
 * The most options the ranked listbox mounts at once - the DOM budget from
 * accessibility-plan.md §4.2b. `gradedCount` is normally tens of rooms, not
 * thousands, so this rarely bites; it exists for the corpus where it would.
 */
const RESULTS_WINDOW = 50;

/**
 * How much of the binding axis the opening view fills - a hair under 1 so the
 * bookshelf clears the screen edges rather than bleeding off them. A by-feel
 * number, like the chrome thresholds: nothing derives from it and no test pins
 * its value.
 */
const OPENING_MARGIN = 0.94;

/**
 * Which reading the page opens on.
 *
 * `?catalog` in the url opens straight into the list, read once at module scope
 * exactly as `?touchdebug` is. Read-only on purpose: the toggle does not write
 * the url back, so there is no history-entry behaviour to design and no way for
 * the address bar and the page to disagree. It makes the mode linkable, and it
 * lets a test land in the catalog without a click.
 */
const INITIAL_MODE =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('catalog')
    ? 'catalog'
    : 'map';

/**
 * `?blockTags=a,b,c` - sensitive-content tags to exclude from the map and
 * catalog, read once at module scope exactly as `INITIAL_MODE` is. This only
 * ever SEEDS the stored choice (`KEYS.blockedTags`, below): a reader who has
 * already picked tags in HelpDialog's panel keeps that choice on their next
 * visit rather than having a stale link silently override it, but a fresh
 * browser following a shared link starts blocked as the link asks.
 */
const URL_BLOCKED_TAGS =
  (typeof location !== 'undefined' ? new URLSearchParams(location.search).get('blockTags') : null)
    ?.split(',')
    .map((t) => t.trim())
    .filter(Boolean) ?? [];


/**
 * `?` - the screen-reader equivalent of peripheral vision
 * (accessibility-plan.md §4.2a): what a sighted reader gets for free by
 * glancing at the screen, on request rather than on every move, because
 * "verbose by default" is the classic live-region mistake.
 *
 * Sentence construction over already-tested primitives (`nextRoom`,
 * `cellDistance`) rather than a new pure module of its own - the same kind of
 * job `describeSignals` (useSearch.ts) does for a search. Simplified from the
 * plan's own example on purpose: four cardinal directions via straight-line
 * `nextRoom` walks, not eight - a true diagonal nearest-room search is more
 * geometry than a `?` press needs to earn its keep.
 */

createRoot(document.getElementById('root')).render(<App />);
