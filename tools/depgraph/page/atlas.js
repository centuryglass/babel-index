/* ===================================================================
   Babel Dependency Atlas — two force-directed graphs over one canvas.
   Data is measured, not declared: the npm side walks node_modules on
   disk, the repo side parses every ESM import in the source tree.
   =================================================================== */
'use strict';

const $ = (id) => document.getElementById(id);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- formatting ---------- */
const fmtBytes = (b) => {
  if (!b) return '0';
  if (b >= 1048576) return (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' kB';
  return b + ' B';
};
const fmtNum = (n) => n.toLocaleString('en-US');
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ===================================================================
   View construction
   =================================================================== */

const RAMP = ['--d0', '--d1', '--d2', '--d3', '--d4', '--d5', '--d6', '--d7'];

function buildNpmView() {
  const src = DATA.npm;
  const nodes = src.nodes.map((n, i) => ({
    i,
    label: n.n,
    sub: n.r ? 'this repository' : n.v ? 'v' + n.v : '',
    root: !!n.r,
    depth: n.d,
    bytes: n.b,
    fanIn: n.fi,
    fanOut: n.fo,
    prod: !!n.p,
    owners: n.o,
    path: n.path,
    search: (n.n + ' ' + (n.path || '')).toLowerCase(),
  }));
  const maxB = Math.max(...nodes.map((n) => n.bytes));
  for (const n of nodes) {
    n.r = n.root ? 15 : 4.2 + 21 * Math.pow(n.bytes / maxB, .42);
    n.rUniform = n.root ? 12 : 6;
    n.ramp = Math.min(7, Math.max(0, n.depth));
  }
  const links = src.edges.map(([s, t, k]) => ({ s, t, dev: k === 1, optional: k === 2 }));
  return {
    key: 'npm', nodes, links,
    // a node is "dev only" when no prod path from the root reaches it
    devOnly: (n) => !n.prod && !n.root,
  };
}

function buildInternalView() {
  const src = DATA.internal;
  const pkgs = [...new Set(src.nodes.map((n) => n.pkg))].sort();
  const nodes = src.nodes.map((n, i) => {
    const slash = n.n.lastIndexOf('/');
    return {
      i,
      label: n.n.slice(slash + 1),
      sub: n.n,
      pkg: n.pkg,
      loc: n.loc,
      bytes: n.b,
      fanIn: n.fi,
      fanOut: n.fo,
      test: !!n.t,
      external: false,
      search: n.n.toLowerCase(),
    };
  });
  // outside imports become their own peripheral nodes, off by default
  const extIds = new Map();
  const extLinks = [];
  for (const [from, spec, kind] of src.ext) {
    if (!extIds.has(spec)) {
      extIds.set(spec, nodes.length);
      nodes.push({
        i: nodes.length, label: spec, sub: kind === 'builtin' ? 'node built-in' : 'npm package',
        pkg: '(outside)', loc: 0, bytes: 0, fanIn: 0, fanOut: 0, test: false,
        external: true, builtin: kind === 'builtin', search: spec.toLowerCase(),
      });
    }
    extLinks.push({ s: from, t: extIds.get(spec), external: true });
  }
  for (const l of extLinks) nodes[l.t].fanIn++;

  const maxFanIn = Math.max(...nodes.filter((n) => !n.external).map((n) => n.fanIn));
  const maxLoc = Math.max(...nodes.map((n) => n.loc));
  for (const n of nodes) {
    n.r = n.external ? 5 : 4 + 15 * Math.sqrt(n.loc / maxLoc);
    n.rUniform = n.external ? 5 : 6;
    n.ramp = n.external ? 7 : Math.round((1 - n.fanIn / maxFanIn) * 7);
  }
  const links = src.edges.map(([s, t]) => ({ s, t })).concat(extLinks);
  return { key: 'internal', nodes, links, pkgs, maxFanIn };
}

/* ===================================================================
   Force simulation — plain O(n²), which is nothing at this size
   =================================================================== */

function makeSim(view) {
  const N = view.nodes.length;
  const P = view.nodes.map((n, i) => {
    const a = (i / N) * Math.PI * 2 * 7;
    const rad = 60 + 200 * Math.sqrt(i / N);
    return { x: Math.cos(a) * rad, y: Math.sin(a) * rad, vx: 0, vy: 0, fixed: false };
  });

  // cluster anchors give the repo view its package neighbourhoods, so a file's
  // package is read off its position and a printed label, never off a hue
  let anchors = null;
  if (view.key === 'internal') {
    anchors = new Map();
    view.pkgs.forEach((p, i) => {
      const a = (i / view.pkgs.length) * Math.PI * 2 - Math.PI / 2;
      anchors.set(p, { x: Math.cos(a) * 330, y: Math.sin(a) * 330 });
    });
    anchors.set('(outside)', { x: 0, y: 0 });
  }

  const deg = new Array(N).fill(0);
  for (const l of view.links) { deg[l.s]++; deg[l.t]++; }

  let alpha = 1;
  const REPEL = view.key === 'npm' ? 4200 : 3600;

  function tick() {
    // repulsion
    for (let i = 0; i < N; i++) {
      const a = P[i];
      for (let j = i + 1; j < N; j++) {
        const b = P[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-4) { dx = (Math.random() - .5) * .1; dy = (Math.random() - .5) * .1; d2 = 1e-4; }
        if (d2 > 640000) continue;
        const f = REPEL / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    // springs
    for (const l of view.links) {
      const a = P[l.s], b = P[l.t];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || .01;
      const rest = l.external ? 70 : 58;
      const k = l.external ? .008 : .022 / Math.sqrt(Math.min(deg[l.s], deg[l.t]) || 1);
      const f = (d - rest) * k;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    // gravity, and per-package pull in the repo view
    for (let i = 0; i < N; i++) {
      const p = P[i];
      p.vx -= p.x * .0055; p.vy -= p.y * .0055;
      if (anchors) {
        const a = anchors.get(view.nodes[i].pkg);
        if (a) { p.vx += (a.x - p.x) * .030; p.vy += (a.y - p.y) * .030; }
      }
    }
    for (let i = 0; i < N; i++) {
      const p = P[i];
      if (p.fixed) { p.vx = 0; p.vy = 0; continue; }
      p.vx *= .80; p.vy *= .80;
      p.x += p.vx * alpha; p.y += p.vy * alpha;
    }
    alpha *= .9885;
  }

  return {
    P, tick, anchors,
    get alpha() { return alpha; },
    reheat(v) { alpha = v ?? .7; },
    settle(n) { for (let i = 0; i < n; i++) tick(); },
  };
}

/* ===================================================================
   Reachability, used by both the subtree tracer and click-to-isolate
   =================================================================== */

function makeAdj(view) {
  const out = view.nodes.map(() => []);
  const inn = view.nodes.map(() => []);
  for (const l of view.links) { out[l.s].push(l.t); inn[l.t].push(l.s); }
  return { out, inn };
}
function reach(adj, start) {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) for (const n of adj[q.shift()]) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return seen;
}

/* ===================================================================
   State
   =================================================================== */

const VIEWS = { npm: buildNpmView(), internal: buildInternalView() };
const SIMS = {};
const ADJ = {};
for (const k of Object.keys(VIEWS)) { SIMS[k] = makeSim(VIEWS[k]); ADJ[k] = makeAdj(VIEWS[k]); }

const state = {
  view: 'npm',
  cam: { k: 1, tx: 0, ty: 0 },
  hover: -1,
  selected: -1,
  focus: null,          // a traced subtree: {label, set:Set}
  query: '',
  opts: { hideDev: false, uniform: false, hideTests: false, showOutside: false },
  sort: { npm: { col: 'bytes', dir: -1 }, internal: { col: 'fanIn', dir: -1 } },
};

const view = () => VIEWS[state.view];
const sim = () => SIMS[state.view];
const adj = () => ADJ[state.view];

/* which nodes are currently drawn at all */
function visibleSet() {
  const v = view();
  const vis = new Set();
  v.nodes.forEach((n, i) => {
    if (state.view === 'npm' && state.opts.hideDev && v.devOnly(n)) return;
    if (state.view === 'internal' && state.opts.hideTests && n.test) return;
    if (state.view === 'internal' && !state.opts.showOutside && n.external) return;
    vis.add(i);
  });
  return vis;
}

/* which nodes are emphasised (everything else is dimmed but still drawn) */
function activeSet(vis) {
  const v = view();
  let act = null;
  if (state.focus) act = state.focus.set;
  if (state.selected >= 0) {
    const a = adj();
    const down = reach(a.out, state.selected);
    for (const u of a.inn[state.selected]) down.add(u);
    act = act ? new Set([...down].filter((x) => act.has(x))) : down;
  }
  if (state.query) {
    const q = state.query;
    const hit = new Set();
    v.nodes.forEach((n, i) => { if (n.search.includes(q)) hit.add(i); });
    act = act ? new Set([...act].filter((x) => hit.has(x))) : hit;
  }
  if (!act) return null;
  return new Set([...act].filter((x) => vis.has(x)));
}

/* ===================================================================
   Rendering
   =================================================================== */

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = Math.max(1, Math.round(rect.width));
  H = Math.max(1, Math.round(rect.height));
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  draw();
}

const toScreen = (p) => ({ x: p.x * state.cam.k + state.cam.tx, y: p.y * state.cam.k + state.cam.ty });

function fitToContent(animate) {
  const vis = visibleSet();
  const P = sim().P;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of vis) {
    const p = P[i];
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  if (!isFinite(x0)) return;
  const pad = 56;
  const k = Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0));
  state.cam.k = Math.max(.12, Math.min(3, k));
  state.cam.tx = W / 2 - ((x0 + x1) / 2) * state.cam.k;
  state.cam.ty = H / 2 - ((y0 + y1) / 2) * state.cam.k;
  if (animate !== false) draw();
}

