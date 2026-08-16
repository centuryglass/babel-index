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
 * ### The density gradient
 *
 * `contentRatio` is a *baseline*, not a constant. A search may hand in a
 * `density.certainty` array - one number per rank, in [0, 1] - and the
 * acceptance threshold for the rank being placed becomes
 * `contentRatio + (peak - contentRatio) * certainty`, so a rank the search is
 * sure about is allowed into nearly every cell it passes and a rank it knows
 * nothing about is scattered at the baseline. Walking outward with that
 * threshold turns a certainty profile directly into a density profile: certain
 * matches pack tight against the centre, and the packing loosens back to the
 * user's chosen sparseness exactly as fast as the search's confidence falls off.
 *
 * The point is that the sliders and the search stop fighting. At an 80% generic
 * map the top matches used to be scattered thinly enough to be invisible, so
 * the only way to *see* a search work was to turn the wallpaper off; now the
 * cluster is denser than its surroundings by construction, and a sparser
 * baseline makes it more legible rather than less.
 *
 * Three properties come out of the one formula rather than being special-cased:
 * a handful of exact matches fill the innermost cells and everything after them
 * falls straight back to the baseline (a hard edge); a signal that decays
 * gradually spreads the packing out gradually; and a query nothing is confident
 * about produces certainty 0 everywhere, which is the uniform layout, cell for
 * cell. Clearing the search drops the profile and restores it exactly.
 *
 * The cost is that a search now recomputes placement, which the uniform scheme
 * never did. It is the same O(slots) rebuild the ratio slider already triggers
 * on every drag, and the rooms still arrive in rank order from the centre out -
 * the map still reads as rearranging itself, with the density as one more thing
 * that rearranges.
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
 * Which wallpaper variant a generic cell shows.
 *
 * A stable, storage-free choice over the same `cellHash` machinery as
 * `isContentSlot`, but salted with its OWN seed: sharing `slotSeed` would
 * correlate the pattern of variants with the pattern of content slots, and the
 * two would be visible in each other. The choice depends only on the cell, not
 * on the search order, so a reorder never changes a generic cell's face - which
 * is exactly why the rearrangement animation can leave `board.js` treating every
 * generic as one interchangeable value.
 *
 * Returns -1 when there are no variants to choose from (an empty
 * `base_variations`), which the renderers read as "fall back to the base tile"
 * so the map still draws.
 *
 * @param {number} x
 * @param {number} y
 * @param {{seed?: number, count?: number}} [opts] count is how many variants exist
 * @returns {number} variant index in [0, count), or -1
 */
export const genericVariantAt = (x, y, { seed = 0, count = 0 } = {}) =>
  count > 0 ? Math.min(count - 1, Math.floor(cellHash(x, y, seed) * count)) : -1;

/**
 * Certainty below this is a hunch rather than a match, and clusters nothing.
 *
 * Without a floor, a query the corpus has no answer to still produces a faint
 * ranking - some room has to come first - and the faintest gradient would pull
 * it toward the centre, which would say "found it" about noise. The floor is
 * what makes "no match" and "no search" the same picture, which is the only
 * honest thing for them to look like.
 */
export const CERTAINTY_FLOOR = 0.05;

/**
 * Turn a per-rank certainty into a per-rank acceptance threshold.
 *
 * Two adjustments, both of which are about the profile meaning what it claims:
 *
 *   - certainty is made non-increasing with rank. The ordering is best-first by
 *     definition, so a rank that is *more* certain than the one above it is a
 *     contradiction, and the running minimum is which of the two to believe.
 *     Density then falls monotonically outward whatever shape the blend had.
 *   - anything under `floor` becomes exactly the baseline, not slightly above
 *     it. See CERTAINTY_FLOOR.
 *
 * @param {ArrayLike<number>|null} certainty per rank, in [0, 1]
 * @param {number} contentRatio the baseline density
 * @param {number} peak         density offered to a rank of certainty 1
 * @param {number} floor
 * @returns {(rank: number) => number} threshold for the rank being placed
 */
