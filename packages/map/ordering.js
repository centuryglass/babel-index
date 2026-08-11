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
 * Build the map layout.
 *
 * @param {object} opts
 * @param {number} opts.roomCount     how many distinct rooms are in play
 * @param {number} [opts.contentRatio] fraction of cells that may hold one
 *                                     (0.2 => the concept's "80% generic")
 * @param {number} [opts.seed]        scatter seed for slot placement
 * @returns {MapLayout}
 */
export function createLayout({ roomCount, contentRatio = 0.2, seed = 0 } = {}) {
  if (!Number.isInteger(roomCount) || roomCount < 0)
    throw new RangeError('roomCount must be a non-negative integer');
  if (!(contentRatio > 0 && contentRatio <= 1))
    throw new RangeError('contentRatio must be in (0, 1]');

  const slots = collectSlots(roomCount, contentRatio, seed);

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
     * @param {number} softness how many cells the falloff spans
     */
    resistanceAt(x, y, softness = 12) {
      const d = Math.hypot(x, y);
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
 */
function collectSlots(count, contentRatio, seed) {
  if (count === 0) return [];
  // Expected slot density is contentRatio per cell, so a disc of area
  // count/contentRatio should hold roughly `count` of them. Start a little
  // wide, then grow if the hash happened to be sparse here.
  let radius = Math.ceil(Math.sqrt(count / (contentRatio * Math.PI)) * 1.35) + 4;

  for (let attempt = 0; attempt < 24; attempt++) {
    const found = [];
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        const d = Math.hypot(x, y);
        if (d > radius) continue;
        if (isContentSlot(x, y, { seed, contentRatio })) found.push({ x, y, d });
      }
    }
    if (found.length >= count) {
      // Sort by distance; break ties by angle so the ordering is deterministic
      // and fills rings evenly rather than favouring one axis.
      found.sort((a, b) => a.d - b.d || Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
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
 * Rank rooms against a query vector. Embeddings are int8-quantized and stored
 * contiguously; scoring the whole corpus is a few million multiply-adds, which
 * is well under a frame for corpora of this size.
 *
 * @param {Int8Array} embeddings  roomCount * dim, row-major
 * @param {number} dim
 * @param {Float32Array} query    length dim, already L2-normalised
 * @returns {number[]} room ids, best first
 */
export function rankByEmbedding(embeddings, dim, query) {
  const n = Math.floor(embeddings.length / dim);
  const scored = new Array(n);
  for (let i = 0; i < n; i++) {
    let dot = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d++) dot += embeddings[base + d] * query[d];
    scored[i] = { id: i, score: dot };
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.id);
}
