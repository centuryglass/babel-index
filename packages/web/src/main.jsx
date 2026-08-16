import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createLayout, shuffledOrder } from '../../map/ordering.js';
import { joinMetadata } from '../../map/metadata.js';
import { buildSearchIndex, rankHybrid } from '../../map/scoring.js';
import { buildRearrangement } from '../../map/board.js';
import { planMoves, applyMove } from '../../map/illusion.js';
import { roomAtPoint } from './picking.js';
import { CELL_ASPECT, pxPerCell } from './camera.js';
import { createTileCache, GENERIC } from './tiles.js';
import { createUrlFor } from './rooms.js';
import { createRenderer } from './render.js';
import { createSlideshow, createSlideRenderer } from './slide.js';
import { FALLBACK_LEVEL, sizeOf as pyramidSizeOf } from './pyramid.js';
import { useMapCamera } from './useMapCamera.js';

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
  const layout = useMemo(
    () =>
      createLayout({
        roomCount: Math.min(roomCount, total),
        contentRatio,
        seed,
        aspect: CELL_ASPECT,
        density: result?.certainty
          ? { ...config.search.density, certainty: result.certainty }
          : null,
      }),
    [roomCount, contentRatio, seed, total, result, config]
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
    // Pinned and preloaded at its coarsest: 12 KB that guarantees every cell
    // has something to draw, however little of its own room has arrived.
    tiles.pin(GENERIC);
    tiles.request(GENERIC, FALLBACK_LEVEL);
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

  // `?touchdebug` puts the raw pointer stream on screen. A gesture can only
  // really be judged on a device, and a phone has no console you can read with
  // both thumbs busy - so this is how "what did the browser actually send"
  // stays answerable without a USB cable.
  const onDebug = useMemo(() => (TOUCH_DEBUG ? appendTouchLog : undefined), []);

  const { cam, flyTo } = useMapCamera({
    canvasRef,
    resistanceAt,
    onChange: requestDraw,
    camera: config.camera,
    onPick,
    onDebug,
  });

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
            })
          : renderer.draw({
              ctx, width: w, height: h, dpr, cam: cam.current,
              layout: showing.layout, order: showing.order,
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
  }, [layout, order, renderer, slideRenderer, cache, cam]);

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

  // A chip on the card is a live search: reading a room becomes a way of moving
  // through the library rather than a dead end. The card closes because the map
  // is about to rearrange under it, and it would be describing a cell that no
  // longer holds that room.
  const searchKeyword = (text) => {
    setQuery(text);
    setCard(null);
    search(text);
  };

  return (
    <>
      <canvas ref={canvasRef} />
      <div className="panel">
        <h1>The Indexing of Babel</h1>
        <p className="sub">
          offline · {total} rooms in {manifest.directory.split('/').slice(-1)[0]}
          {described > 0 && <> · {described} described</>}
        </p>

        <form onSubmit={runSearch} className="row">
          <input
            type="search"
            placeholder="search the library…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>

        <div className="row">
          <label>
            rooms on the map <b>{Math.min(roomCount, total)}</b>
          </label>
          <input
            type="range" min="1" max={total} value={Math.min(roomCount, total)}
            onChange={(e) => setRoomCount(Number(e.target.value))}
          />
        </div>

        <div className="row">
          <label>
            non-generic <b>{Math.round(contentRatio * 100)}%</b>
          </label>
          <input
            type="range" min="2" max="100" value={Math.round(contentRatio * 100)}
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

        <div className="note">
          {status || 'drag to pan, scroll to zoom. right-click a room.'}
        </div>
      </div>
      <div className="hud" id="hud" />
      {TOUCH_DEBUG && <div className="touchlog" id="touchlog" />}
      {card && (
        <RoomCard
          card={card}
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
function RoomCard({ card, entry, file, onClose, onKeyword }) {
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

  return (
    <div className="card" ref={ref} style={pos} role="dialog" aria-label="room">
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

      {entry?.story && <p className="story">{entry.story}</p>}

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