// getComputedStyle is expensive; the ramp is resolved once per frame instead
let RAMP_CACHE = null;
const nodeFill = (n) => RAMP_CACHE[n.ramp];

function draw() {
  const v = view();
  const P = sim().P;
  const vis = visibleSet();
  const act = activeSet(vis);
  const k = state.cam.k;

  $('empty').classList.toggle('on', act !== null && act.size === 0);

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);

  RAMP_CACHE = RAMP.map(css);
  const ground = css('--ground');
  const inkRule = css('--rule-strong');
  const ink = css('--ink');
  const ink2 = css('--ink-2');
  const ink3 = css('--ink-3');
  const accent = css('--accent');
  const ring = css('--node-ring');

  // package neighbourhood labels, under everything
  const pkgLabelBoxes = [];
  if (state.view === 'internal' && sim().anchors) {
    ctx.font = `600 ${Math.max(10, Math.min(15, 11 * k))}px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.textAlign = 'center';
    for (const [pkg, a] of sim().anchors) {
      if (pkg === '(outside)' && !state.opts.showOutside) continue;
      const members = [];
      for (const i of vis) if (v.nodes[i].pkg === pkg) members.push(P[i]);
      if (!members.length) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity;
      for (const p of members) {
        const q = toScreen(p);
        x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y);
      }
      const text = pkg + '/';
      const w = ctx.measureText(text).width;
      const cx = Math.max(w / 2 + 8, Math.min(W - w / 2 - 8, (x0 + x1) / 2));
      const cy = Math.max(14, y0 - 18);
      ctx.fillStyle = ink3;
      ctx.fillText(text, cx, cy);
      pkgLabelBoxes.push({ x0: cx - w / 2 - 4, y0: cy - 9, x1: cx + w / 2 + 4, y1: cy + 9 });
    }
    ctx.textAlign = 'left';
  }

  // edges
  for (const l of v.links) {
    if (!vis.has(l.s) || !vis.has(l.t)) continue;
    const live = !act || (act.has(l.s) && act.has(l.t));
    const a = toScreen(P[l.s]), b = toScreen(P[l.t]);
    const touchesHover = state.hover === l.s || state.hover === l.t;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    if (touchesHover) { ctx.strokeStyle = accent; ctx.globalAlpha = .9; ctx.lineWidth = 1.6; }
    else if (live) { ctx.strokeStyle = inkRule; ctx.globalAlpha = act ? .8 : .62; ctx.lineWidth = 1; }
    else { ctx.strokeStyle = inkRule; ctx.globalAlpha = .12; ctx.lineWidth = 1; }
    ctx.setLineDash(l.dev || l.external ? [3, 3] : []);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // nodes
  const labelled = [];
  for (const i of vis) {
    const n = v.nodes[i];
    const p = toScreen(P[i]);
    const r = Math.max(2.2, (state.opts.uniform ? n.rUniform : n.r) * Math.min(1.5, Math.max(.55, k)));
    const live = !act || act.has(i);
    ctx.globalAlpha = live ? 1 : .16;

    ctx.beginPath();
    if (n.external) {
      ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
    } else {
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    if (n.test || n.external) {
      // hollow: a form difference, so "is this a test file" never rides on hue
      ctx.fillStyle = ground;
      ctx.fill();
      ctx.strokeStyle = nodeFill(n); ctx.lineWidth = 1.6; ctx.stroke();
    } else {
      ctx.fillStyle = nodeFill(n);
      ctx.fill();
      ctx.strokeStyle = ring; ctx.lineWidth = 1; ctx.stroke();
    }
    if (n.root) { ctx.strokeStyle = accent; ctx.lineWidth = 2.5; ctx.stroke(); }
    if (state.view === 'npm' && v.devOnly(n) && !state.opts.hideDev) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (i === state.hover || i === state.selected) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const named = n.root || (state.view === 'npm' && n.depth === 1) || r > 9;
    if (live && (named || k > 1.5 || i === state.hover || i === state.selected)) {
      labelled.push({ n, p, r, strong: n.root || i === state.hover || i === state.selected });
    }
  }

  // labels last, so they sit above the mesh. A label that would collide with
  // one already placed is dropped rather than overlapped - at this density
  // overlapping labels are worse than missing ones, and the table has them all.
  ctx.font = `500 11px 'JetBrains Mono', ui-monospace, monospace`;
  ctx.textBaseline = 'middle';
  const placed = pkgLabelBoxes;
  labelled.sort((a, b) => (b.strong - a.strong) || (b.r - a.r));
  for (const L of labelled) {
    const t = L.n.label;
    const w = ctx.measureText(t).width;
    // try the right of the node first, then the left
    for (const box of [
      { x: L.p.x + L.r + 6, y: L.p.y },
      { x: L.p.x - L.r - 6 - w, y: L.p.y },
    ]) {
      const r = { x0: box.x - 3, y0: box.y - 8, x1: box.x + w + 3, y1: box.y + 8 };
      if (r.x1 > W || r.x0 < 0 || r.y0 < 0 || r.y1 > H) continue;
      if (placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) continue;
      placed.push(r);
      ctx.fillStyle = ground;
      ctx.globalAlpha = .84;
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = L.strong ? ink : ink2;
      ctx.fillText(t, box.x, box.y);
      break;
    }
  }
  ctx.textBaseline = 'alphabetic';
}

/* animation loop while the layout is still moving */
let raf = 0;
function loop() {
  raf = 0;
  const s = sim();
  if (s.alpha > .004) {
    for (let i = 0; i < 2; i++) s.tick();
    draw();
    raf = requestAnimationFrame(loop);
  } else {
    draw();
  }
}
const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

/* ===================================================================
   Pointer interaction
   =================================================================== */

let drag = null;

function nodeAt(sx, sy) {
  const v = view(), P = sim().P, vis = visibleSet();
  let best = -1, bestD = Infinity;
  for (const i of vis) {
    const p = toScreen(P[i]);
    const r = Math.max(6, (state.opts.uniform ? v.nodes[i].rUniform : v.nodes[i].r) * Math.min(1.5, Math.max(.55, state.cam.k)) + 4);
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d < r && d < bestD) { best = i; bestD = d; }
  }
  return best;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture?.(e.pointerId);
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const hit = nodeAt(sx, sy);
  drag = { sx, sy, x0: sx, y0: sy, node: hit, moved: false, tx: state.cam.tx, ty: state.cam.ty };
  if (hit >= 0) sim().P[hit].fixed = true;
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (drag) {
    if (Math.hypot(sx - drag.x0, sy - drag.y0) > 3) drag.moved = true;
    if (drag.node >= 0) {
      const p = sim().P[drag.node];
      p.x = (sx - state.cam.tx) / state.cam.k;
      p.y = (sy - state.cam.ty) / state.cam.k;
      sim().reheat(Math.max(sim().alpha, .35));
      kick();
    } else {
      state.cam.tx = drag.tx + (sx - drag.x0);
      state.cam.ty = drag.ty + (sy - drag.y0);
      draw();
    }
    return;
  }
  const hit = nodeAt(sx, sy);
  if (hit !== state.hover) { state.hover = hit; showTooltip(hit, sx, sy); draw(); }
  else if (hit >= 0) placeTooltip(sx, sy);
});

function endDrag(e) {
  if (!drag) return;
  if (drag.node >= 0) {
    sim().P[drag.node].fixed = false;
    if (!drag.moved) {
      state.selected = state.selected === drag.node ? -1 : drag.node;
      syncCanvasAlt();
    }
  } else if (!drag.moved) {
    state.selected = -1;
    syncCanvasAlt();
  }
  drag = null;
  canvas.classList.remove('dragging');
  draw();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { state.hover = -1; $('tooltip').classList.remove('on'); draw(); });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const factor = Math.exp(-e.deltaY * .0016);
  const k2 = Math.max(.1, Math.min(6, state.cam.k * factor));
  const ratio = k2 / state.cam.k;
  state.cam.tx = sx - (sx - state.cam.tx) * ratio;
  state.cam.ty = sy - (sy - state.cam.ty) * ratio;
  state.cam.k = k2;
  draw();
}, { passive: false });

/* ---------- tooltip ---------- */
function placeTooltip(sx, sy) {
  const tip = $('tooltip');
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(Math.max(8, sx + 16), Math.max(8, W - w - 8)) + 'px';
  tip.style.top = Math.min(Math.max(8, sy + 16), Math.max(8, H - h - 8)) + 'px';
}

function showTooltip(i, sx, sy) {
  const tip = $('tooltip');
  if (i < 0) { tip.classList.remove('on'); return; }
  const n = view().nodes[i];
  let rows = '';
  const row = (k, v) => { rows += `<dt>${k}</dt><dd>${v}</dd>`; };
  if (state.view === 'npm') {
    if (!n.root) {
      row('Depth', n.depth === 1 ? 'declared directly' : n.depth + ' hops from package.json');
      row('Own size', fmtBytes(n.bytes));
    }
    row('Depended on by', n.root ? '—' : fmtNum(n.fanIn));
    row('Depends on', fmtNum(n.fanOut));
    if (!n.root) row('Reached via', n.prod ? 'a runtime path' : 'dev only');
  } else if (n.external) {
    row('Imported by', fmtNum(n.fanIn) + ' file' + (n.fanIn === 1 ? '' : 's'));
  } else {
    row('Lines', fmtNum(n.loc));
    row('Imported by', fmtNum(n.fanIn));
    row('Imports', fmtNum(n.fanOut));
    row('Kind', n.test ? 'test' : 'source');
  }
  let why = '';
  if (state.view === 'npm' && !n.root && n.owners.length) {
    why = `<div class="tt-why">Pulled in by <b>${n.owners.join('</b>, <b>')}</b></div>`;
  } else if (state.view === 'internal' && !n.external && n.fanOut === 0 && !n.test) {
    why = `<div class="tt-why">A leaf — imports nothing inside the repo.</div>`;
  }
  tip.innerHTML =
    `<div class="tt-name">${n.label}</div>` +
    (n.sub ? `<div class="tt-sub">${n.sub}</div>` : '') +
    `<dl class="tt-rows">${rows}</dl>` + why;
  tip.classList.add('on');
  placeTooltip(sx, sy);
}

/* ===================================================================
   Rail: figures, legend, subtree tracer, filters
   =================================================================== */

const NPM_STATS = (() => {
  const v = VIEWS.npm;
  const real = v.nodes.filter((n) => !n.root);
  const declared = v.links.filter((l) => l.s === 0).length;
  return {
    declared,
    installed: real.length,
    edges: v.links.length,
    bytes: real.reduce((s, n) => s + n.bytes, 0),
    maxDepth: Math.max(...real.map((n) => n.depth)),
    dev: real.filter((n) => !n.prod).length,
  };
})();

const INT_STATS = (() => {
  const v = VIEWS.internal;
  const files = v.nodes.filter((n) => !n.external);
  return {
    files: files.length,
    source: files.filter((n) => !n.test).length,
    tests: files.filter((n) => n.test).length,
    edges: DATA.internal.edges.length,
    loc: files.reduce((s, n) => s + n.loc, 0),
    srcLoc: files.filter((n) => !n.test).reduce((s, n) => s + n.loc, 0),
    leaves: files.filter((n) => !n.test && n.fanOut === 0).length,
    outside: v.nodes.filter((n) => n.external).length,
  };
})();

const FIGURES = {
  npm: [
    { v: NPM_STATS.declared, k: 'declared in package.json' },
    { v: NPM_STATS.installed, k: 'actually installed' },
    { v: fmtBytes(NPM_STATS.bytes), k: 'on disk, unpacked' },
    { v: NPM_STATS.maxDepth, k: 'deepest hop from the root' },
    { v: NPM_STATS.edges, k: 'dependency edges' },
    { v: 0, k: 'circular dependencies' },
  ],
  internal: [
    { v: INT_STATS.files, k: 'source files' },
    { v: INT_STATS.edges, k: 'import edges between them' },
    { v: fmtNum(INT_STATS.srcLoc), k: 'lines, excluding tests' },
    { v: INT_STATS.tests, k: 'of those files are tests' },
    { v: INT_STATS.leaves, k: 'leaves that import nothing' },
    { v: 0, k: 'circular imports' },
  ],
};

const THESIS = {
  npm: `Eight dependencies are declared. <b>${NPM_STATS.installed}</b> get installed, weighing <b>${fmtBytes(NPM_STATS.bytes)}</b> — and almost all of that weight is two ONNX runtimes, while almost all of the <em>density</em> is Express's ${VIEWS.npm.nodes.filter((n) => n.owners.includes('express')).length} single-purpose packages.`,
  internal: `The repo imports itself along <b>${INT_STATS.edges}</b> edges across <b>${INT_STATS.files}</b> files. Nothing is circular, and <b>${INT_STATS.leaves}</b> modules import nothing at all — the pure core the project's notes keep insisting on.`,
};

