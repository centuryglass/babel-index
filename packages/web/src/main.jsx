import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createLayout, shuffledOrder, cellDistance } from '../../map/ordering.js';
import { joinMetadata } from '../../map/metadata.js';
import {
  buildSearchIndex,
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
import { flipTransform, flipCss, rectOf } from './catalog.js';
import { load, save, clear, KEYS } from './persist.js';
import { TOUCH_DEBUG, appendTouchLog } from './touchDebug.js';
import { buildRearrangement } from '../../map/board.js';
import { planMoves, applyMove } from '../../map/illusion.js';
import { roomAtPoint } from './picking.js';
import { describeCell, describeRoom, describeArrangement, describeCatalog } from '../../map/describe.js';
import { nextRoom } from '../../map/nextRoom.js';
import {
  assignTitles,
  pickTags,
  bookAtPoint,
  bookNeighbour,
  centreCellRect,
  searchBoxScreenRect,
  isSearchBoxUsable,
  searchBoxAtPoint,
  areSpinesLegible,
  overlapsViewport,
  BOOK_COUNT,
  HISTORY_SLOT_COUNT,
  CENTRE_OPENING_RECT,
} from './centre.js';
import { CELL_ASPECT, pxPerCell, fitZoom, cursorCell, pickGranularity } from './camera.js';
import { createTileCache, CENTRE, variantId } from './tiles.js';
import { createUrlFor } from './rooms.js';
import { createRenderer } from './render.js';
import { createSlideshow, createSlideRenderer } from './slide.js';
import { BASE_TILE } from './pyramid.js';
import { useMapCamera, prefersReducedMotion } from './useMapCamera.js';
import { useMapRenderer } from './useMapRenderer.js';

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
  // The live search field lives on the centre tile, not in the panel; its
  // position is driven imperatively from the render loop below, the same way
  // the canvas itself is - see `positionSearchBox`.
  const searchFormRef = useRef(null);
  // The book buttons' container - one absolutely-positioned box matching the
  // centre cell, positioned imperatively from the render loop exactly as the
  // search field is. The forty buttons inside it are laid out in percentages,
  // so this is the only per-frame geometry the shelf costs.
  const booksRef = useRef(null);
  const total = manifest.count;

  // Every by-feel starting value comes from the manifest's config block rather
  // than from a literal here - see packages/config. The sliders still move
  // freely afterwards; config decides where they start.
  const config = manifest.config;

  // Which reading of the corpus is on screen. The map is never unmounted - it
  // is hidden and its render loop stops - so switching carries no state and
  // nothing has to be rebuilt on the way back. See `docs/catalog-plan.md` §2.
  const [mode, setMode] = useState(INITIAL_MODE);
  // Mounted through the exit animation, so the catalog can fold back into the
  // centre tile rather than vanishing. Cleared when the animation lands.
  const [leaving, setLeaving] = useState(false);

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
  const [metadata, setMetadata] = useState(null);
  // Search history, newest first, one book per entry - and one of the two
  // things in this app that survives a reload (see `persist.js` for why so few
  // do). It is not only a convenience: this is what titles the centre room's
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

  // The embedding blob, fetched once if the corpus has one. Ranking is a few
  // million int8 multiply-adds against it (rankByEmbedding), well under a frame,
  // so a search - and every re-rank off the same vector - stays on the client.
  const embeddings = useRef(null);
  useEffect(() => {
    if (!manifest.embeddings) return;
    let cancelled = false;
    fetch(manifest.embeddings.url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (!cancelled) embeddings.current = { data: new Int8Array(buf), dim: manifest.embeddings.dim };
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [manifest]);

  // The keyword/story sidecar, fetched alongside the blob rather than inlined
  // into the manifest: at a full corpus it is megabytes, and the manifest is on
  // the path to the first frame. Joined by filename into an array indexed by
  // room id, which is what search and the overlay will both want.
  useEffect(() => {
    if (!manifest.metadata) return;
    let cancelled = false;
    fetch(manifest.metadata.url)
      .then((r) => r.json())
      .then((sidecar) => {
        if (!cancelled) setMetadata(joinMetadata(manifest.rooms, sidecar));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [manifest]);

  const described = useMemo(() => metadata?.filter(Boolean).length ?? 0, [metadata]);

  // Folded and tokenised once, so a search is set lookups rather than a
  // megabyte of string work.
  const searchIndex = useMemo(() => (metadata ? buildSearchIndex(metadata) : null), [metadata]);

  // The centre room's book titles. Every book shows a stable random corpus
  // keyword until history reaches it: past searches fill the wall newest first,
  // top left to bottom right. Reserved override books are never overwritten.
  // `assignTitles` is pure, so this is a memo, not per-frame work.
  const tags = useMemo(() => pickTags(metadata, config.map.slotSeed), [metadata, config]);
  const centreSlots = useMemo(
    () => assignTitles({ history, tags, overrides: CENTRE_OVERRIDES }),
    [history, tags]
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

  // Both of these are runtime parameters: changing either re-derives the
  // layout without touching a single byte of downloaded image data.
  //
  // The cell aspect goes in so the library is round on screen rather than round
  // in the index - the edge should be the same distance away whichever way you
  // drag, and with a non-square cell those are not the same thing.
  //
  // The search's certainty profile rides in as `density`, which is what makes
  // the matches cluster toward the centre rather than scatter at the slider's
  // ratio. No search means no profile, and no profile means the uniform map -
  // so clearing the box restores it exactly, without a second code path.
  // How many wallpaper variants the corpus shipped, and the seed that scatters
  // them. Both are positional and order-independent, so they never change under
  // a search or a reorder - which is why the rearrangement can treat every
  // generic cell as one interchangeable value.
  const variantCount = manifest.base?.variants?.length ?? 0;
  const variantSeed = config.map.genericVariantSeed;

  const layout = useMemo(
    () =>
      createLayout({
        roomCount: Math.min(roomCount, total),
        contentRatio,
        seed,
        aspect: CELL_ASPECT,
        variantCount,
        variantSeed,
        density: result?.certainty
          ? { ...config.search.density, certainty: result.certainty }
          : null,
      }),
    [roomCount, contentRatio, seed, total, result, config, variantCount, variantSeed]
  );

  const order = useMemo(() => {
    // A search ranks the whole corpus; the layout takes as many as it has slots.
    if (result) return result.order;
    return shuffledOrder(total, orderSeed);
  }, [total, orderSeed, result]);

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
    // The base tiles are rule 1's floor: pinned and preloaded so every cell has
    // something to draw however little of its own room has arrived. That is now
    // the blank centre plus one entry per wallpaper variant - a bounded handful,
    // so pinning them all still fits under the level's budget. They are served
    // flat (level 0), so preload and pin there rather than at the coarsest rung.
    for (const id of [CENTRE, ...(manifest.base?.variants ?? []).map((_, i) => variantId(i))]) {
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
  // Set by the two controls that mean "rearrange the library", and consumed by
  // the effect below. Slider drags change the layout too, and must not animate.
  const animateNext = useRef(false);
  const arrangement = useRef(null);
  // What brought the next rearrangement about, in the search's own voice -
  // handed to the announcement below rather than pushed into the live region
  // where it is decided. A search resolves, the map rearranges, and the reader
  // hears ONE sentence about both; two writes a few hundred milliseconds apart
  // would be two interruptions describing one event.
  const pendingNote = useRef('');

  const resistanceAt = useCallback((x, y) => layout.resistanceAt(x, y), [layout]);

  // The catalog's expanded room: the tile at full size and the whole story.
  // A row is a fixed height and its thumbnail is a thumbnail, so this is how a
  // reader sees either without going back to the map - see `RoomOverlay`.
  const [overlay, setOverlay] = useState(null);
  const expandRoom = useCallback((id, rank) => setOverlay({ id, rank }), []);

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

  // A tap selects a book on the centre room. Stable identity - so the pointer
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

  // Where the map opens: centred on the centre room's bookshelf and zoomed so it
  // fills the display, rather than at a fixed zoom that is too far out on a phone
  // and too far in on a wide monitor. Capped at the tile's NATIVE width so a page
  // never loads already upscaled - a reader can still zoom to the 2x ceiling by
  // hand, and this cap rises once the centre tile earns a finer pyramid rung.
  // Computed once at mount from the viewport; a resize afterwards is the reader's
  // camera to move, not ours, so this deliberately does not track window size.
  const opening = useMemo(() => {
    const rect = CENTRE_OPENING_RECT;
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

  // Where the centre tile is on screen, and whether each of the two overlays it
  // carries - the live search field and the book buttons - is currently usable
  // there. One computation, because both the render loop (to position and
  // show/hide them) and the panel's search trigger (to decide whether to fly
  // home first) need it and neither should restate the other's notion of
  // "usable".
  //
  // A rearrangement disqualifies both: mid-slide the centre tile is drawn from
  // the animation's own board at a camera this function knows nothing about, so
  // an overlay placed from the live camera would sit over the wrong pixels.
  const centreOverlay = useCallback(
    (w, h) => {
      const cellRect = centreCellRect(cam.current, { width: w, height: h });
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
  // The cell under the camera centre (accessibility-plan.md §4.2), and
  // DERIVED rather than separately tracked - that definition is the whole
  // design, so anything that moves the camera moves the cursor with it and
  // there is no second copy that can drift out of step. That includes the
  // edge's own glide easing back after a keyboard press crosses the boundary:
  // the camera moves, so the cursor does too, which is correct rather than a
  // conflict. (An earlier version kept a hand-maintained ref and exempted
  // keyboard landings from the glide to protect it - that got the causality
  // backwards, and disabled the boundary pushback for the whole session.)
  //
  // `cursor` is React state only because JSX needs it - the canvas's
  // `aria-label` and its nested, touch-reachable story/chips. The render loop
  // does NOT read it (see `cursorNow` below), for the same reason `cam` is a
  // ref: a re-render per keypress is fine, a torn-down and rebuilt render
  // EFFECT per keypress is not.
  const [cursor, setCursor] = useState(() => cursorCell(cam.current));

  /**
   * Where the cursor is RIGHT NOW, for the keyboard's own next move.
   *
   * `flightTarget()` rather than `cam.current`: mid-flight the latter is the
   * interpolated position, so a second key press arriving in the same tick as
   * the first would compute its move from a camera that has not gone anywhere
   * yet, and the two presses would collapse into one. The flight's resolved
   * target is where the previous press actually put the cursor. Idle - which
   * includes while the glide is easing back from outside the region - it is
   * just the live camera, so the next press builds on where the reader has
   * actually drifted to rather than on where they last aimed.
   */
  const cursorNow = useCallback(() => cursorCell(flightTarget()), [flightTarget]);
  // Whether ANY keyboard action has happened yet. Gates the ring in `render.js`
  // - a permanent reticle in the middle of a page nobody has touched would be a
  // strong visual choice made on nobody's behalf (accessibility-plan.md §3.6,
  // §8 item 6). A ref, not state: it only needs to be true by the time the next
  // frame reads it, not to trigger a render of its own.
  const keyboardUsed = useRef(false);
  // The ring itself is derived from the live camera in the render loop, and
  // every camera change already requests a draw - so this covers the one case
  // that is not a camera move: the FIRST keypress flipping `keyboardUsed`,
  // which makes the ring appear.
  useEffect(() => {
    requestDraw();
  }, [cursor, requestDraw]);

  // Carries the announcement's granularity across cursor moves, so a zoom held
  // near the threshold does not flicker between naming a cell and naming a
  // region (the same hysteresis `pickLevel` uses for the pyramid, applied to
  // what is SAID rather than to what is drawn - §3.1).
  const granularityRef = useRef('cell');

  // Whether the cursor is past the ranked content's edge, tracked so the
  // boundary is announced on the move that CROSSES it rather than on every
  // press once already outside - the room name would otherwise be drowned by
  // "edge of the library" on every single step through the far field.
  const wasBeyondBoundary = useRef(false);

  /**
   * Move the cursor to a specific cell, build what a reader should hear about
   * arriving there, and push it into the existing polite live region (Phase
   * A's `.note` status span) - not just the canvas's `aria-label`, because an
   * attribute change on an already-focused element is not reliably announced
   * across screen readers, and this is the one mechanism every AT actually
   * supports.
   *
   * `lead` is anything that happened to bring the cursor here - a search's
   * signals, a rearrangement's outcome. It goes in FRONT of the cell's own
   * name and inside the same live-region write, because two writes a moment
   * apart are two interruptions of whatever the reader was listening to, and
   * a polite region queues them rather than merging them.
   */
  const announceCursorMove = useCallback(
    (cell, lead = '') => {
      setCursor(cell);

      const canvas = canvasRef.current;
      const cellPxWidth = canvas ? pxPerCell(cam.current).x * (window.devicePixelRatio || 1) : 0;
      granularityRef.current = pickGranularity(cellPxWidth, granularityRef.current);

      const base =
        granularityRef.current === 'region'
          ? `the far field near (${cell.x}, ${cell.y}) - too far out to name a single room`
          : describeCell(cell.x, cell.y, { layout, order, metadata }).name;

      const beyond = cellDistance(cell.x, cell.y, CELL_ASPECT) > layout.boundaryRadius;
      const crossed = beyond !== wasBeyondBoundary.current;
      wasBeyondBoundary.current = beyond;

      const said =
        crossed && beyond
          ? `${base} - edge of the library; beyond here every wall is blank`
          : crossed
            ? `${base} - back within the library`
            : base;

      setStatus(lead ? `${lead}. ${said}` : said);
    },
    [cam, layout, order, metadata]
  );

  /**
   * What a reader hears when the library rearranges under them
   * (accessibility-plan.md §4.3, §8 item 4).
   *
   * Three clauses, and each is a different question: what decided the ranking
   * (the search's own note, if a search is what caused this), what the map now
   * looks like as a whole, and what is under the cursor NOW. The third is the
   * one §4.3 promises and Phase C never wired up - standing still while the
   * library reorders around you and hearing nothing about what arrived is not
   * an accessible rearrangement, whatever the animation is doing.
   *
   * Read after the camera has settled rather than before, so the cursor it
   * names is the one the reader actually ends up at: an animated rearrangement
   * parks the camera on the centre first, and saying the cell they left would
   * be describing somewhere they are no longer standing.
   */
  const announceArrangement = useCallback(() => {
    const note = pendingNote.current;
    pendingNote.current = '';
    announceCursorMove(
      cursorNow(),
      [note, describeArrangement(layout)].filter(Boolean).join('. ')
    );
  }, [announceCursorMove, cursorNow, layout]);

  /** `?` - the screen-reader equivalent of peripheral vision (§4.2a). */
  const announceSurroundings = useCallback(() => {
    setStatus(describeSurroundings(layout, order, metadata, cursor));
  }, [layout, order, metadata, cursor]);

  // The cursor's own story and keyword chips, nested inside the canvas as real
  // fallback content (accessibility-plan.md §4.2b, §4.4): "touch users get the
  // DOM... the cursor's contents", which a keyboard-only Enter would not give
  // them, since touch has nothing that corresponds to Enter. `tabIndex={-1}`
  // on the chips keeps them out of the desktop Tab sequence - the map is still
  // exactly one tab stop - while leaving them real, interactive elements a
  // touch screen reader's swipe navigation reaches regardless of tabindex.
  const cursorRoom = layout.roomAt(cursor.x, cursor.y, order);
  const cursorEntry = cursorRoom.centre || cursorRoom.generic ? null : metadata?.[cursorRoom.id] ?? null;
  // Named here rather than in the view, so `describeRoom` has exactly one
  // caller per reading of the corpus and the map cannot drift from the catalog
  // about what a room is called.
  const cursorDesc = cursorEntry
    ? describeRoom(cursorRoom.id, cursorRoom.rank, order.length, cursorEntry)
    : null;

  // The canvas's own accessible name - what a reader hears landing on it for
  // the FIRST time, before any move has run `announceCursorMove` and pushed
  // anything into the live region. Always the plain per-cell name, independent
  // of the region/cell granularity split that only matters once movement is
  // in progress.
  const cursorLabel = useMemo(
    () => describeCell(cursor.x, cursor.y, { layout, order, metadata }).name,
    [cursor, layout, order, metadata]
  );

  const onMapKeyDown = useCallback(
    (e) => {
      const dir = {
        ArrowLeft: { dx: -1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 },
        ArrowUp: { dx: 0, dy: -1 }, ArrowDown: { dx: 0, dy: 1 },
      }[e.key];

      if (dir) {
        e.preventDefault();
        keyboardUsed.current = true;

        if (e.ctrlKey || e.metaKey) {
          const found = nextRoom(layout, cursorNow(), dir);
          if (found) {
            flyTo(found.x, found.y, undefined, { ms: config.camera.keyboardMoveMs });
            announceCursorMove(found);
          } else {
            setStatus('nothing further in that direction');
          }
          return;
        }

        let { dx, dy } = dir;
        if (e.shiftKey) {
          // A screenful: however many cells actually fit the canvas on that
          // axis, so the jump matches what the reader would otherwise have
          // panned across by hand.
          const canvas = canvasRef.current;
          const per = canvas ? pxPerCell(cam.current) : { x: 1, y: 1 };
          const cellsX = canvas ? Math.max(1, Math.round(canvas.clientWidth / per.x)) : 1;
          const cellsY = canvas ? Math.max(1, Math.round(canvas.clientHeight / per.y)) : 1;
          dx *= cellsX;
          dy *= cellsY;
        }
        // `nudgeBy`, not `flyTo`: this is a PAN, and pans are damped by the
        // map's resistance so pushing outward gets heavier - the same curve a
        // pointer drag gets, for parity. Inside the content region the damping
        // is 1, so this is still exactly one cell per press.
        //
        // The announcement therefore has to come from where the move actually
        // LANDED (`cursorNow()` re-read after the nudge, which sees the new
        // flight's target) rather than from a target computed here: far
        // outside, a press may not advance the cursor a whole cell at all, and
        // announcing the cell the reader aimed at would be describing a room
        // they are not going to reach. When the cell is unchanged the string is
        // identical, React does not re-render, and no live-region update fires
        // - silence being the honest answer to a press that went nowhere.
        //
        // Announced synchronously rather than on the flight landing: the
        // cursor's cell is settled the instant the key is processed, and
        // `keyboardMoveMs` exists to make that motion visible to sighted
        // readers, not to gate anything else. A rapid run of presses each
        // interrupts the previous flight - the same "a second flight replaces
        // the first" `flyTo` already gives Home - so key-repeat chases
        // smoothly rather than queuing animations.
        nudgeBy(dx, dy, { ms: config.camera.keyboardMoveMs });
        announceCursorMove(cursorNow());
        return;
      }

      if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        keyboardUsed.current = true;
        // Flies to the CURSOR's own cell at a new zoom, which keeps the
        // cursor fixed across the zoom the way the old pixel-anchored
        // `zoomBy` did, and lands the camera exactly cell-centred.
        //
        // The zoom is built off `flightTarget()`, not `cam.current.zoom` -
        // `cam.current` is the INTERPOLATED value, which a flight in progress
        // has not necessarily moved from its start at all yet. Two PageDown
        // presses back to back both reading `cam.current.zoom` would compute
        // the SAME target and the second would silently cancel the first's
        // effect rather than compounding it - `flightTarget()` chains off the
        // fully-resolved target of whatever is already in flight instead.
        const factor = e.key === 'PageUp' ? 1.6 : 1 / 1.6;
        const zoom = flightTarget().zoom * factor;
        const here = cursorNow();
        flyTo(here.x, here.y, zoom, { ms: config.camera.keyboardMoveMs });
        // The cursor cell itself does not move, but the granularity might, so
        // re-announce.
        announceCursorMove(here);
        return;
      }

      if (e.key === 'Home') {
        e.preventDefault();
        keyboardUsed.current = true;
        if (e.ctrlKey || e.metaKey) {
          const best = layout.cellOfRank(0);
          if (!best) {
            setStatus('no ranked rooms to jump to');
            return;
          }
          flyTo(best.x, best.y, config.camera.defaultZoom).then(
            (landed) => landed && announceCursorMove(best)
          );
        } else {
          flyTo(0, 0, config.camera.defaultZoom).then(
            (landed) => landed && announceCursorMove({ x: 0, y: 0 })
          );
        }
        return;
      }

      if (e.key === 'Enter' || e.key === ' ') {
        // Opening a card over the wallpaper would make the gesture read as
        // broken rather than as empty - the same rule `picking.js` states for
        // a click, applied here to a keypress.
        const here = cursorNow();
        const at = layout.roomAt(here.x, here.y, order);
        if (at.centre || at.generic) return;
        e.preventDefault();
        const canvas = canvasRef.current;
        const at2 = canvas
          ? { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }
          : { x: 0, y: 0 };
        setCard({ id: at.id, rank: at.rank, x: here.x, y: here.y, at: at2 });
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        goToSearchRef.current();
        return;
      }

      if (e.key === '?') {
        e.preventDefault();
        announceSurroundings();
      }
    },
    [
      layout, order, flyTo, nudgeBy, flightTarget, cursorNow, config,
      announceCursorMove, announceSurroundings, cam,
    ]
  );

  // --- rendering -----------------------------------------------------------
  //
  // The frame loop itself is `useMapRenderer.js`. `draw` stays here because the
  // tile cache above is built with `onLoad: requestDraw`, so the request has to
  // exist before the hook that fulfils it - one ref, and the cycle is broken.
  useMapRenderer({
    canvasRef, searchFormRef, booksRef, draw, anim, keyboardUsed, cam, mode,
    layout, order, renderer, slideRenderer, cache, centreSlots, centreOverlay,
  });

  // --- the rearrangement animation -----------------------------------------

  /**
   * Slide the library from one arrangement into another.
   *
   * The camera is parked on the centre at the opening zoom first, and stays
   * there: the plan is made against exactly the cells that are on screen, and
   * the guarantee it offers - that nothing is ever seen to teleport - is a
   * guarantee about that rectangle. Returns false when the change cannot be
   * animated legally, which is the caller's cue to let it happen at once.
   */
  const startRearrangement = useCallback(
    async (before, after) => {
      const canvas = canvasRef.current;
      if (!canvas) return false;

      // Someone who asked for less motion gets the library rebuilt at once.
      // Returning false here is not a special case: it is the same answer
      // `buildRearrangement` gives for a change that cannot be animated
      // legally, and the caller already knows what to do with it. So reduced
      // motion costs one condition and reuses a path that is already written
      // and already tested, rather than adding a branch of its own.
      //
      // Before the flight, deliberately: the fly-home exists to set up the
      // animation, so with no animation to set up there is no reason to move
      // the camera - and moving it unasked is itself the thing being avoided.
      if (prefersReducedMotion()) return false;

      // Hold the old arrangement on screen for the flight. `layout` and `order`
      // already describe the new one, and without this the map would show it,
      // fly to it, and only then slide it in from the arrangement it had
      // already replaced.
      anim.current = { before };

      // Land before rearranging, rather than racing it: two animations
      // competing for the same attention and neither lands. It is also a
      // correctness requirement now that flights ease - the plan is made
      // against exactly the cells on screen, so it cannot be made until the
      // camera has stopped moving.
      const landed = await flyTo(0, 0, config.camera.defaultZoom);
      if (anim.current?.before !== before) return true; // superseded; not ours to undo
      if (!landed) {
        // The reader took the map. Not the moment to rebuild the library.
        anim.current = null;
        return false;
      }

      const parked = { ...cam.current };
      const perCell = pxPerCell(parked);
      const halfW = canvas.clientWidth / 2 / perCell.x;
      const halfH = canvas.clientHeight / 2 / perCell.y;
      const view = {
        x0: Math.floor(parked.x - halfW), x1: Math.ceil(parked.x + halfW),
        y0: Math.floor(parked.y - halfH), y1: Math.ceil(parked.y + halfH),
      };

      const built = buildRearrangement({ before, after, view, aspect: CELL_ASPECT });
      if (!built) {
        anim.current = null;
        return false;
      }

      const board = { width: built.width, height: built.height, cells: built.start.cells.slice() };
      const show = createSlideshow({
        board,
        moves: planMoves(built.start, built.end, built.bounds, built.fixed),
        apply: applyMove,
        timing: config.slide,
      });
      anim.current = {
        before, show, board, origin: built.origin, cam: parked, motions: [], t0: performance.now(),
      };

      const tick = () => {
        const running = anim.current;
        if (!running?.show) return; // interrupted
        const { done, motions } = running.show.advanceTo(performance.now() - running.t0);
        running.motions = motions;
        if (done) anim.current = null;
        requestDraw();
        if (!done) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    },
    [flyTo, cam, config, requestDraw]
  );

  // Every change to what is on the map arrives here. Only the ones a control
  // asked to be animated are: the sliders change the layout on every drag, and
  // a rearrangement per frame would be neither legible nor affordable.
  //
  // `useLayoutEffect` so the hold is in place before the first paint of the new
  // arrangement. The drawing effect above calls `render()` when it is set up,
  // and effects of the same kind run in declaration order - so an ordinary
  // effect here would paint one frame of the new library before the hold could
  // stop it.
  useLayoutEffect(() => {
    const current = { layout, order };
    const previous = arrangement.current;
    arrangement.current = current;

    // In the catalog there is no map on screen to rearrange, and flying a
    // hidden camera to set up a slide nobody can see would be a second of
    // nothing. The map's `layout` and `order` still updated, so returning to it
    // simply shows the new arrangement at once - which is not a new path but
    // the one `buildRearrangement` already takes when a change cannot be
    // animated legally.
    //
    // The catalog says what happened in its own voice instead: the arrangement
    // sentence talks about clustering near a centre this reading does not have.
    if (mode !== 'map') {
      animateNext.current = false;
      const note = pendingNote.current;
      pendingNote.current = '';
      setStatus(describeCatalog({ total: order.length, query: result?.term ?? '', note }));
      return;
    }

    if (!animateNext.current || !previous) {
      requestDraw();
      return;
    }
    animateNext.current = false;
    startRearrangement(previous, current).then((started) => {
      if (!started) requestDraw();
      // Announce the arrangement this effect was for, and only if it is still
      // the one on the map: `startRearrangement` reports true for a run that
      // was superseded mid-flight as well as for one that got going, and the
      // effect for the newer arrangement will announce that one itself.
      if (arrangement.current === current) announceArrangement();
    });
  }, [layout, order, startRearrangement, requestDraw, announceArrangement, mode, result]);

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
    // Both branches rearrange the library - clearing the box restores the
    // uniform map, which is as much a rearrangement as finding something is.
    animateNext.current = true;
    if (!term.trim()) {
      setResult(null);
      pendingNote.current = '';
      return;
    }
    // A real search is a history entry, and the frontmost book from now on. Done
    // before the fetch, so a click on that book is remembered even if the
    // ranking that follows is a stub.
    pushHistory(term.trim());
    const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`).then((r) => r.json());

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
      pendingNote.current = describeSignals(signals, Boolean(searchIndex));
      // `term`, not the live `query`: the box changes on every keystroke and
      // the ranking does not, so anything derived from "what was searched for"
      // - the highlight ranges especially - has to read the submitted term or
      // it would mark text against a query nobody has run yet.
      setResult({ order, certainty, breakdown, signals, term });
    } else {
      // The stub ranking is a hash, so it is not certain of anything and must
      // not pretend to be: no profile, and the map stays evenly scattered.
      pendingNote.current = 'stub ranking — no embeddings and no keywords in this corpus';
      // No breakdown: a hash-ordered stub has no signals to explain, and an
      // explanation of a ranking nothing decided would be an invented one.
      setResult({ order: res.order, certainty: null, breakdown: null, signals: null, term });
    }
  };

  const runSearch = (e) => {
    e.preventDefault();
    search(query);
  };

  // The panel's one remaining search affordance: reach the live field on the
  // centre tile. If it is already on screen and legible, just focus it -
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

  // --- switching between the two readings ----------------------------------
  //
  // The map is hidden rather than unmounted, so neither direction rebuilds
  // anything: the camera is exactly where it was left, the tile cache is warm,
  // and `useMapCamera`'s pointer listeners - bound once against a ref object
  // rather than an element - are still attached to a canvas that never went
  // away.
  //
  // The animation is a FLIP on ONE element. The centre tile is what the map is
  // framed on and what the catalog's first row shows, so folding one into the
  // other is a transform on that row's thumbnail while the map cross-fades,
  // rather than anything the renderer has to know about.
  const catalogScrollRef = useRef(null);
  const firstTileRef = useRef(null);
  // Where the centre tile was on the map when the switch began, or null if it
  // was off screen - a reader who panned away has nothing to fold from, and the
  // transition degrades to a cross-fade rather than flying in from a corner.
  const flipFrom = useRef(null);

  /** The centre cell's screen rect, or null if none of it is in view. */
  const centreRectNow = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const rect = centreCellRect(cam.current, { width: w, height: h });
    return overlapsViewport(rect, w, h) ? rect : null;
  }, [cam]);

  const animatedSwitch = () =>
    !prefersReducedMotion() && config.catalog.transitionMs > 0;

  const enterCatalog = useCallback(() => {
    flipFrom.current = animatedSwitch() ? centreRectNow() : null;
    setCard(null);
    setMode('catalog');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreRectNow, config]);

  const exitCatalog = useCallback(() => {
    if (!animatedSwitch()) {
      setMode('map');
      return;
    }
    // The map is already at the camera it will land on, so the tile's
    // destination is knowable before anything moves.
    flipFrom.current = centreRectNow();
    setLeaving(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreRectNow, config]);

  /**
   * Run the FLIP, in whichever direction the mode just moved.
   *
   * `useLayoutEffect` because the invert transform has to be applied before the
   * browser paints the catalog in its resting position - one frame of the list
   * at full size, then a jump onto the tile, is exactly the flash this is meant
   * to replace.
   */
  useLayoutEffect(() => {
    const entering = mode === 'catalog' && !leaving;
    if (!entering && !leaving) return;

    const tile = firstTileRef.current;
    const anchor = flipFrom.current;
    const ms = config.catalog.transitionMs;
    let timer = 0;

    // Nothing to fold from or to: cross-fade, which the stylesheet does on its
    // own, and just land.
    if (!tile || !anchor || !animatedSwitch()) {
      if (leaving) timer = setTimeout(() => { setMode('map'); setLeaving(false); }, 0);
      return () => clearTimeout(timer);
    }

    // `rectOf`, not the DOMRect itself - see its comment. Passing the DOMRect
    // straight in does not throw; it silently drops the scale.
    const rest = rectOf(tile.getBoundingClientRect());
    const onto = flipCss(flipTransform(anchor, rest));

    if (entering) {
      // Start on the tile, then release to nothing.
      tile.style.transition = 'none';
      tile.style.transform = onto;
      // Read back, so the two writes cannot be coalesced into no animation.
      void tile.offsetWidth;
      tile.style.transition = `transform ${ms}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
      tile.style.transform = '';
      timer = setTimeout(() => {
        tile.style.transition = '';
      }, ms);
    } else {
      // Leaving: from nothing back onto the tile, and land when it arrives.
      tile.style.transition = `transform ${ms}ms cubic-bezier(0.55, 0.06, 0.68, 0.19)`;
      tile.style.transform = onto;
      timer = setTimeout(() => {
        tile.style.transition = '';
        tile.style.transform = '';
        setMode('map');
        setLeaving(false);
      }, ms);
    }

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, leaving, config]);

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
    animateNext.current = true;
    setOrderSeed((s) => s + 1);
  }, []);
  const rescatter = useCallback(() => {
    animateNext.current = true;
    setSeed((s) => s + 1);
  }, []);
  const recentre = useCallback(
    () => flyTo(0, 0, config.camera.defaultZoom),
    [flyTo, config]
  );
  const forgetSearches = useCallback(() => setHistory([]), []);

  /**
   * What an override book does. The seam this file has carried empty since the
   * shelf was built; the catalog is the first thing to claim a slot.
   */
  const onOverride = (slot) => {
    if (slot.action === 'catalog') enterCatalog();
  };

  /**
   * What book `i` does. ONE implementation, two entry points: a sighted click
   * arrives through `onTap` -> `bookAtPoint` below, a keyboard Enter (and a
   * screen reader's activate) through the button's own click. Two copies of
   * "what does book i do" would drift, which is the whole reason this is not
   * written inline in either.
   *
   * A history or tag book repeats its search; an override book runs its
   * function; an untitled book does nothing, and has no button.
   */
  const onBook = (i) => {
    const slot = centreSlots[i];
    if (!slot) return;
    if (slot.term) {
      setQuery(slot.term);
      search(slot.term);
    } else if (slot.action) {
      onOverride(slot);
    }
  };

  // Arrows move within the shelf; Tab leaves it. Left and right run along the
  // wall's flat queue across shelf ends, up and down move a shelf holding the
  // column - `bookNeighbour` owns both, so what a press does is asserted
  // without a browser. Home and End reuse it from outside the wall rather than
  // being a second way to say "first" and "last".
  const onBooksKeyDown = (e) => {
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
  };

  // Selecting a book on the centre room. Off the centre cell or on an empty
  // book, nothing happens - the tap is not otherwise claimed.
  tapRef.current = (px, py, camera) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = { width: canvas.clientWidth, height: canvas.clientHeight };
    const cell = centreCellRect(camera, rect);

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
        manifest={manifest}
        total={total}
        described={described}
        status={status}
        query={query}
        setQuery={setQuery}
        onSearch={runSearch}
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
          order={order}
          metadata={metadata}
          result={result}
          highlight={highlight}
          query={query}
          setQuery={setQuery}
          onSearch={runSearch}
          paging={paging}
          setPaging={setPaging}
          onExit={exitCatalog}
          onShowOnMap={showOnMap}
          onKeyword={searchKeyword}
          onExpand={expandRoom}
          centreSlots={centreSlots}
          onBook={onBook}
          cellOfRank={(rank) => layout.cellOfRank(rank)}
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
 * Books on the centre shelf with a distinct function, reserved by slot index.
 *
 * The seam the concept asks for - "certain books will have distinct functions,
 * e.g. displaying an artist's statement" - built so history can never overwrite
 * them. `action` is dispatched by `onOverride` in `Library`; add nothing here
 * until the function it names exists, so an override always does something.
 *
 * Slot 0 is the top-left book, reserved before history fills the wall, and it
 * opens the catalog - the corpus read as a list rather than as a map. That it
 * is a BOOK is the point: the way out of the map is an object in the room,
 * which is the same argument that put the search field on the centre tile.
 * `assignTitles` displaces history past a reserved slot rather than writing
 * over it, so the shelf simply starts one book later.
 */
const CENTRE_OVERRIDES = {
  0: { text: 'the catalog', action: 'catalog' },
};

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
function describeSurroundings(layout, order, metadata, cursor) {
  const here = describeCell(cursor.x, cursor.y, { layout, order, metadata }).name;

  const nearby = [
    ['east', { dx: 1, dy: 0 }],
    ['west', { dx: -1, dy: 0 }],
    ['south', { dx: 0, dy: 1 }],
    ['north', { dx: 0, dy: -1 }],
  ]
    .map(([label, dir]) => {
      const found = nextRoom(layout, cursor, dir);
      if (!found) return null;
      const steps = Math.abs(found.x - cursor.x) + Math.abs(found.y - cursor.y);
      const id = layout.roomAt(found.x, found.y, order).id;
      return `Room ${id} ${steps} ${label}`;
    })
    .filter(Boolean);

  const edge = Math.max(0, layout.boundaryRadius - cellDistance(cursor.x, cursor.y, CELL_ASPECT));

  return [
    here,
    nearby.length ? nearby.join('; ') : 'nothing else ranked nearby',
    `the edge of the library is about ${Math.round(edge)} away`,
  ].join('. ');
}

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
