/**
 * Text scoring for search: keywords and story against a query.
 *
 * Separate from `ordering.js` because it is the only meaty string code in the
 * package - folding, tokenising, stopwords - and that file is worth keeping as
 * arithmetic. The blend that combines these with CLIP lives here too, since the
 * normalisation it depends on is the whole reason the weights mean anything.
 *
 * ### Why every signal is normalised before it is weighted
 *
 * The three signals are not remotely on the same scale. Keyword and story scores
 * are ratios and land in [0, 1] by construction. A CLIP cosine is nominally
 * [-1, 1], but on a corpus of near-identical library walls the scores for one
 * query cluster into a narrow band - the images differ far less than CLIP's
 * range allows - so the raw number is a poor thing to weight. Blend it as-is and
 * there is no weight that works: large enough to matter and any keyword bonus
 * still swamps it, small enough to balance one and it is lost inside its own
 * spread.
 *
 * So the CLIP term is min-max normalised across the corpus *for that query*: one
 * extra pass over an array that has just been scored anyway, after which a
 * weight of 0.25 really does mean "a quarter of what a perfect keyword match is
 * worth". See `packages/config` for the weights themselves.
 *
 * ### One sort, not tiers
 *
 * Everything is ranked by the blended score. Bucketing - exact matches first,
 * then CLIP within the remainder - would let a room with one weak partial
 * keyword beat a room CLIP is certain about, and would break the thing the map
 * is for: the whole library rearranging, best in the middle and worst at the
 * edge, rather than a few results spliced to the front of an unchanged order.
 *
 * ### Ranking is relative; certainty is not
 *
 * The blend answers "which room is most like the query". The map's density
 * gradient (`ordering.js`) asks a different question - "how sure are we at all"
 * - and the blended score cannot answer it, because min-max normalisation
 * destroys exactly the information required: some room always scores 1, whether
 * the query was `art nouveau` or `cghjj`. Certainty is therefore computed from
 * the *absolute* form of each signal, alongside the ranking and from the same
 * pass:
 *
 *   - keyword and story ratios are already absolute. An exact keyword match is
 *     1 because it is a match, not because it beat the corpus.
 *   - CLIP contributes its raw cosine against a pair of thresholds. This is the
 *     only place the raw number is used rather than the normalised one, and it
 *     is the reason `embeddingScores` dequantises: a nonsense string still
 *     produces a valid text vector, and what marks it as nonsense is that its
 *     cosine against every image is low in absolute terms, not that the spread
 *     between images vanished.
 *
 * The thresholds are the one part of this that genuinely wants calibrating
 * against a real corpus, which is the argument for them living in config.
 *
 * No DOM. Two imports: the dot products it would otherwise duplicate, and a
 * Porter stemmer - stemming free text is exactly the kind of thing that is
 * unwise to reimplement, and `stemmer` is a zero-dependency ~13KB module.
 */
import { stemmer } from 'stemmer';
import { embeddingScores } from './ordering.js';

/**
 * Raw-cosine bounds for CLIP's share of certainty: at or below `low` it is
 * saying nothing, at or above `high` it is as sure as it gets.
 *
 * Starting values for CLIP ViT-B/32, where image-text cosines run roughly 0.10
 * to 0.15 for a string the image has nothing to do with and 0.30 upward for a
 * good match - narrowed at the bottom because a corpus of near-identical
 * library walls sits higher than a corpus of arbitrary photographs. Overridable,
 * and worth measuring once there are real queries to measure against.
 */
export const CLIP_CERTAINTY = { low: 0.18, high: 0.3 };

/**
 * Words carrying no retrieval signal, dropped from queries.
 *
 * Short and ASCII on purpose. This is not a linguistic resource, it is a guard
 * against a query like "the room of glass" spending two thirds of its weight on
 * "the" and "of" - and, for keywords, against `the` scoring a partial match
 * against `theatrical`.
 */
export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'was', 'are', 'its',
  'into', 'onto', 'their', 'them', 'they', 'has', 'had', 'have', 'been', 'were',
  'but', 'not', 'all', 'any', 'some', 'more', 'most', 'such', 'than', 'then',
  'there', 'here', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where',
]);

/**
 * Lowercase, strip diacritics, collapse whitespace.
 *
 * Decomposing to NFD and dropping the combining marks means `rosé` and `rose`
 * are the same word, which matters for a corpus whose vocabulary is full of art
 * terms borrowed from French and German.
 */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // combining marks, after NFD
    .toLowerCase()
    .trim();
}

/**
 * Fold and split into searchable tokens.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.minLength] tokens shorter than this are dropped, or `a`
 *   matches most keywords in the corpus by substring
 * @param {boolean} [opts.stopwords] drop stopwords (true by default)
 */
