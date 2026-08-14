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
 * No DOM. One import, for the dot products it would otherwise duplicate.
 */
import { embeddingScores } from './ordering.js';

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
      story: new Set(tokenise(entry.story ?? '')),
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
 * than `oil`. A token matches a story word it is a prefix of, which is a cheap
 * stand-in for stemming: `room` finds `rooms`, `survey` finds `surveyed`.
 */
export function storyScore(queryTokens, storyTokens) {
  if (!storyTokens?.size || !queryTokens.length) return 0;

  let matched = 0;
  let total = 0;
  for (const token of queryTokens) {
    total += token.length;
    if (storyTokens.has(token)) {
      matched += token.length;
      continue;
    }
    for (const word of storyTokens)
      if (word.startsWith(token)) {
        matched += token.length;
        break;
      }
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
 * @returns {{order: number[], signals: {clip: boolean, keyword: boolean, story: boolean}}}
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
}) {
  const foldedQuery = fold(query);
  const queryTokens = tokenise(query, { minLength: minTokenLength });

  // CLIP, normalised across the corpus for this query - see the header.
  let clip = null;
  if (embeddings && dim > 0 && vector) {
    clip = normaliseScores(embeddingScores(embeddings, dim, Float32Array.from(vector)));
  }

  const hasText = Boolean(index?.some(Boolean)) && (foldedQuery.length > 0 || queryTokens.length > 0);

  const scored = new Array(count);
  let sawKeyword = false;
  let sawStory = false;

  for (let id = 0; id < count; id++) {
    let score = 0;
    if (clip) score += weights.clip * (clip[id] ?? 0);

    if (hasText) {
      const entry = index[id];
      if (entry) {
        const k = keywordScore(foldedQuery, queryTokens, entry.keywords);
        const s = storyScore(queryTokens, entry.story);
        if (k > 0) sawKeyword = true;
        if (s > 0) sawStory = true;
        score += weights.keyword * k + weights.story * s;
      }
    }
    scored[id] = { id, score };
  }

  // Stable sort, so rooms that every signal is silent about keep their id order
  // rather than shuffling for no reason the reader can see.
  scored.sort((a, b) => b.score - a.score);

  return {
    order: scored.map((s) => s.id),
    signals: { clip: Boolean(clip), keyword: sawKeyword, story: sawStory },
  };
}