const ENCODING = {
  npm: 'Circle area is the package\'s own unpacked size. A dashed orange ring marks a package no runtime path reaches — dev only.',
  internal: 'Circle area is the file\'s line count. Hollow circles are test files; squares are imports that leave the repo. Files are clustered by package and labelled in place.',
};

const RAMP_ENDS = {
  npm: ['declared directly', `${NPM_STATS.maxDepth} hops deep`],
  internal: [`depended on by ${VIEWS.internal.maxFanIn}`, 'depended on by none'],
};

const RAMP_ALT = {
  npm: 'Colour ramp: dark teal is a directly declared dependency, pale teal is deep in the transitive chain.',
  internal: 'Colour ramp: dark teal is a heavily depended-on module, pale teal is depended on by nothing.',
};

const CHECKS = {
  npm: [
    { id: 'hideDev', label: `Hide the ${NPM_STATS.dev} dev-only packages` },
    { id: 'uniform', label: 'Ignore size — draw every node the same' },
  ],
  internal: [
    { id: 'hideTests', label: `Hide the ${INT_STATS.tests} test files` },
    { id: 'showOutside', label: `Show the ${INT_STATS.outside} outside imports` },
  ],
};

function focusEntries() {
  if (state.view === 'npm') {
    const v = VIEWS.npm;
    return v.links.filter((l) => l.s === 0).map((l) => {
      const n = v.nodes[l.t];
      const set = reach(ADJ.npm.out, l.t);
      const bytes = [...set].reduce((s, i) => s + v.nodes[i].bytes, 0);
      return { label: n.label, meta: `${set.size} · ${fmtBytes(bytes)}`, set, sort: bytes };
    }).sort((a, b) => b.sort - a.sort);
  }
  const v = VIEWS.internal;
  return v.pkgs.map((p) => {
    const set = new Set();
    v.nodes.forEach((n, i) => { if (n.pkg === p) set.add(i); });
    const loc = [...set].reduce((s, i) => s + v.nodes[i].loc, 0);
    return { label: p + '/', meta: `${set.size} · ${fmtNum(loc)} ln`, set, sort: loc };
  }).sort((a, b) => b.sort - a.sort);
}