function densityRamp(certainty, contentRatio, peak, floor) {
  if (!certainty?.length) return () => contentRatio;

  // Never below the baseline: the gradient adds density near the centre, it
  // does not take any away from a map the user has already set the sparseness of.
  const top = Math.max(peak, contentRatio);
  const ramp = new Float64Array(certainty.length);
  let cap = 1;
  for (let i = 0; i < certainty.length; i++) {
    const raw = Number(certainty[i]);
    const c = Math.min(cap, Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0);
    cap = c;
    ramp[i] = c < floor ? contentRatio : contentRatio + (top - contentRatio) * c;
  }
  // Ranks past the profile are baseline, which is also what an absent profile
  // gives - so a short array is a partial gradient rather than an error.
  return (rank) => (rank < ramp.length ? ramp[rank] : contentRatio);
}

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
 * @param {number} [opts.variantCount] how many wallpaper variants exist, so a
 *                                    generic cell can be given one. 0 means the
 *                                    map has only the base tile to fall back on.
 * @param {number} [opts.variantSeed] salt for the variant choice, kept separate
 *                                    from `seed` - see `genericVariantAt`.
 * @param {object} [opts.density]     the search's density gradient, if a search
 *                                    is running. Absent - or with no certainty
 *                                    in it - is the uniform map, cell for cell.
 * @param {ArrayLike<number>} [opts.density.certainty] per rank, in [0, 1]
 * @param {number} [opts.density.peak]  density offered to a rank of certainty 1
 * @param {number} [opts.density.floor] certainty under which nothing clusters
 * @returns {MapLayout}
 */
