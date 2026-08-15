/**
 * Where does each room sit on the infinite map?
 *
 * Corpus size and the generic-room ratio are both *runtime* parameters here,
 * not build-time ones. Changing either re-derives the layout in O(slots) with
 * no data reload and no change to what the client has downloaded, so they can
 * be wired to sliders and tuned by feel.
 *
 * The scheme:
 *
 *   - Every cell is either a *content slot* or a copy of the generic base room.
 *     Which one is decided by a seeded hash of the coordinate, so it is stable,
 *     needs no storage, and extends to infinity in every direction.
 *   - Content slots are ordered by distance from the origin. A ranking (from
 *     CLIP, from manual score, or shuffled) is poured into that ordering, so
 *     rank 0 lands in the slot nearest the centre.
 *   - Re-ranking after a search swaps one array. Slot positions never move,
 *     which is what makes the re-order read as the library rearranging itself
 *     rather than as a page reload.
 *
 * ### Distance is measured as it looks, not as it indexes
 *
 * This file is otherwise shape-blind - it deals in cells and has no idea what a
 * cell looks like - with one deliberate exception: `aspect`, the cell's height
 * as a multiple of its width. Every distance here is `hypot(x, y * aspect)`,
 * which is the offset in units of cell WIDTHS, i.e. proportional to what ends
 * up on screen.
 *
 * The reason is that a circle in cell space is an ellipse on screen as soon as
 * the cell stops being square, and the boundary is a navigation affordance: the
 * distance you may travel before the map resists should not depend on which way
 * you set off. Measuring in raw cells would be simpler, but it would make the
 * library taller-or-wider than it is round, and the edge would arrive sooner on
 * one axis than the other.
 *
 * Placement uses the same metric, and has to. A circular boundary drawn around
 * an elliptical spread of rooms would be a circle with nothing in the top and
 * bottom of it - free panning over empty generic space, which is worse than the
 * ellipse. One metric, both jobs.
 *
 * `aspect` defaults to 1, so a caller that has no opinion gets exactly the
 * square-cell behaviour, and nothing else in this file needs to know why.
 */

