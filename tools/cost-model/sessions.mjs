/**
 * How many HTTP requests does one visit to the library cost?
 *
 * The question this answers is a billing one. Cloudflare R2 charges per GET
 * operation and not per byte, so the pyramid - which exists to cut bytes - is
 * on the wrong side of the meter, and "does it cost more requests than it
 * saves" needs a number rather than an intuition.
 *
 * The method: replay realistic camera paths over the REAL layout
 * (`packages/map/ordering.js`) and the REAL level policy
 * (`packages/web/src/pyramid.js`), and count DISTINCT urls. Distinct is the
 * right unit because a url fetched twice in one session is served from the
 * browser's HTTP cache the second time and never reaches R2 - provided the
 * objects are sent immutable, which is the assumption this whole model rests
 * on. The in-memory LRU in `tiles.js` evicting a tile therefore costs a decode,
 * not an operation.
 *
 * What is modelled is the pyramid as *planned* (pyramid.js drives the fetches),
 * not as currently wired - the render loop still fetches level 0 for every
 * cell. That is the point: this is the number that decides whether to finish
 * wiring it.
 *
 * Everything here is arithmetic over the two modules it imports. No DOM, no
 * network, no images.
 */
import { createLayout, shuffledOrder } from '../../packages/map/ordering.js';
import { createPyramid } from '../../packages/web/src/pyramid.js';

/**
 * The tile the corpus is moving to, and the world shape that follows from it.
 * Stated here rather than imported so the model can be run against a shape the
 * repo has not adopted yet - which is exactly the case at the moment.
 */
export const TILE = { w: 1024, h: 768 };
export const CELL_ASPECT = TILE.h / TILE.w;

/** A viewport, in CSS pixels, plus the device pixel ratio the render loop caps at. */
export const VIEWPORT = { w: 1440, h: 900, dpr: 2 };

/** The camera's clamps, mirrored from camera.js. */
export const MIN_ZOOM = 26;
export const MAX_ZOOM = 900;

/** Prefetch ring, mirrored from pyramid.js PREFETCH. */
export const MARGIN = 2;

/**
 * The cells the render loop covers at a camera, inclusive - the same
 * floor/ceil arithmetic main.jsx uses, plus the prefetch ring, because a cell
 * in the ring is fetched and so is billed exactly like a visible one.
 */
export function boundsAt(cam, viewport = VIEWPORT, margin = MARGIN) {
  const perCellX = cam.zoom;
  const perCellY = cam.zoom * CELL_ASPECT;
  const halfW = viewport.w / 2 / perCellX;
  const halfH = viewport.h / 2 / perCellY;
  return {
    x0: Math.floor(cam.x - halfW) - margin,
    x1: Math.ceil(cam.x + halfW) + margin,
    y0: Math.floor(cam.y - halfH) - margin,
    y1: Math.ceil(cam.y + halfH) + margin,
  };
}

/**
 * A session: a set of distinct urls, accumulated as camera positions are
 * visited. `visit` is what a settled frame costs; a pan is a run of visits.
 *
 * The url key is `${room}@${level}` - room being a corpus id or 'generic'.
 * Nothing here needs the actual path, only its identity.
 */
export function createSession({
  layout,
  order,
  pyramid,
  viewport = VIEWPORT,
  warmCoarser = true,
  atlas = new Map(),
}) {
  const urls = new Set();
  let cellVisits = 0;

  /**
   * Fetch one room at one level, if it has not been fetched this session.
   *
   * A level listed in `atlas` is served as whole-corpus sheets keyed by room
   * ID, so the url is the sheet's rather than the room's. Keying sheets by ID
   * and not by map position is the whole trick: the arrangement is mutable and
   * the ID is not, so a re-rank cannot invalidate a sheet.
   */
  const want = (room, level) => {
    const perSheet = atlas.get(level);
    if (perSheet && room !== 'generic')
      return urls.add(`sheet:${level}:${Math.floor(room / perSheet)}`);
    return urls.add(`${room}@${level}`);
  };

  const visit = (cam) => {
    const level = pyramid.idealLevel(cam.zoom * viewport.dpr);
    const levels = warmCoarser ? [level, ...pyramid.warmLevels(level)] : [level];
    const { x0, x1, y0, y1 } = boundsAt(cam, viewport);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cell = layout.roomAt(x, y, order);
        const room = cell.centre || cell.generic ? 'generic' : cell.id;
        cellVisits++;
        for (const l of levels) want(room, l);
      }
    }
  };

  /**
   * Pan from one camera to another, stepping a cell at a time so the swept
   * union is exact for a straight drag rather than a sample of it.
   */
  const panTo = (from, to) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      visit({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, zoom: to.zoom });
    }
    return { ...to };
  };

  /**
   * Zoom in place. Intermediate levels are paid for: a wheel gesture from far
   * out to close in crosses every band, and each crossing fetches the cells
   * that are on screen at that moment. Stepping by level rather than by frame
   * is what matters, since within a band nothing new is requested.
   */
  const zoomTo = (cam, zoom) => {
    const from = pyramid.idealLevel(cam.zoom * viewport.dpr);
    const to = pyramid.idealLevel(zoom * viewport.dpr);
    const dir = Math.sign(to - from);
    // Land on one representative zoom inside each band crossed, then the target.
    if (dir !== 0) {
      for (let l = from + dir; l !== to; l += dir) {
        const width = pyramid.sizeOf(l).w;
        visit({ ...cam, zoom: width / viewport.dpr });
      }
    }
    const next = { ...cam, zoom };
    visit(next);
    return next;
  };

  return {
    visit,
    panTo,
    zoomTo,
    /** A re-rank: same cells, different rooms in them. The screen refetches. */
    rerank: (cam, newOrder) => {
      order = newOrder;
      visit(cam);
    },
    setOrder: (o) => {
      order = o;
    },
    ops: () => urls.size,
    urls: () => urls,
    cellVisits: () => cellVisits,
    /** Ops split by level, which is what tells you where the bill comes from. */
    byLevel: () => {
      const counts = new Map();
      for (const u of urls) {
        const level = Number(u.split('@')[1]);
        counts.set(level, (counts.get(level) ?? 0) + 1);
      }
      return counts;
    },
  };
}