export function createLayout({
  roomCount,
  contentRatio = 0.2,
  seed = 0,
  aspect = 1,
  variantCount = 0,
  variantSeed = 0,
  density = null,
} = {}) {
  if (!Number.isInteger(roomCount) || roomCount < 0)
    throw new RangeError('roomCount must be a non-negative integer');
  if (!Number.isInteger(variantCount) || variantCount < 0)
    throw new RangeError('variantCount must be a non-negative integer');
  if (!(contentRatio > 0 && contentRatio <= 1))
    throw new RangeError('contentRatio must be in (0, 1]');
  if (!(aspect > 0 && Number.isFinite(aspect)))
    throw new RangeError('aspect must be a positive, finite ratio');

  const ramp = densityRamp(
    density?.certainty,
    contentRatio,
    density?.peak ?? 1,
    density?.floor ?? CERTAINTY_FLOOR
  );

  const slots = collectSlots(roomCount, contentRatio, seed, aspect, ramp);

  // Reverse index: cell -> rank position. Bounded by roomCount, so small.
  const rankAt = new Map();
  slots.forEach((s, i) => rankAt.set(key(s.x, s.y), i));

  // Radius of the outermost occupied slot: the edge the user is discouraged
  // from crossing, since there is nothing but generic rooms beyond it.
  const boundaryRadius = slots.length ? slots[slots.length - 1].d : 0;

  // How many leading ranks the gradient actually lifts above the baseline -
  // the size of the cluster, and 0 for a uniform map. Certainty is monotone by
  // then, so counting until it stops is the whole answer.
  let gradedCount = 0;
  while (gradedCount < slots.length && ramp(gradedCount) > contentRatio) gradedCount++;

  return {
    slots,
    boundaryRadius,
    gradedCount,
    contentRatio,
    seed,
    roomCount,
    aspect,
    variantCount,
    variantSeed,

    /**
     * Which wallpaper variant a generic cell shows, in [0, variantCount), or -1
     * when there are none. Positional and order-independent - see
     * `genericVariantAt`. Only meaningful for a cell `roomAt` calls generic; the
     * centre draws the base tile, not a variant.
     */
    variantAt(x, y) {
      return genericVariantAt(x, y, { seed: variantSeed, count: variantCount });
    },

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
 *
 * The walk is what makes the gradient work: candidates are visited nearest
 * first, and each is offered to the rank currently being placed at *that rank's*
 * threshold, so a certain rank takes the first cell it meets and an uncertain
 * one waits for a cell the baseline hash lets through. With a flat ramp every
 * candidate is accepted and this is the old scan, cell for cell.
 *
 * @param {(rank: number) => number} ramp acceptance threshold per rank
 */
function collectSlots(count, contentRatio, seed, aspect = 1, ramp = () => contentRatio) {
  if (count === 0) return [];

  // Placing a rank costs about 1/density cells, so the whole run costs the sum
  // of that over the ranks. With a flat ramp the sum is count / contentRatio
  // and this is the estimate it always was; with a gradient it shrinks by
  // however much the middle of the map tightened.
  let cells = 0;
  for (let i = 0; i < count; i++) cells += 1 / ramp(i);
  let radius = radiusFor(cells, aspect);

  for (let attempt = 0; attempt < 24; attempt++) {
    // Every cell the baseline admits, and a tally of them per ring. These are
    // the slots the uniform map would have had; a gradient only ever adds to
    // them, which is what makes the tally a sound bound below.
    const rings = Math.ceil(radius) + 2;
    const reached = new Int32Array(rings + 1);
    const candidates = [];
    sweep(radius, aspect, (x, y, d) => {
      const h = cellHash(x, y, seed);
      if (h >= contentRatio) return;
      candidates.push({ x, y, d, h, a: Math.atan2(y * aspect, x) });
      reached[Math.floor(d)]++;
    });

    // Exclusive prefix: `reached[k]` is now a LOWER BOUND on the rank the walk
    // has got to by the time it reaches ring k, since every cell counted into
    // it lies strictly nearer and is taken whatever rank is current. The ramp
    // is non-increasing, so a lower bound on the rank gives an upper bound on
    // the threshold - which is what the extra sweep below can trust.
    for (let k = 0, total = 0; k <= rings; k++) {
      const here = reached[k];
      reached[k] = total;
      total += here;
    }

    // The cells only a graded rank could take: above the baseline, below the
    // threshold that rank still has. Past the ring where the bound has caught
    // up with the gradient there are none, so this sweep covers the cluster
    // rather than the map - and with no gradient it does not run at all.
    const coreRadius = gradedRadius(reached, ramp, contentRatio, rings);
    if (coreRadius > 0)
      sweep(Math.min(coreRadius, radius), aspect, (x, y, d) => {
        const h = cellHash(x, y, seed);
        if (h >= contentRatio && h < ramp(reached[Math.floor(d)]))
          candidates.push({ x, y, d, h, a: Math.atan2(y * aspect, x) });
      });

    // Sort by distance; break ties by angle so the ordering is deterministic
    // and fills rings evenly rather than favouring one axis. The angle is the
    // on-screen one, for the same reason the distance is, and it is computed
    // once per cell rather than twice per comparison.
    candidates.sort((p, q) => p.d - q.d || p.a - q.a);

    const found = [];
    for (const c of candidates) {
      if (c.h >= ramp(found.length)) continue;
      found.push({ x: c.x, y: c.y, d: c.d });
      if (found.length === count) return found;
    }
    radius = Math.ceil(radius * 1.4);
  }
  throw new Error('could not place all rooms; contentRatio may be too small');
}

/**
 * Radius, in cell widths, of a screen-circle holding `cells` cells - with a
 * margin, since the hash may happen to be sparse here and growing costs a full
 * re-sweep. A circle of radius r spans r x r/aspect cells, so it contains
 * pi * r^2 / aspect of them; this inverts that.
 */
const radiusFor = (cells, aspect) => Math.ceil(Math.sqrt((cells * aspect) / Math.PI) * 1.35) + 4;

/**
 * Visit every non-centre cell within `radius`, in no particular order.
 *
 * A screen-circle of radius r spans r cells across and r / aspect up and down,
 * so a short cell means more rows for the same apparent distance.
 */
function sweep(radius, aspect, visit) {
  const xMax = Math.ceil(radius);
  const yMax = Math.ceil(radius / aspect);
  for (let y = -yMax; y <= yMax; y++)
    for (let x = -xMax; x <= xMax; x++) {
      if (isCentre(x, y)) continue;
      const d = cellDistance(x, y, aspect);
      if (d <= radius) visit(x, y, d);
    }
}

/**
 * How far out the gradient can still be lifting the threshold above baseline.
 *
 * `reached` only grows and the ramp only falls, so once a ring's bound has
 * reached an ungraded rank every ring beyond it has too, and the answer is the
 * first such ring. 0 when there is no gradient at all.
 */
function gradedRadius(reached, ramp, contentRatio, rings) {
  for (let k = 0; k <= rings; k++) if (ramp(reached[k]) <= contentRatio) return k;
  return rings + 1;
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
 * The int8 half-range `tools/embed` quantises rows at. Dequantise as v / 127.
 *
 * Stated here because this is where the blob is read. Ranking never cared - a
 * monotone factor cannot reorder anything, and the blend min-maxes the column
 * anyway - but the density gradient asks how sure CLIP is *in absolute terms*,
 * and 0.3 is only a cosine once the quantisation is divided back out.
 */
export const EMBEDDING_SCALE = 127;

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
 * @returns {Float32Array} one cosine per room, indexed by id
 */
export function embeddingScores(embeddings, dim, query) {
  const n = Math.floor(embeddings.length / dim);
  const scores = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let dot = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d++) dot += embeddings[base + d] * query[d];
    // Both sides are unit vectors, so this is a cosine once the row's
    // quantisation is undone - and it has to be a real cosine, because
    // `scoring.js` compares it against absolute thresholds.
    scores[i] = dot / EMBEDDING_SCALE;
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