export function tokenise(text, { minLength = 3, stopwords = true } = {}) {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= minLength && !(stopwords && STOPWORDS.has(t)));
}

/**
 * Build the per-room search index once, when metadata arrives.
 *
 * Folding and tokenising 5,000 stories on every query would be a megabyte and a
 * half of string work per search; doing it once at load leaves each query as set
 * lookups. Rooms without metadata stay null, so the array is still indexed by
 * room id.
 *
 * @param {(object|null)[]} joined output of `joinMetadata()`
 * @returns {({keywords: string[], story: Set<string>}|null)[]}
 */
export function buildSearchIndex(joined) {
  return (joined ?? []).map((entry) => {
    if (!entry) return null;
    return {
      // Folded but NOT tokenised: a keyword is matched whole as well as by
      // token, so that a query of "art nouveau" scores 1 against the keyword
      // "art nouveau" rather than the 0.45 its two tokens would average to.
      keywords: (entry.keywords ?? []).map((k) => fold(k.text)),
      // Stemmed, not just tokenised: a search matches a story word by stem, so
      // `cats` finds `cat` but `catalogue` does not. See `storyScore`.
      story: new Set(tokenise(entry.story ?? '').map(stemmer)),
    };
  });
}

/**
 * How well a query matches a room's keywords, in [0, 1].
 *
 * Two readings, and the better one wins:
 *
 *   - the whole query against the whole keyword, which is what makes an exact
 *     match score exactly 1 even when the keyword is two words long;
 *   - the mean over query tokens of each token's best keyword match, which is
 *     what lets a partial or reordered query score at all.
 *
 * A partial match is `matched length / keyword length`, so `art` against
 * `art nouveau` scores 3/11 and against `art` scores 1. Dividing by the KEYWORD
 * is deliberate: a short query matching a long keyword has matched less of it,
 * and should say so.
 *
 * The mean rather than the sum keeps the result in [0, 1] without clamping, and
 * rewards matching more *of the query* rather than rewarding longer queries.
 */
export function keywordScore(foldedQuery, queryTokens, keywords) {
  if (!keywords?.length) return 0;

  let whole = 0;
  if (foldedQuery)
    for (const k of keywords) {
      if (!k) continue;
      if (k === foldedQuery) {
        whole = 1;
        break;
      }
      if (k.includes(foldedQuery)) whole = Math.max(whole, foldedQuery.length / k.length);
    }

  let sum = 0;
  for (const token of queryTokens) {
    let best = 0;
    for (const k of keywords) {
      if (!k) continue;
      if (k === token) {
        best = 1;
        break;
      }
      if (k.includes(token)) best = Math.max(best, token.length / k.length);
    }
    sum += best;
  }
  const byToken = queryTokens.length ? sum / queryTokens.length : 0;

  return Math.max(whole, byToken);
}

/**
 * How well a query matches a room's story, in [0, 1].
 *
 * Normalised by the QUERY, not by the text - the opposite of the keyword rule,
 * and for a reason. Dividing a match by the length of the story would mean a
 * longer story scores lower for the same hit, which is backwards; what is being
 * asked is "how much of what you asked for is in here".
 *
 * Each token is weighted by its own length, so `cartographer` counts for more
 * than `oil`. Matching is by Porter stem, so `room` finds `rooms` and `survey`
 * finds `surveyed` - and, unlike the prefix rule it replaces, the reverse too -
 * while `cat` no longer matches `catalogue` the way a prefix test would. The
 * story index is stemmed once at build time (`buildSearchIndex`); the query's
 * few tokens are stemmed here, and weighting stays keyed to the ORIGINAL token
 * length so the query-normalisation above still holds.
 *
 * @param {string[]} queryTokens raw (folded, untokenised-past-splitting) tokens
 * @param {Set<string>} storyStems the room's story, stemmed
 */
export function storyScore(queryTokens, storyStems) {
  if (!storyStems?.size || !queryTokens.length) return 0;

  let matched = 0;
  let total = 0;
  for (const token of queryTokens) {
    total += token.length;
    if (storyStems.has(stemmer(token))) matched += token.length;
  }
  return total ? matched / total : 0;
}

/**
 * Min-max a score array onto [0, 1].
 *
 * A flat array carries no information, so it normalises to all-zero rather than
 * to all-one or a divide by zero: a signal that cannot distinguish anything
 * should not contribute a constant that outweighs one that can.
 *
 * @param {ArrayLike<number>} scores
 * @returns {Float32Array}
 */
export function normaliseScores(scores) {
  const out = new Float32Array(scores.length);
  if (!scores.length) return out;

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < min) min = scores[i];
    if (scores[i] > max) max = scores[i];
  }
  const span = max - min;
  if (!(span > 0)) return out;

  for (let i = 0; i < scores.length; i++) out[i] = (scores[i] - min) / span;
  return out;
}

