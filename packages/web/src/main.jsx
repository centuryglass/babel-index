import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createLayout, shuffledOrder, rankByEmbedding } from '../../map/ordering.js';
import { joinMetadata } from '../../map/metadata.js';
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
  const { cam, flyTo } = useMapCamera({
    canvasRef,
    resistanceAt,
    onChange: requestDraw,
    camera: config.camera,
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
  const runSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) {
      setSearchOrder(null);
      setStatus('');
      return;
    }
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`).then((r) => r.json());
    // A real search returns a query vector and the browser ranks; the stub
    // returns a ready-made order. The vector path needs the blob to have loaded.
    if (res.vector && embeddings.current) {
      const { data, dim } = embeddings.current;
      setSearchOrder(rankByEmbedding(data, dim, Float32Array.from(res.vector)));
      setStatus('');
    } else {
      setSearchOrder(res.order);
      setStatus(res.stub ? 'stub ranking — no CLIP in offline mode' : '');
    }
    flyTo(0, 0);
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
          {status || 'drag to pan, scroll to zoom. the edge resists.'}
        </div>
      </div>
      <div className="hud" id="hud" />
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
