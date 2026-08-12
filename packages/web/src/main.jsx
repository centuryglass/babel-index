import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createLayout, shuffledOrder } from '../../map/ordering.js';
import { pxPerCell } from './camera.js';
import { createTileCache } from './tiles.js';
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

  const [roomCount, setRoomCount] = useState(total);
  const [contentRatio, setContentRatio] = useState(0.2);
  const [seed, setSeed] = useState(1);
  const [orderSeed, setOrderSeed] = useState(1);
  const [searchOrder, setSearchOrder] = useState(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');

  // Both of these are runtime parameters: changing either re-derives the
  // layout without touching a single byte of downloaded image data.
  const layout = useMemo(
    () => createLayout({ roomCount: Math.min(roomCount, total), contentRatio, seed }),
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

  const cache = useMemo(
    () => createTileCache({ budget: 240, onLoad: () => requestDraw() }),
    [requestDraw]
  );

  const resistanceAt = useCallback((x, y) => layout.resistanceAt(x, y), [layout]);
  const { cam, flyTo } = useMapCamera({ canvasRef, resistanceAt, onChange: requestDraw });

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
      ctx.fillStyle = '#0a0908';
      ctx.fillRect(0, 0, w, h);

      const { x: cx, y: cy, zoom } = cam.current;
      // Pixels per cell on each axis. The cell is the world's base unit and is
      // not assumed square, so every size below comes from here rather than
      // from `zoom` twice.
      const cellPx = pxPerCell(cam.current);
      const halfW = w / 2 / cellPx.x;
      const halfH = h / 2 / cellPx.y;
      const x0 = Math.floor(cx - halfW);
      const x1 = Math.ceil(cx + halfW);
      const y0 = Math.floor(cy - halfH);
      const y1 = Math.ceil(cy + halfH);

      const toScreen = (wx, wy) => [(wx - cx) * cellPx.x + w / 2, (wy - cy) * cellPx.y + h / 2];

      // +1 kills hairline gaps from rounding, on each axis independently.
      const cw = cellPx.x + 1;
      const ch = cellPx.y + 1;

      let drawn = 0;
      let missing = 0;
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const [sx, sy] = toScreen(gx, gy);
          const cell = layout.roomAt(gx, gy, order);
          const url = cell.centre
            ? manifest.generic.url
            : cell.generic
              ? manifest.generic.url
              : manifest.rooms[cell.id]?.url;

          const img = url ? cache.get(url) : null;
          if (img) {
            ctx.drawImage(img, sx, sy, cw, ch);
            drawn++;
          } else {
            ctx.fillStyle = '#15120f';
            ctx.fillRect(sx, sy, cw, ch);
            missing++;
          }

          if (cell.centre) {
            ctx.strokeStyle = 'rgba(200,169,95,0.9)';
            ctx.lineWidth = 2;
            ctx.strokeRect(sx + 1, sy + 1, cellPx.x - 2, cellPx.y - 2);
            if (zoom > 90) {
              ctx.fillStyle = 'rgba(200,169,95,0.95)';
              ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
              ctx.fillText('the centre', sx + 10, sy + 22);
            }
          } else if (!cell.generic && zoom > 120) {
            ctx.fillStyle = 'rgba(232,224,210,0.55)';
            ctx.font = '11px ui-monospace, monospace';
            ctx.fillText(`#${cell.rank}`, sx + 8, sy + 18);
          }
        }
      }

      const hud = document.getElementById('hud');
      if (hud) {
        const cells = (x1 - x0 + 1) * (y1 - y0 + 1);
        hud.textContent =
          `${cells} cells · ${drawn} drawn · ${missing} loading · ` +
          `${cache.size()} cached · zoom ${Math.round(zoom)} · ` +
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
  }, [layout, order, manifest, cache, cam]);

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
    setSearchOrder(res.order);
    setStatus(res.stub ? 'stub ranking — no CLIP in offline mode' : '');
    flyTo(0, 0);
  };

  return (
    <>
      <canvas ref={canvasRef} />
      <div className="panel">
        <h1>The Indexing of Babel</h1>
        <p className="sub">
          offline · {total} rooms in {manifest.directory.split('/').slice(-1)[0]}
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
          <button onClick={() => flyTo(0, 0, 220)}>centre</button>
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