/**
 * The four visits worth costing. Times are what the path implies, not a claim
 * about real analytics - the shape of each is what matters: how far out the
 * camera goes, and how much ground it covers there.
 */
export const ARCHETYPES = {
  /** Arrives, looks at what is on screen, drags a little, leaves. */
  glance: (s, ctx) => {
    let cam = { x: 0.5, y: 0.5, zoom: 220 };
    s.visit(cam);
    cam = s.panTo(cam, { ...cam, x: 12, y: 6 });
    return cam;
  },

  /** Pulls back to see the shape of it, crosses some ground, looks at a few rooms. */
  browse: (s, ctx) => {
    let cam = { x: 0.5, y: 0.5, zoom: 220 };
    s.visit(cam);
    cam = s.zoomTo(cam, 60); // level 3 at dpr 2
    cam = s.panTo(cam, { ...cam, x: 40, y: 20 });
    for (const target of [{ x: 42, y: 21 }, { x: 46, y: 18 }, { x: 38, y: 24 }, { x: 44, y: 26 }]) {
      cam = s.zoomTo({ ...cam, ...target }, 600); // level 0
      cam = s.zoomTo(cam, 60);
    }
    return cam;
  },

  /** The reason the boundary exists: all the way out, all the way across. */
  survey: (s, ctx) => {
    let cam = { x: 0.5, y: 0.5, zoom: 220 };
    s.visit(cam);
    cam = s.zoomTo(cam, MIN_ZOOM); // level 4
    // Serpentine across the whole content region, a screen at a time.
    const r = ctx.layout.boundaryRadius;
    const stepX = (VIEWPORT.w / MIN_ZOOM) * 0.9;
    const stepY = (VIEWPORT.h / (MIN_ZOOM * CELL_ASPECT)) * 0.9;
    let dir = 1;
    for (let y = -r / CELL_ASPECT; y <= r / CELL_ASPECT; y += stepY) {
      for (let x = -r; x <= r; x += stepX) {
        cam = s.panTo(cam, { ...cam, x: dir > 0 ? x : -x, y });
      }
      dir = -dir;
    }
    return cam;
  },

  /** Survey, then search twice, then read twenty rooms up close. */
  scholar: (s, ctx) => {
    let cam = ARCHETYPES.survey(s, ctx);
    cam = s.zoomTo(cam, 220);
    cam = { ...cam, x: 0.5, y: 0.5 };
    for (const seed of [7, 11]) {
      s.rerank(cam, shuffledOrder(ctx.roomCount, seed));
      cam = s.zoomTo(cam, 60);
      cam = s.panTo(cam, { ...cam, x: 20, y: 10 });
      cam = s.zoomTo(cam, 220);
      cam = { ...cam, x: 0.5, y: 0.5 };
    }
    for (let i = 0; i < 20; i++) {
      const slot = ctx.layout.cellOfRank(i);
      cam = s.zoomTo({ ...cam, x: slot.x + 0.5, y: slot.y + 0.5 }, 600);
      cam = s.zoomTo(cam, 220);
    }
    return cam;
  },
};

/**
 * Run one archetype and report what it cost.
 *
 * @param {string} name key of ARCHETYPES
 * @param {object} [opts]
 * @param {number} [opts.roomCount]
 * @param {number} [opts.contentRatio]
 * @param {boolean} [opts.warmCoarser]  rule 2's warm-the-next-level-out pass
 * @param {Map<number, number>} [opts.atlas] level -> rooms per sheet, for
 *                                      levels served as sheets rather than
 *                                      per room
 * @param {object[]} [opts.levels]      ladder override; a single level models
 *                                      the no-pyramid baseline
 */
export function runArchetype(name, opts = {}) {
  const {
    roomCount = 5000,
    contentRatio = 0.2,
    warmCoarser = true,
    viewport = VIEWPORT,
    tile = TILE,
    atlas = new Map(),
    levels,
  } = opts;

  const pyramid = createPyramid(levels ? { base: tile, levels } : { base: tile });
  const layout = createLayout({ roomCount, contentRatio, seed: 1, aspect: tile.h / tile.w });
  const order = shuffledOrder(roomCount, 1);
  const session = createSession({ layout, order, pyramid, viewport, warmCoarser, atlas });
  const ctx = { layout, roomCount, contentRatio, pyramid };

  ARCHETYPES[name](session, ctx);

  return {
    name,
    ops: session.ops(),
    byLevel: session.byLevel(),
    cellVisits: session.cellVisits(),
    urls: session.urls(),
    layout,
    pyramid,
  };
}
