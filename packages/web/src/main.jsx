import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createLayout, shuffledOrder } from '../../map/ordering.js';
import { joinMetadata } from '../../map/metadata.js';
import { buildSearchIndex, rankHybrid } from '../../map/scoring.js';
import { buildRearrangement } from '../../map/board.js';
import { planMoves, applyMove } from '../../map/illusion.js';
import { roomAtPoint } from './picking.js';
import { describeCell } from '../../map/describe.js';
import {
  assignTitles,
  pickTags,
  bookAtPoint,
  centreCellRect,
  searchBoxScreenRect,
  isSearchBoxUsable,
  searchBoxAtPoint,
  HISTORY_SLOT_COUNT,
  CENTRE_OPENING_RECT,
} from './centre.js';
import { CELL_ASPECT, pxPerCell, fitZoom } from './camera.js';
import { createTileCache, CENTRE, variantId } from './tiles.js';
import { createUrlFor } from './rooms.js';
import { createRenderer } from './render.js';
import { createSlideshow, createSlideRenderer } from './slide.js';
import { sizeOf as pyramidSizeOf, BASE_TILE } from './pyramid.js';
import { useMapCamera, prefersReducedMotion } from './useMapCamera.js';

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
  const total = manifest.count;

  // Every by-feel starting value comes from the manifest's config block rather
  // than from a literal here - see packages/config. The sliders still move
  // freely afterwards; config decides where they start.
  const config = manifest.config;

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
  // Session-only search history, newest first, one book per entry. Kept in
  // React state like every other runtime value - it does not survive a reload,
  // which matches the camera and the current ranking.
  const [history, setHistory] = useState([]);
  const pushHistory = useCallback((term) => {
    setHistory((prev) => [term, ...prev.filter((t) => t !== term)].slice(0, HISTORY_SLOT_COUNT));
  }, []);

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
  const cache = useMemo(() => {
    const tiles = createTileCache({
      urlFor: createUrlFor(manifest),
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
  }, [manifest, requestDraw]);

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

  const resistanceAt = useCallback((x, y) => layout.resistanceAt(x, y), [layout]);

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

  // A tap selects a book on the centre room. Stable identity - so the pointer
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

  const { cam, flyTo } = useMapCamera({
    canvasRef,
    resistanceAt,
    onChange: requestDraw,
    camera: config.camera,
    opening,
    onPick,
    onTap,
    onDebug,
  });

  // Whether the live search field (on the centre tile) is currently on screen
  // and large enough to use, and where it sits if so - the one computation
  // both the render loop (to position and show/hide it) and the panel's
  // search trigger (to decide whether to fly home first) need, so neither
  // restates the other's notion of "usable".
  const searchBoxState = useCallback(
    (w, h) => {
      const cellRect = centreCellRect(cam.current, { width: w, height: h });
      const box = searchBoxScreenRect(cellRect);
      const onScreen = box.x + box.w > 0 && box.x < w && box.y + box.h > 0 && box.y < h;
      return { box, usable: onScreen && !anim.current && isSearchBoxUsable(cellRect) };
    },
    [cam]
  );

  // --- rendering -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    // The pending frame's id, so it can be cancelled - not just a flag. This
    // closure captures `layout` and `order`, so a frame scheduled through it
    // and left to fire after the effect has been rebuilt repaints the state
    // this render pass replaced. That is a real frame of the old map, arriving
    // after the new one and winning, which is what a stale draw looks like.
    let pending = 0;

    const render = () => {
      pending = 0;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // The centre tile's live search field, positioned every frame like the
      // canvas content it sits over - it is not React state, for the same
      // reason the camera itself is a ref: it moves on every pan, zoom and
      // flight, and a re-render per frame is not the architecture here.
      const searchEl = searchFormRef.current;
      if (searchEl) {
        const { box, usable } = searchBoxState(w, h);
        searchEl.style.display = usable ? 'block' : 'none';
        if (usable) {
          searchEl.style.left = `${box.x}px`;
          searchEl.style.top = `${box.y}px`;
          searchEl.style.width = `${box.w}px`;
          searchEl.style.height = `${box.h}px`;
        }
      }

      // Three states, and the middle one is why this is not an `if`.
      //
      // While SLIDING, the rearrangement draws itself from its own board at the
      // camera it was planned for; the live camera is not consulted, because
      // the board is a finite window and panning off it would show the wrap
      // that makes the whole illusion affordable.
      //
      // While FLYING home to start one, the ordinary renderer draws - but the
      // arrangement it draws is the one being flown away from, not the one just
      // computed. `layout` and `order` update the moment a search resolves,
      // which is before the camera has moved, so drawing them here would show
      // the new library, fly to it, and then slide it in from the old one.
      const running = anim.current;
      const showing = running?.before ?? { layout, order };
      const stats =
        running?.board
          ? slideRenderer.draw({
              ctx, width: w, height: h, dpr, cam: running.cam,
              board: running.board, origin: running.origin, motions: running.motions,
              variantAt: layout.variantAt,
            })
          : renderer.draw({
              ctx, width: w, height: h, dpr, cam: cam.current,
              layout: showing.layout, order: showing.order, centreSlots,
            });

      const hud = document.getElementById('hud');
      if (running?.board && hud) {
        const pct = Math.round((100 * Math.min(running.show.totalMs, performance.now() - running.t0)) / running.show.totalMs);
        hud.textContent =
          `rearranging · ${pct}% · ${running.motions.length} lines moving · ` +
          `level ${stats.level} · ${stats.blank} blank · ${cache.size()} cached`;
      } else if (hud) {
        const size = pyramidSizeOf(stats.level);
        const over = cache.overBudget();
        hud.textContent =
          `${stats.cells} cells · ${stats.drawn} drawn · ` +
          `level ${stats.level} (${size.w}px) · ${stats.substituted} substituted · ` +
          `${stats.blank} blank · ` +
          `${cache.size()} cached${over ? ` (+${over} over budget)` : ''} · ` +
          `zoom ${Math.round(stats.zoom)} · ` +
          `x ${cam.current.x.toFixed(1)} y ${cam.current.y.toFixed(1)} · ` +
          `edge at r=${layout.boundaryRadius.toFixed(1)}` +
          (layout.gradedCount ? ` · ${layout.gradedCount} clustered` : '');
      }
    };

    draw.current = () => {
      if (pending) return;
      pending = requestAnimationFrame(render);
    };

    render();
    const onResize = () => draw.current();
    // Touching the map ends a rearrangement rather than fighting it: the
    // remaining moves land at once, which is exactly the instant rebuild this
    // animation replaced. A map you cannot interrupt is not a map.
    const onDown = () => {
      const running = anim.current;
      if (!running) return;
      // Mid-slide, the remaining moves land at once - which is the instant
      // rebuild this replaced. Still flying home, there is no slideshow yet and
      // nothing to finish; dropping the hold is enough, and the next draw shows
      // the new arrangement. `useMapCamera` cancels the flight itself.
      running.show?.advanceTo(running.show.totalMs);
      anim.current = null;
      draw.current();
    };
    window.addEventListener('resize', onResize);
    canvas.addEventListener('pointerdown', onDown);
    return () => {
      if (pending) cancelAnimationFrame(pending);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerdown', onDown);
    };
  }, [layout, order, renderer, slideRenderer, cache, cam, centreSlots, searchBoxState]);

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
    if (!animateNext.current || !previous) {
      requestDraw();
      return;
    }
    animateNext.current = false;
    startRearrangement(previous, current).then((started) => {
      if (!started) requestDraw();
    });
  }, [layout, order, startRearrangement, requestDraw]);

  // --- search --------------------------------------------------------------
  const search = async (term) => {
    // Both branches rearrange the library - clearing the box restores the
    // uniform map, which is as much a rearrangement as finding something is.
    animateNext.current = true;
    if (!term.trim()) {
      setResult(null);
      setStatus('');
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
      const { order, certainty, signals } = rankHybrid({
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
      setResult({ order, certainty });
      setStatus(describeSignals(signals, Boolean(searchIndex)));
    } else {
      // The stub ranking is a hash, so it is not certain of anything and must
      // not pretend to be: no profile, and the map stays evenly scattered.
      setResult({ order: res.order, certainty: null });
      setStatus('stub ranking — no embeddings and no keywords in this corpus');
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
    if (searchBoxState(canvas.clientWidth, canvas.clientHeight).usable) {
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
  }, [flyTo, opening, searchBoxState]);

  // A chip on the card is a live search: reading a room becomes a way of moving
  // through the library rather than a dead end. The card closes because the map
  // is about to rearrange under it, and it would be describing a cell that no
  // longer holds that room.
  const searchKeyword = (text) => {
    setQuery(text);
    setCard(null);
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

  // A future override book does something other than search - an artist's
  // statement, say. Nothing reserves a slot yet (CENTRE_OVERRIDES is empty), so
  // this is the seam, not a live feature; it is wired so adding an override is
  // the only change needed.
  const onOverride = (slot) => {
    void slot; // e.g. switch (slot.action) { case 'statement': ... }
  };

  // Selecting a book on the centre room. Off the centre cell or on an empty
  // book, nothing happens - the tap is not otherwise claimed. A history or tag
  // book repeats its search; an override book runs its function.
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
    if (slotIndex == null) return;
    const slot = centreSlots[slotIndex];
    if (!slot) return;
    if (slot.term) {
      setQuery(slot.term);
      search(slot.term);
    } else if (slot.action) {
      onOverride(slot);
    }
  };

  return (
    <>
      {/*
        Named rather than hidden, for now. Once the map grows its cursor and
        live regions (accessibility-plan.md phase C) the canvas becomes
        `aria-hidden` and the DOM carries everything - but until then this is
        the entire application, and an unnamed graphic is the one thing it must
        not be. `role="img"` is honest about what it currently offers: a picture
        you cannot yet navigate.
      */}
      <canvas ref={canvasRef} role="img" aria-label="The library map — a pannable grid of shelved walls" />
      {/*
        The live search field, on the centre tile itself rather than in the
        panel. Always mounted - Playwright's `inputValue()` and React's
        controlled `value` both need it attached - but hidden by the
        stylesheet (`.centre-search { display: none }`) until the render loop
        above finds it on screen and legible, at which point it takes over
        `display`/position directly. No `style` prop here on purpose: a React
        re-render (every keystroke touches `query`) would otherwise reapply
        whatever style this component declared and fight the imperative
        positioning every frame.
      */}
      <form ref={searchFormRef} onSubmit={runSearch} className="centre-search">
        <input
          type="search"
          aria-label="search the library"
          placeholder="search the library…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>
      <div className="panel">
        <h1>The Indexing of Babel</h1>
        <p className="sub">
          offline · {total} rooms in {manifest.directory.split('/').slice(-1)[0]}
          {described > 0 && <> · {described} described</>}
        </p>

        <div className="row">
          <button className="search-trigger" onClick={goToSearch} aria-label="search the library">
            🔍 search
          </button>
        </div>

        {/*
          The ranked listbox: the lossless reading of a search, next to the map's
          lossy spatial one (accessibility-plan.md §3.2). A plain list of buttons
          rather than `role="listbox"` with arrow-key roving on purpose - that
          widget pattern needs the keyboard model phase C brings, and a listbox
          that does not implement roving is a broken widget, worse than none.
          Every button here is independently reachable by Tab today, which is
          what makes this the phase that ships before the map's keyboard
          interface (§5): it works with no arrow keys at all.

          Absent entirely when there is no search, or when one ran and matched
          nothing worth clustering (`gradedCount === 0`) - the empty state IS the
          uniform map, and a list with nothing ranked in it would be noise.
        */}
        {searchResults && searchResults.total > 0 && (
          <div className="row results" role="region" aria-labelledby="results-label">
            <label id="results-label">
              results <b>{searchResults.total}</b>
              {searchResults.total > searchResults.rooms.length &&
                ` (showing ${searchResults.rooms.length})`}
            </label>
            {/*
              `aria-setsize`/`aria-posinset` go on the `<li>`, not the button
              inside it: those two are valid on the `listitem` role (a `<li>`'s
              implicit role inside a `<ul>`) and are not valid on a bare
              `button` - axe's `aria-allowed-attr` rule would flag the wrong
              placement.
            */}
            <ul className="results-list">
              {searchResults.rooms.map((r) => (
                <li key={r.id} aria-setsize={searchResults.total} aria-posinset={r.rank + 1}>
                  <button className="result" onClick={() => openRoom(r.x, r.y, r.id, r.rank)}>
                    {r.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/*
          Both sliders carry an explicit `htmlFor`/`id` pair: the label is a
          SIBLING of its input rather than wrapping it, so without the
          association neither slider has an accessible name and both announce
          as a bare number. `aria-valuetext` then says what the number counts -
          a range reports "42" on its own, which is the one thing about it that
          was never in question.
        */}
        <div className="row">
          <label htmlFor="rooms-on-map">
            rooms on the map <b>{Math.min(roomCount, total)}</b>
          </label>
          <input
            id="rooms-on-map"
            type="range" min="1" max={total} value={Math.min(roomCount, total)}
            aria-valuetext={`${Math.min(roomCount, total)} of ${total} rooms`}
            onChange={(e) => setRoomCount(Number(e.target.value))}
          />
        </div>

        <div className="row">
          <label htmlFor="non-generic">
            non-generic <b>{Math.round(contentRatio * 100)}%</b>
          </label>
          <input
            id="non-generic"
            type="range" min="2" max="100" value={Math.round(contentRatio * 100)}
            aria-valuetext={`${Math.round(contentRatio * 100)}% of cells hold a corpus room`}
            onChange={(e) => setContentRatio(Number(e.target.value) / 100)}
          />
        </div>

        <div className="buttons">
          <button onClick={() => { animateNext.current = true; setOrderSeed((s) => s + 1); }}>
            reorder
          </button>
          <button onClick={() => { animateNext.current = true; setSeed((s) => s + 1); }}>
            rescatter
          </button>
          <button onClick={() => flyTo(0, 0, config.camera.defaultZoom)}>centre</button>
        </div>

        {/*
          The hint and the status are two different things and must not share a
          node. `role="status"` announces every change to its subtree, so a
          single node that falls back to the hint would read the instructions
          aloud again each time a status cleared. The hint is static and silent;
          the region below it starts empty and only ever holds what the map just
          did, which is exactly what a polite live region is for.
        */}
        <div className="note">
          {!status && 'drag to pan, scroll to zoom. right-click a room.'}
          <span role="status">{status}</span>
        </div>
      </div>
      <div className="hud" id="hud" />
      {TOUCH_DEBUG && <div className="touchlog" id="touchlog" />}
      {card && cardDescription && (
        <RoomCard
          card={card}
          desc={cardDescription}
          entry={metadata?.[card.id] ?? null}
          file={manifest.rooms[card.id]?.file}
          onClose={() => setCard(null)}
          onKeyword={searchKeyword}
        />
      )}
    </>
  );
}

/** How far the card sits from the pick, and from the edge it is clamped against. */
const CARD_GAP = 12;

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
 * them. It ships empty; the shape a future entry takes is
 *   { 0: { text: 'artist’s statement', action: 'statement' } }
 * where `action` is dispatched by `onOverride` below. Add nothing here until the
 * function it names exists, so an override always does something.
 */
const CENTRE_OVERRIDES = {};

/**
 * `?touchdebug` prints the raw pointer stream on screen.
 *
 * Read at module scope so the whole feature compiles out of a normal session:
 * nothing renders, and the hook is handed no callback at all rather than one
 * that discards. Touch is the one layer that cannot be judged from a desktop,
 * and the CDP touch injection the e2e test uses bypasses the browser's own
 * gesture arbitration - so a real device reporting for itself is the only way
 * some of these questions get answered.
 */
const TOUCH_DEBUG =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('touchdebug');

const TOUCH_LOG_LINES = 14;
const touchLog = [];

function appendTouchLog(line) {
  touchLog.push(line);
  if (touchLog.length > TOUCH_LOG_LINES) touchLog.shift();
  const el = document.getElementById('touchlog');
  if (el) el.textContent = touchLog.join('\n');
}

/**
 * One room's keywords and story, opened by right-click or long press.
 *
 * Placed where the gesture happened and clamped back inside the viewport, so a
 * pick near an edge does not open a card half off screen. Escape and a click
 * anywhere outside close it, which are the two things anyone tries first.
 */
function RoomCard({ card, desc, entry, file, onClose, onKeyword }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(() => ({ left: card.at.x + CARD_GAP, top: card.at.y + CARD_GAP }));

  // Clamp against the card's REAL height, not an assumed one: it grows with the
  // story, so a guess is wrong for exactly the long entries most likely to run
  // off the bottom of a short viewport. useLayoutEffect so the correction lands
  // before the browser paints rather than as a visible jump.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(CARD_GAP, Math.min(card.at.x + CARD_GAP, window.innerWidth - width - CARD_GAP)),
      top: Math.max(CARD_GAP, Math.min(card.at.y + CARD_GAP, window.innerHeight - height - CARD_GAP)),
    });
  }, [card]);

  // Focus moves in on open and goes back where it came from on close.
  //
  // Two things make the restore conditional rather than unconditional. A card
  // is dismissed by clicking *anywhere else*, and that click has usually
  // already put focus somewhere the reader chose - stealing it back would
  // undo their own action. And the card may be closed because the map is about
  // to rearrange under it (`searchKeyword`), by which point the element that
  // opened it may be gone. So: restore only if focus is still inside the card
  // or has fallen to the body, which are exactly the cases where nobody else
  // has claimed it.
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.focus();
    return () => {
      // The body is not somewhere focus can be "put back" - it is where focus
      // already is when nothing holds it, which is the ordinary case for a card
      // opened by right-clicking the canvas. Nothing to restore.
      if (!opener || opener === document.body || !opener.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !ref.current?.contains(active)) return;
      opener.focus();
    };
    // Mount and unmount only: re-running this on a re-render would drag focus
    // back to the card while someone is reading a chip inside it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    // `pointerdown` rather than `click`: the canvas would otherwise start a pan
    // under a dismissing click, and the map would lurch as the card vanished.
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  // Named by `desc.name` - the same string a listbox option and (once the
  // cursor lands, phase C) the map itself would say for this cell. "room" -
  // which is what this used to announce on its own - is the one fact a reader
  // already had; the rank and the keywords are the reason to have opened it.
  //
  // `tabIndex={-1}` makes it focusable without putting it in the tab order,
  // which is what lets focus be moved here programmatically above.
  return (
    <div
      className="card"
      ref={ref}
      style={pos}
      role="dialog"
      tabIndex={-1}
      aria-label={desc.name}
    >
      <div className="card-head">
        <span className="card-id">
          room {card.id}
          {file ? ` · ${file}` : ''}
        </span>
        <button className="card-close" onClick={onClose} aria-label="close">
          ×
        </button>
      </div>

      {entry?.keywords?.length > 0 && (
        <div className="chips">
          {entry.keywords.map((k) => (
            <button
              key={k.text}
              className="chip"
              title={k.type ? `${k.type} — search for this` : 'search for this'}
              onClick={() => onKeyword(k.text)}
            >
              {k.text}
            </button>
          ))}
        </div>
      )}

      {desc.description && <p className="story">{desc.description}</p>}

      {!entry && <p className="story dim">No keywords recorded for this room.</p>}
    </div>
  );
}

/**
 * What actually decided this ranking, in the panel's own voice.
 *
 * `signals` reports which of the three found anything for this query, not which
 * were available - a corpus full of keywords that none of them matched should
 * not claim the ranking was keyword-driven.
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