function renderRail() {
  $('thesis').innerHTML = THESIS[state.view];
  $('encoding-note').textContent = ENCODING[state.view];
  $('ramp-lo').textContent = RAMP_ENDS[state.view][0];
  $('ramp-hi').textContent = RAMP_ENDS[state.view][1];
  $('ramp').setAttribute('aria-label', RAMP_ALT[state.view]);
  $('ramp').innerHTML = RAMP.map((r) => `<span style="background:var(${r})"></span>`).join('');
  $('focus-note').textContent = state.view === 'npm'
    ? 'Everything one declared dependency drags in, counted and weighed.'
    : 'Each package in the repo, by files and lines.';

  $('figures').innerHTML = FIGURES[state.view]
    .map((f) => `<div class="figure"><div class="v">${f.v}</div><div class="k">${f.k}</div></div>`).join('');

  const keyRows = state.view === 'npm'
    ? [['<span style="display:block;width:12px;height:12px;border-radius:50%;background:var(--d1)"></span>', 'a runtime dependency'],
       ['<span style="display:block;width:12px;height:12px;border-radius:50%;border:1px dashed var(--accent)"></span>', 'dev only — dashed ring and edge'],
       ['<span style="display:block;width:12px;height:12px;border-radius:50%;border:2px solid var(--accent)"></span>', 'babel-index itself']]
    : [['<span style="display:block;width:12px;height:12px;border-radius:50%;background:var(--d1)"></span>', 'a source module'],
       ['<span style="display:block;width:12px;height:12px;border-radius:50%;border:1.6px solid var(--d4)"></span>', 'a test file'],
       ['<span style="display:block;width:11px;height:11px;border:1.6px solid var(--d7)"></span>', 'react, express, node: built-ins']];
  $('keys').innerHTML = keyRows.map(([sw, t]) => `<div class="key"><span class="swatch">${sw}</span>${t}</div>`).join('');

  const entries = focusEntries();
  $('focus-list').innerHTML = entries.map((e, i) =>
    `<button class="focus-item" data-focus="${i}" aria-pressed="${state.focus && state.focus.label === e.label}">
       <span class="fi-name">${e.label}</span><span class="fi-meta">${e.meta}</span>
     </button>`).join('');
  $('focus-list').querySelectorAll('[data-focus]').forEach((b) => {
    b.addEventListener('click', () => {
      const e = entries[+b.dataset.focus];
      state.focus = (state.focus && state.focus.label === e.label) ? null : { label: e.label, set: e.set };
      state.selected = -1;
      renderRail(); renderTable(); draw(); syncCanvasAlt();
    });
  });

  $('checks').innerHTML = CHECKS[state.view].map((c) =>
    `<label class="check"><input type="checkbox" data-opt="${c.id}" ${state.opts[c.id] ? 'checked' : ''}>${c.label}</label>`).join('');
  $('checks').querySelectorAll('[data-opt]').forEach((el) => {
    el.addEventListener('change', () => {
      state.opts[el.dataset.opt] = el.checked;
      sim().reheat(.45); kick(); renderTable(); syncCanvasAlt();
    });
  });
}