/**
 * How sure the search is that one room is a match, in [0, 1].
 *
 * A soft OR of the three absolute readings: `1 - (1-k)(1-s)(1-c)`. Any one
 * signal can carry it on its own - an exact keyword match is certain whatever
 * CLIP thinks of the picture - and agreement between two weak ones counts for
 * more than either alone, which is the behaviour that reads correctly when a
 * partial keyword and a decent cosine land on the same room.
 *
 * Not the weighted blend used for ranking, and deliberately so: the weights say
 * which signal to *believe* when they disagree about an order, which is a
 * different question from how sure any of them is.
 *
 * @param {object} parts each in [0, 1] except `cosine`, which is a raw cosine
 * @param {number} [parts.keyword]
 * @param {number} [parts.story]
 * @param {number|null} [parts.cosine]
 * @param {{low: number, high: number}} [clip] raw-cosine bounds
 */
export function matchCertainty({ keyword = 0, story = 0, cosine = null }, clip = CLIP_CERTAINTY) {
  const span = clip.high - clip.low;
  // A degenerate band is "CLIP has no opinion worth reading" rather than a
  // divide by zero; the text signals still carry their own certainty.
  const c = cosine === null || !(span > 0) ? 0 : clamp01((cosine - clip.low) / span);
  const miss = (1 - clamp01(keyword)) * (1 - clamp01(story)) * (1 - c);
  return 1 - miss;
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Rank the whole corpus by the blend of whatever signals are available.
 *
 * Missing signals are omitted rather than substituted: no embedding blob means
 * the ranking is text-only and honest about it, and no metadata means it is
 * CLIP-only. Both are real rankings. Only the case where neither exists needs
 * the server's stub.
 *
 * @param {object} opts
 * @param {string} opts.query          the raw query string
 * @param {number} opts.count          rooms in the corpus
 * @param {object} opts.weights        `config.search.weights`
 * @param {number} [opts.minTokenLength]
 * @param {Int8Array} [opts.embeddings] the blob, roomCount * dim row-major
 * @param {number} [opts.dim]
 * @param {Float32Array|number[]} [opts.vector] the query vector, L2-normalised
 * @param {({keywords: string[], story: Set<string>}|null)[]} [opts.index]
 * @param {{low: number, high: number}} [opts.clipCertainty] raw-cosine bounds
 *   for CLIP's share of certainty
 * @returns {{order: number[], certainty: Float32Array,
 *            signals: {clip: boolean, keyword: boolean, story: boolean}}}
 *   `certainty` is parallel to `order`, i.e. by rank, which is how the map's
 *   density gradient wants it.
 */
export function rankHybrid({
  query,
  count,
  weights,
  minTokenLength = 3,
  embeddings = null,
  dim = 0,
  vector = null,
  index = null,
  clipCertainty = CLIP_CERTAINTY,
}) {
  const foldedQuery = fold(query);
  const queryTokens = tokenise(query, { minLength: minTokenLength });

  // CLIP twice over, from one pass of dot products: raw cosines for certainty,
  // and the same column min-maxed for the blend. Two questions, two scalings -
  // see the header.
  let cosines = null;
  let clip = null;
  if (embeddings && dim > 0 && vector) {
    cosines = embeddingScores(embeddings, dim, Float32Array.from(vector));
    clip = normaliseScores(cosines);
  }

  const hasText = Boolean(index?.some(Boolean)) && (foldedQuery.length > 0 || queryTokens.length > 0);

  const scored = new Array(count);
  let sawKeyword = false;
  let sawStory = false;

  for (let id = 0; id < count; id++) {
    let score = 0;
    if (clip) score += weights.clip * (clip[id] ?? 0);

    let k = 0;
    let s = 0;
    if (hasText) {
      const entry = index[id];
      if (entry) {
        k = keywordScore(foldedQuery, queryTokens, entry.keywords);
        s = storyScore(queryTokens, entry.story);
        if (k > 0) sawKeyword = true;
        if (s > 0) sawStory = true;
        score += weights.keyword * k + weights.story * s;
      }
    }
    scored[id] = {
      id,
      score,
      certainty: matchCertainty(
        { keyword: k, story: s, cosine: cosines ? (cosines[id] ?? null) : null },
        clipCertainty
      ),
    };
  }

  // Stable sort, so rooms that every signal is silent about keep their id order
  // rather than shuffling for no reason the reader can see.
  scored.sort((a, b) => b.score - a.score);

  const certainty = new Float32Array(count);
  for (let rank = 0; rank < count; rank++) certainty[rank] = scored[rank].certainty;

  return {
    order: scored.map((s) => s.id),
    certainty,
    signals: { clip: Boolean(clip), keyword: sawKeyword, story: sawStory },
  };
}
