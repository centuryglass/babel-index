import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createLayout, shuffledOrder } from '../../map/ordering.js';
import {
  rankHybrid,
  fold,
  tokenise,
  keywordMatchRanges,
  storyMatchRanges,
} from '../../map/scoring.js';
import { RoomCard } from './RoomCard.jsx';
import { MapView } from './MapView.jsx';
import { CatalogView } from './CatalogView.jsx';
import { RoomOverlay } from './RoomOverlay.jsx';
import { HelpDialog } from './HelpDialog.jsx';
import { alphabeticalOrder } from './catalog.js';
import { load, save, clear, KEYS } from './persist.js';
import { TOUCH_DEBUG, appendTouchLog } from './touchDebug.js';
import { roomAtPoint } from './picking.js';
import { describeCell, describeRoom, describeCatalog } from '../../map/describe.js';
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
} from './center.js';
import { CELL_ASPECT, fitZoom } from './camera.js';
import { createTileCache, CENTER, genericId } from './tiles.js';
import { createUrlFor } from './rooms.js';
import { createRenderer } from './render.js';
import { createSlideRenderer } from './slide.js';
import { BASE_TILE } from './pyramid.js';
import { useMapCamera } from './useMapCamera.js';
import { useMapRenderer } from './useMapRenderer.js';
import { useMapCursor } from './useMapCursor.js';
import { useCenterShelf } from './useCenterShelf.js';
import { useModeTransition } from './useModeTransition.js';
import { useCorpus } from './useCorpus.js';
import { useRearrangement } from './useRearrangement.js';