/* ===================================================================
   Table — the non-visual route to the same data
   =================================================================== */

const COLUMNS = {
  npm: [
    { id: 'label', t: 'Package', cls: 'name', get: (n) => n.label },
    { id: 'sub', t: 'Version', cls: 'mono', get: (n) => n.sub },
    { id: 'depth', t: 'Depth', cls: 'num', num: true, get: (n) => (n.root ? '—' : n.depth) },
    { id: 'bytes', t: 'Own size', cls: 'num', num: true, get: (n) => (n.root ? '—' : fmtBytes(n.bytes)) },
    { id: 'fanIn', t: 'Depended on by', cls: 'num', num: true, get: (n) => (n.root ? '—' : n.fanIn) },
    { id: 'fanOut', t: 'Depends on', cls: 'num', num: true, get: (n) => n.fanOut },
    { id: 'prod', t: 'Reached via', cls: '', get: (n) => (n.root ? '' : n.prod ? '<span class="pill">runtime</span>' : '<span class="pill dev">dev only</span>') },
    { id: 'owners', t: 'Pulled in by', cls: 'mono', get: (n) => n.owners.join(', ') || '—' },
  ],
  internal: [
    { id: 'sub', t: 'File', cls: 'name', get: (n) => n.sub },
    { id: 'pkg', t: 'Package', cls: 'mono', get: (n) => n.pkg },
    { id: 'loc', t: 'Lines', cls: 'num', num: true, get: (n) => (n.external ? '—' : fmtNum(n.loc)) },
    { id: 'fanIn', t: 'Imported by', cls: 'num', num: true, get: (n) => n.fanIn },
    { id: 'fanOut', t: 'Imports', cls: 'num', num: true, get: (n) => (n.external ? '—' : n.fanOut) },
    { id: 'test', t: 'Kind', cls: '', get: (n) => (n.external ? '<span class="pill">outside</span>' : n.test ? '<span class="pill dev">test</span>' : '<span class="pill">source</span>') },
  ],
};