/** 32-bit spatial hash -> [0, 1). Stable across platforms. */
export function cellHash(x, y, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 13), 0x85ebca6b);
  h = Math.imul((h ^ (seed | 0)) >>> 0, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The origin is reserved for the centre room - the one with the search box and
 * the hidden controls painted into it (concept.md steps 5-6). It is never a
 * corpus slot, so ranked rooms begin in the ring around it.
 */
export const isCentre = (x, y) => x === 0 && y === 0;

/** Is this cell allowed to hold a ranked corpus room? */
export const isContentSlot = (x, y, { seed = 0, contentRatio = 0.2 } = {}) =>
  !isCentre(x, y) && cellHash(x, y, seed) < contentRatio;

/**
 * Distance from the origin in units of cell WIDTHS - the metric everything in
 * this file sorts and clamps by. With a square cell it is plain `hypot`.
 */
export const cellDistance = (x, y, aspect = 1) => Math.hypot(x, y * aspect);

/**
 * Build the map layout.
 *
 * @param {object} opts
 * @param {number} opts.roomCount     how many distinct rooms are in play
 * @param {number} [opts.contentRatio] fraction of cells that may hold one
 *                                     (0.2 => the concept's "80% generic")
 * @param {number} [opts.seed]        scatter seed for slot placement
 * @param {number} [opts.aspect]      cell height / cell width; 1 for a square
 *                                    cell. Makes the library round on screen
 *                                    rather than round in the index.
 * @returns {MapLayout}
 */
export function createLayout({ roomCount, contentRatio = 0.2, seed = 0, aspect = 1 } = {}) {
  if (!Number.isInteger(roomCount) || roomCount < 0)
    throw new RangeError('roomCount must be a non-negative integer');
  if (!(contentRatio > 0 && contentRatio <= 1))
    throw new RangeError('contentRatio must be in (0, 1]');
  if (!(aspect > 0 && Number.isFinite(aspect)))
    throw new RangeError('aspect must be a positive, finite ratio');

  const slots = collectSlots(roomCount, contentRatio, seed, aspect);

  // Reverse index: cell -> rank position. Bounded by roomCount, so small.
  const rankAt = new Map();
  slots.forEach((s, i) => rankAt.set(key(s.x, s.y), i));

  // Radius of the outermost occupied slot: the edge the user is discouraged
  // from crossing, since there is nothing but generic rooms beyond it.
  const boundaryRadius = slots.length ? slots[slots.length - 1].d : 0;

  return {
    slots,
    boundaryRadius,
    contentRatio,
    seed,
    roomCount,
    aspect,

    /** Rank position of a cell, or -1 if it holds a generic room. */
    rankOf(x, y) {
      const r = rankAt.get(key(x, y));
      return r === undefined ? -1 : r;
    },

    /**
     * What is drawn at this cell.
     * @param {number[]} order room ids, best-first (from search, score, shuffle)
     * @returns {{centre: true} | {generic: true} | {generic: false, id: number, rank: number}}
     */
    roomAt(x, y, order) {
      if (isCentre(x, y)) return { centre: true };
      const rank = this.rankOf(x, y);
      if (rank === -1 || rank >= order.length) return { generic: true };
      return { generic: false, id: order[rank], rank };
    },

    /** Cell coordinates for a given rank, for "fly to the best match". */
    cellOfRank(rank) {
      const s = slots[rank];
      return s ? { x: s.x, y: s.y } : null;
    },

    /**
     * Pan resistance. 1 inside the content region, falling smoothly toward 0
     * outside it, so the edge is felt rather than hit.
     *
     * Both the distance and `softness` are in cell widths, so the edge arrives
     * at the same apparent distance whichever way you drag - that uniformity is
     * the whole reason this file knows the aspect at all.
     *
     * @param {number} softness how far the falloff spans, in cell widths
     */
    resistanceAt(x, y, softness = 12) {
      const d = cellDistance(x, y, aspect);
      if (d <= boundaryRadius) return 1;
      const t = Math.min(1, (d - boundaryRadius) / softness);
      return (1 - t) ** 3;
    },
  };
}

/**
 * Gather the `count` content slots nearest the origin, ordered by distance.
 * Grows the search radius until enough are found, so it stays correct at any
 * contentRatio without a magic constant.
 *
 * `radius` is in cell widths, so the region swept is a screen-circle: it
 * reaches `radius` cells across but `radius / aspect` cells up and down. A
 * short cell means more rows to cover the same apparent distance, which is
 * also why the density estimate below carries the aspect.
 */
function collectSlots(count, contentRatio, seed, aspect = 1) {
  if (count === 0) return [];
  // A screen-circle of radius r spans r x r/aspect cells, so it contains
  // pi * r^2 / aspect of them, and at density contentRatio that holds
  // contentRatio * pi * r^2 / aspect slots. Invert for r, start a little wide,
  // then grow if the hash happened to be sparse here.
  let radius = Math.ceil(Math.sqrt((count * aspect) / (contentRatio * Math.PI)) * 1.35) + 4;

  for (let attempt = 0; attempt < 24; attempt++) {
    const found = [];
    const xMax = Math.ceil(radius);
    const yMax = Math.ceil(radius / aspect);
    for (let y = -yMax; y <= yMax; y++) {
      for (let x = -xMax; x <= xMax; x++) {
        const d = cellDistance(x, y, aspect);
        if (d > radius) continue;
        if (isContentSlot(x, y, { seed, contentRatio })) found.push({ x, y, d });
      }
    }
    if (found.length >= count) {
      // Sort by distance; break ties by angle so the ordering is deterministic
      // and fills rings evenly rather than favouring one axis. The angle is the
      // on-screen one, for the same reason the distance is.
      found.sort(
        (a, b) => a.d - b.d || Math.atan2(a.y * aspect, a.x) - Math.atan2(b.y * aspect, b.x)
      );
      return found.slice(0, count);
    }
    radius = Math.ceil(radius * 1.4);
  }
  throw new Error('could not place all rooms; contentRatio may be too small');
}

const key = (x, y) => `${x},${y}`;

/**
 * A shuffled ordering, for the "reorder the library" control.
 * @param {number} n number of rooms
 * @param {number} seed
 */
export function shuffledOrder(n, seed = 1) {
  const order = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) ^ (s >>> 7)) >>> 0;
    return s / 4294967296;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Score every room against a query vector. Embeddings are int8-quantized and
 * stored contiguously; scoring the whole corpus is a few million multiply-adds,
 * which is well under a frame for corpora of this size.
 *
 * Scores rather than an order, because the hybrid blend in `scoring.js` needs
 * the numbers to normalise before weighting. `rankByEmbedding` is the CLIP-only
 * ordering built on top, so the dot product has one implementation.
 *
 * @param {Int8Array} embeddings  roomCount * dim, row-major
 * @param {number} dim
 * @param {Float32Array} query    length dim, already L2-normalised
 * @returns {Float32Array} one raw cosine per room, indexed by id
 */
export function embeddingScores(embeddings, dim, query) {
  const n = Math.floor(embeddings.length / dim);
  const scores = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let dot = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d++) dot += embeddings[base + d] * query[d];
    scores[i] = dot;
  }
  return scores;
}

/**
 * Rank rooms against a query vector, best first.
 *
 * @param {Int8Array} embeddings  roomCount * dim, row-major
 * @param {number} dim
 * @param {Float32Array} query    length dim, already L2-normalised
 * @returns {number[]} room ids, best first
 */
export function rankByEmbedding(embeddings, dim, query) {
  const scores = embeddingScores(embeddings, dim, query);
  const scored = Array.from(scores, (score, id) => ({ id, score }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.id);
}