function App() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/manifest')
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
  // One piece of state, not two: the ranking and its certainty profile describe
  // the same search, and a frame that paired one search's order with another's
  // densities would put the wrong rooms in the cluster.
  const [result, setResult] = useState(null);
  const [query, setQuery] = useState('');
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

  // Everything the corpus IS - the sidecar, the embedding blob, the search
  // index built over them. See useCorpus.js.
  const { metadata, embeddings, searchIndex, described } = useCorpus(manifest);

  // `search`, `enterCatalog`, `setHelpOpen` and `forgetSearches` - the actions
  // a book on the shelf can run - are declared much further down this file, so
  // `useCenterShelf` (called next, ahead of all of them) cannot take them
  // directly: it has to run early enough that `centreSlots` is ready before
  // `useMapRenderer` reads it below. This ref is the same forward-reference
  // trick `useMapCursor`'s `goToSearchRef` uses; `main.jsx` fills it in once
  // everything it points to actually exists (see the assignment near
  // `forgetSearches`), and every book press from then on reads the live
  // functions rather than a closure captured before they were.
  const shelfActionsRef = useRef({});

  const { centreSlots, bookFocus, setBookFocus, onBook, onBooksKeyDown } = useCenterShelf({
    metadata,
    slotSeed: config.map.slotSeed,
    history,
    booksRef,
    setQuery,
    actionsRef: shelfActionsRef,
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
    if (result) return result.order;
    return shuffledOrder(total, orderSeed);
  }, [total, orderSeed, result]);

  // The catalog's own order: a shuffle is not a list order anyone can read by
  // eye, so its idle default is alphabetical rather than a second read of the
  // map's random `order`. The two only agree while a search is running -
  // `result.order` is the one array both views take a rank from - which is
  // why a search and a clear are the only things that can move a room's
  // catalog row, exactly as they are the only things that move it on the map.
  const catalogOrder = useMemo(() => {
    if (result) return result.order;
    return alphabeticalOrder(manifest.rooms);
  }, [manifest, result]);

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

  // The cache asks `urlFor` where a level of a room lives; the manifest is the
  // only thing that knows, because it is the scan that discovered which levels
  // the corpus actually has.
  // Where a room's tile lives, at a level. The canvas cache asks it for tiles
  // to draw; the catalog puts the same answer in an `<img src>`. One resolver,
  // because the manifest is the only thing that knows which levels the corpus
  // actually has and two readings of that would be two chances to be wrong.
  const urlFor = useMemo(() => createUrlFor(manifest), [manifest]);

  const cache = useMemo(() => {
    const tiles = createTileCache({
      urlFor,
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
  }, [manifest, requestDraw, urlFor]);

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
  // Which search is the newest one asked for. `search` awaits the server, and
  // nothing stops a second query being submitted while the first is still in
  // the air - a book on the shelf is one click, and the first request of a
  // session pays for loading the CLIP text tower - so without this the slow
  // early query resolves last and wins, leaving the map ranked by a term the
  // reader has already moved on from. Every write a search makes is gated on
  // still being the newest, so a superseded one lands nowhere.
  const searchSeq = useRef(0);

  const resistanceAt = useCallback((x, y) => layout.resistanceAt(x, y), [layout]);

  // The catalog's expanded room: the tile at full size and the whole story.
  // A row is a fixed height and its thumbnail is a thumbnail, so this is how a
  // reader sees either without going back to the map - see `RoomOverlay`.
  const [overlay, setOverlay] = useState(null);
  const expandRoom = useCallback((id, rank) => setOverlay({ id, rank }), []);

  // A reserved book on the center shelf opens this instead of running a
  // search - see useCenterShelf.js's CENTER_OVERRIDES and onOverride.
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
      rooms.push({
        id: order[rank], rank, x: cell.x, y: cell.y,
        name: describeCell(cell.x, cell.y, { layout, order, metadata }).name,
      });
    }
    return { rooms, total: layout.gradedCount };
  }, [result, layout, order, metadata]);

  // The two range finders, bound to the query the CURRENT ranking is for.
  //
  // Bound rather than called with the query at each site: every consumer would
  // otherwise have to remember which of the two rules applies to the text it is
  // holding, and the whole point of `scoring.js` owning them is that the answer
  // is decided once. A keyword matches by substring, a story word by prefix;
  // handing out two functions named for the thing they mark keeps that from
  // being a decision anyone makes twice.
  //
  // Null with no search, which every consumer reads as "mark nothing".
  const highlight = useMemo(() => {
    const term = result?.term?.trim();
    if (!term) return null;
    const foldedQuery = fold(term);
    const tokens = tokenise(term, { minLength: config.search.minTokenLength });
    if (!foldedQuery && !tokens.length) return null;
    return {
      keyword: (text) => keywordMatchRanges(text, foldedQuery, tokens),
      story: (text) => storyMatchRanges(text, tokens),
    };
  }, [result, config]);

  // A tap selects a book on the center room. Stable identity - so the pointer
  // listeners are not re-bound every render - over a ref that always holds the
  // latest logic, since the handler closes over `search` and `centreSlots`,
  // which are redefined below and on every render.
  const tapRef = useRef(() => {});

  // `/` (below) needs `goToSearch`, which is declared further down and closes
  // over state that changes often - the same "stable identity over a ref that
  // always holds the latest logic" as `tapRef`, and for the same reason: the
  // map's keyboard handler must not itself be rebuilt every time `goToSearch`
  // is.
  const goToSearchRef = useRef(() => {});
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
      goToSearchRef,
    });

  // --- switching between the two readings ----------------------------------
  //
  // The map is hidden rather than unmounted, so neither direction rebuilds
  // anything: the camera is exactly where it was left, the tile cache is
  // warm, and `useMapCamera`'s pointer listeners - bound once against a ref
  // object rather than an element - are still attached to a canvas that
  // never went away. See `useModeTransition.js` for the FLIP itself.
  const { mode, leaving, enterCatalog, exitCatalog, firstTileRef } = useModeTransition({
    canvasRef,
    cam,
    catalogConfig: config.catalog,
    onModeChange: useCallback(() => setCard(null), []),
    initialMode: INITIAL_MODE,
  });

  // --- rendering -----------------------------------------------------------
  //
  // The frame loop itself is `useMapRenderer.js`. `draw` stays here because the
  // tile cache above is built with `onLoad: requestDraw`, so the request has to
  // exist before the hook that fulfils it - one ref, and the cycle is broken.
  useMapRenderer({
    canvasRef, searchFormRef, booksRef, searchArrowRef, draw, anim, keyboardUsed, cam, mode,
    layout, order, renderer, slideRenderer, cache, centreSlots, centreOverlay,
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

  // --- search --------------------------------------------------------------
  //
  // Every query passes through here, whether it came from the box, a keyword
  // chip, a book on the shelf or a catalog row - so this is the one place the
  // length cap has to hold. Scoring is O(tokens x keywords) per room, and a
  // pasted tag list against a full corpus is tens of millions of substring
  // tests on the main thread, which does not degrade, it stops. The input has a
  // `maxLength` too, but that only covers typing: a chip, a book and a restored
  // history entry all reach this without touching the box.
  const search = async (rawTerm) => {
    const term = String(rawTerm ?? '').slice(0, config.search.maxQueryLength);
    // Claiming the sequence is what makes this the current search, and it is
    // done before the first await so that a clear - which needs none of what
    // follows - still supersedes a query in flight.
    const seq = ++searchSeq.current;
    if (!term.trim()) {
      // Both branches rearrange the library - clearing the box restores the
      // uniform map, which is as much a rearrangement as finding something is.
      requestAnimation('');
      setResult(null);
      return;
    }
    // A real search is a history entry, and the frontmost book from now on. Done
    // before the fetch, so a click on that book is remembered even if the
    // ranking that follows is a stub.
    pushHistory(term.trim());

    let res;
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
      // fetch only rejects on a network failure; a 500 arrives as an ordinary
      // response whose body is not the JSON this expects.
      if (!response.ok) throw new Error(`the library answered ${response.status}`);
      res = await response.json();
    } catch (e) {
      if (seq !== searchSeq.current) return;
      // Nothing rearranged - no `requestAnimation` was ever made for this
      // search - so this is the one path that has to write the live region
      // itself.
      setStatus(`the search could not be run - ${e.message}. The library is unchanged.`);
      return;
    }
    // Past here the reply is this search's to act on, and a newer query has
    // already claimed the map.
    if (seq !== searchSeq.current) return;

    // Three signals, blended into one sort over the whole corpus. Any of them
    // may be missing - no blob, no metadata - and a ranking from the rest is
    // still a real ranking, so the only case that needs the server's stub is
    // having neither. The note says which of the three it actually was, rather
    // than implying more than the corpus can support.
    const blob = res.vector ? embeddings.current : null;
    if (blob || searchIndex) {
      const { order, certainty, breakdown, signals } = rankHybrid({
        query: term,
        count: total,
        weights: config.search.weights,
        minTokenLength: config.search.minTokenLength,
        embeddings: blob?.data,
        dim: blob?.dim,
        vector: res.vector,
        index: searchIndex,
        clipCertainty: { low: config.search.density.clipLow, high: config.search.density.clipHigh },
      });
      requestAnimation(describeSignals(signals, Boolean(searchIndex)));
      // `term`, not the live `query`: the box changes on every keystroke and
      // the ranking does not, so anything derived from "what was searched for"
      // - the highlight ranges especially - has to read the submitted term or
      // it would mark text against a query nobody has run yet.
      setResult({ order, certainty, breakdown, signals, term });
    } else {
      // The stub ranking is a hash, so it is not certain of anything and must
      // not pretend to be: no profile, and the map stays evenly scattered.
      requestAnimation('stub ranking — no embeddings and no keywords in this corpus');
      // No breakdown: a hash-ordered stub has no signals to explain, and an
      // explanation of a ranking nothing decided would be an invented one.
      setResult({ order: res.order, certainty: null, breakdown: null, signals: null, term });
    }
  };

  const runSearch = (e) => {
    e.preventDefault();
    search(query);
  };

  // The clear-x: not just an empty submit, because setQuery is async state -
  // calling search('') directly rather than search(query) after setQuery('')
  // means it does not race the render that clears the box.
  const clearSearch = () => {
    setQuery('');
    search('');
  };

  // The panel's one remaining search affordance: reach the live field on the
  // center tile. If it is already on screen and legible, just focus it -
  // otherwise fly home to the opening view first, the same framing the map
  // loads on, and focus once landed. A dropped flight (the reader grabbed the
  // map mid-flight) leaves the field alone rather than fighting for focus.
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
    const landed = await flyTo(opening.x - 0.5, opening.y - 0.5, opening.zoom);
    if (landed) input.focus();
  }, [flyTo, opening, centreOverlay]);
  goToSearchRef.current = goToSearch;

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
  const forgetSearches = useCallback(() => setHistory([]), []);

  // `useCenterShelf` was called before any of these four existed - see the
  // comment on `shelfActionsRef` above. Now that they do, every book press
  // reads them through here rather than through a closure that would have
  // been stale from the moment it was captured.
  shelfActionsRef.current = { search, enterCatalog, setHelpOpen, forgetSearches };

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
          note={result ? describeSignals(result.signals ?? {}, Boolean(searchIndex)) : ''}
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
          result={result}
          weights={config.search.weights}
        />
      )}

      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}

      {card && cardDescription && (
        <RoomCard
          card={card}
          desc={cardDescription}
          entry={metadata?.[card.id] ?? null}
          file={manifest.rooms[card.id]?.file}
          onClose={() => setCard(null)}
          onKeyword={searchKeyword}
          highlight={highlight}
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
 * What actually decided this ranking, in the panel's own voice.
 *
 * `signals` reports which of the three found anything for this query, not which
 * were available - a corpus full of keywords that none of them matched should
 * not claim the ranking was keyword-driven.
 */
/**
 * `?` - the screen-reader equivalent of peripheral vision
 * (accessibility-plan.md §4.2a): what a sighted reader gets for free by
 * glancing at the screen, on request rather than on every move, because
 * "verbose by default" is the classic live-region mistake.
 *
 * Sentence construction over already-tested primitives (`nextRoom`,
 * `cellDistance`) rather than a new pure module of its own - the same kind of
 * job `describeSignals` above does for a search. Simplified from the plan's
 * own example on purpose: four cardinal directions via straight-line
 * `nextRoom` walks, not eight - a true diagonal nearest-room search is more
 * geometry than a `?` press needs to earn its keep.
 */

function describeSignals({ clip, keyword, story }, hasText) {
  const hits = [keyword && 'keywords', story && 'story', clip && 'CLIP'].filter(Boolean);
  // Nothing matched and no CLIP means every score is zero, so the sort falls
  // back to index order - which is a real rearrangement, not a no-op, and
  // saying "unchanged" while the map visibly moves would be the wrong lie.
  if (!hits.length) return hasText ? 'nothing matched — showing index order' : '';
  // CLIP alone is the ordinary case for most queries and needs no announcement.
  if (hits.length === 1 && clip) return '';
  return `ranked by ${hits.join(' + ')}`;
}

createRoot(document.getElementById('root')).render(<App />);