function renderTable() {
  const cols = COLUMNS[state.view];
  const sort = state.sort[state.view];
  const vis = visibleSet();
  const q = state.query;
  let rows = view().nodes.filter((n, i) => vis.has(i) && (!q || n.search.includes(q)));
  if (state.focus) rows = rows.filter((n) => state.focus.set.has(n.i));

  const raw = (n, id) => {
    const val = n[id];
    return typeof val === 'string' ? val.toLowerCase() : typeof val === 'boolean' ? (val ? 1 : 0) : (val ?? 0);
  };
  rows.sort((a, b) => {
    const x = raw(a, sort.col), y = raw(b, sort.col);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });

  $('thead').innerHTML = '<tr>' + cols.map((c) =>
    `<th class="${c.num ? 'num' : ''}" data-col="${c.id}" scope="col" aria-sort="${
      sort.col === c.id ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}">${c.t}</th>`).join('') + '</tr>';
  $('thead').querySelectorAll('[data-col]').forEach((th) => {
    th.addEventListener('click', () => {
      const c = th.dataset.col;
      if (sort.col === c) sort.dir *= -1; else { sort.col = c; sort.dir = -1; }
      renderTable();
    });
  });

  $('tbody').innerHTML = rows.map((n) =>
    '<tr>' + cols.map((c) => `<td class="${c.cls}">${c.get(n)}</td>`).join('') + '</tr>').join('');

  $('table-note').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'}` +
    (q || state.focus ? ' matching the current filter' : '') + ' · click a heading to sort';
}

