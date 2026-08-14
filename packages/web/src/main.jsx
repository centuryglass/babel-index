import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createLayout, shuffledOrder } from '../../map/ordering.js';
import { joinMetadata } from '../../map/metadata.js';
import { buildSearchIndex, rankHybrid } from '../../map/scoring.js';
import { roomAtPoint } from './picking.js';
import { CELL_ASPECT } from './camera.js';
import { createTileCache, GENERIC } from './tiles.js';
import { createUrlFor } from './rooms.js';
import { createRenderer } from './render.js';
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
  const [searchOrder, setSearchOrder] = useState(null);
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
  const layout = useMemo(
    () =>
      createLayout({
        roomCount: Math.min(roomCount, total),
        contentRatio,
        seed,
        aspect: CELL_ASPECT,
      }),
    [roomCount, contentRatio, seed, total]
  );

  const order = useMemo(() => {
    const shuffled = shuffledOrder(total, orderSeed);
    if (!searchOrder) return shuffled;
    // A search ranks the whole corpus; the layout takes as many as it has slots.
    return searchOrder;
  }, [total, orderSeed, searchOrder]);

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

  const { cam, flyTo } = useMapCamera({
    canvasRef,
    resistanceAt,
    onChange: requestDraw,
    camera: config.camera,
    onPick,
  });

  // --- rendering -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    let pending = false;

    const render = () => {
      pending = false;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const stats = renderer.draw({
        ctx, width: w, height: h, dpr, cam: cam.current, layout, order,
      });

      const hud = document.getElementById('hud');
      if (hud) {
        const size = pyramidSizeOf(stats.level);
        const over = cache.overBudget();
        hud.textContent =
          `${stats.cells} cells · ${stats.drawn} drawn · ` +
          `level ${stats.level} (${size.w}px) · ${stats.substituted} substituted · ` +
          `${stats.blank} blank · ` +
          `${cache.size()} cached${over ? ` (+${over} over budget)` : ''} · ` +
          `zoom ${Math.round(stats.zoom)} · ` +
          `x ${cam.current.x.toFixed(1)} y ${cam.current.y.toFixed(1)} · ` +
          `edge at r=${layout.boundaryRadius.toFixed(1)}`;
      }
    };

    draw.current = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(render);
    };

    render();
    const onResize = () => draw.current();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [layout, order, renderer, cache, cam]);

  useEffect(() => requestDraw(), [layout, order, requestDraw]);

  // --- search --------------------------------------------------------------
  const search = async (term) => {
    if (!term.trim()) {
      setSearchOrder(null);
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
      const { order, signals } = rankHybrid({
        query: term,
        count: total,
        weights: config.search.weights,
        minTokenLength: config.search.minTokenLength,
        embeddings: blob?.data,
        dim: blob?.dim,
        vector: res.vector,
        index: searchIndex,
      });
      setSearchOrder(order);
      setStatus(describeSignals(signals, Boolean(searchIndex)));
    } else {
      setSearchOrder(res.order);
      setStatus('stub ranking — no embeddings and no keywords in this corpus');
    }
    flyTo(0, 0);
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
          <button onClick={() => setOrderSeed((s) => s + 1)}>reorder</button>
          <button onClick={() => setSeed((s) => s + 1)}>rescatter</button>
          <button onClick={() => flyTo(0, 0, config.camera.defaultZoom)}>centre</button>
        </div>

        <div className="note">
          {status || 'drag to pan, scroll to zoom. right-click a room.'}
        </div>
      </div>
      <div className="hud" id="hud" />
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