/* ===================================================================
   Accessible description of whatever the canvas currently shows
   =================================================================== */

function syncCanvasAlt() {
  const v = view();
  const vis = visibleSet();
  const act = activeSet(vis);
  const shown = act ?? vis;
  const top = [...shown].map((i) => v.nodes[i])
    .sort((a, b) => (state.view === 'npm' ? b.bytes - a.bytes : b.fanIn - a.fanIn))
    .slice(0, 5).map((n) => n.label).join(', ');
  const what = state.view === 'npm'
    ? `${NPM_STATS.installed} installed npm packages linked by ${NPM_STATS.edges} dependency edges`
    : `${INT_STATS.files} source files linked by ${INT_STATS.edges} import edges`;
  $('canvas-alt').textContent =
    `Force-directed graph of ${what}. ${shown.size} shown` +
    (state.focus ? `, traced to ${state.focus.label}` : '') +
    (state.query ? `, filtered by "${state.query}"` : '') +
    `. Most prominent: ${top}. The full data is in the table below.`;
}

/* ===================================================================
   View switching and boot
   =================================================================== */

function setView(key) {
  state.view = key;
  state.hover = -1; state.selected = -1; state.focus = null; state.query = '';
  $('search').value = '';
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === key)));
  $('stage').setAttribute('aria-labelledby', 'tab-' + key);
  $('tooltip').classList.remove('on');
  renderRail(); renderTable(); syncCanvasAlt();
  fitToContent(); draw();
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

// the canvas is a mouse instrument; these keys are the equivalent route in,
// with the table below as the real non-visual answer
canvas.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 120 : 40;
  const zoom = (f) => {
    const k2 = Math.max(.1, Math.min(6, state.cam.k * f));
    const ratio = k2 / state.cam.k;
    state.cam.tx = W / 2 - (W / 2 - state.cam.tx) * ratio;
    state.cam.ty = H / 2 - (H / 2 - state.cam.ty) * ratio;
    state.cam.k = k2;
  };
  switch (e.key) {
    case 'ArrowLeft':  state.cam.tx += step; break;
    case 'ArrowRight': state.cam.tx -= step; break;
    case 'ArrowUp':    state.cam.ty += step; break;
    case 'ArrowDown':  state.cam.ty -= step; break;
    case '+': case '=': zoom(1.25); break;
    case '-': case '_': zoom(1 / 1.25); break;
    case '0': fitToContent(); break;
    case 'Escape': state.selected = -1; state.focus = null; renderRail(); syncCanvasAlt(); break;
    default: return;
  }
  e.preventDefault();
  draw();
});

$('search').addEventListener('input', (e) => {
  state.query = e.target.value.trim().toLowerCase();
  renderTable(); draw(); syncCanvasAlt();
});
$('reset').addEventListener('click', () => {
  state.selected = -1; state.focus = null; state.query = ''; $('search').value = '';
  renderRail(); renderTable(); fitToContent(); draw(); syncCanvasAlt();
});
$('reheat').addEventListener('click', () => {
  for (const p of sim().P) p.fixed = false;
  sim().reheat(.85); kick();
});

$('tabc-npm').textContent = NPM_STATS.installed;
$('tabc-internal').textContent = INT_STATS.files;
$('provenance').textContent = `npm tree walked ${DATA.stamp}`;
$('colophon-text').innerHTML =
  `Both graphs are measured rather than declared. The npm side walks every <code>package.json</code> under ` +
  `<code>node_modules</code> after a clean install and resolves each dependency the way Node does, ` +
  `by climbing the <code>node_modules</code> chain — so a nested copy is attributed to the nested copy, ` +
  `and the ${NPM_STATS.installed} packages here match <code>npm ls --all</code> exactly. The repo side parses every ` +
  `static and dynamic ESM import in the ${INT_STATS.files} source files and resolves the relative ones on disk. ` +
  `Sizes are each package's own unpacked files, excluding its nested dependencies, so they sum without double counting. ` +
  `Cycles were checked with Tarjan's algorithm on both graphs; there are none in either.`;

new ResizeObserver(() => resize()).observe($('stage'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw());

// settle each layout before it is ever shown, so a view opens composed
for (const k of Object.keys(SIMS)) SIMS[k].settle(REDUCED ? 700 : 260);
resize();
setView('npm');
if (!REDUCED) kick();
