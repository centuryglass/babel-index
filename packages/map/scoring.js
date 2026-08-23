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
  return foldWithMap(text).folded.trim();
}

/** Combining marks, stripped after NFD has exposed them. */
const COMBINING = /[\u0300-\u036f]/g;

/**
 * `fold`, but keeping track of where every folded character came from.
 *
 * Highlighting needs this and nothing else does. Matching happens on folded
 * text; the `<mark>` has to land on the ORIGINAL, and a folded index is not an
 * original index - every step of folding can change length. Decomposed
 * `cafe\u0301` is five characters and folds to four; `\u0130` lowercases to two
 * from one. Use one as the other and every highlight on a corpus with an accent
 * in it lands slightly wrong, which is the kind of bug nobody reports because it
 * looks like sloppy rendering rather than a defect.
 *
 * So this folds one CODE POINT at a time and records, for each UTF-16 unit of
 * the output, the index of the source unit that produced it. `map.length` is
 * always `folded.length`, and `map[i] <= map[i + 1]`, which is what lets a range
 * in folded space be read straight back as a range in the original.
 *
 * Per code point rather than over the whole string is a small, deliberate change
 * of meaning that `fold` inherits: whole-string lowercasing is context
 * sensitive in a couple of places (Greek sigma takes its final form at the end
 * of a word), and an index wants folding to be position independent, so the
 * same word folds the same way wherever it appears. Canonical reordering across
 * a combining sequence is likewise moot here, because every combining mark is
 * stripped a line later.
 *
 * Deliberately does NOT trim: `fold` trims its own result, and trimming inside
 * this would shift every recorded index off the text it describes.
 *
 * @param {string} text
 * @returns {{folded: string, map: number[]}}
 */
export function foldWithMap(text) {
  const src = String(text ?? '');
  const map = [];
  let folded = '';

  for (let i = 0; i < src.length; ) {
    const cp = String.fromCodePoint(src.codePointAt(i));
    const out = cp.normalize('NFD').replace(COMBINING, '').toLowerCase();
    for (let k = 0; k < out.length; k++) map.push(i);
    folded += out;
    i += cp.length;
  }

  return { folded, map };
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
 * ## Where the query matched, for highlighting
 *
 * Two functions, one per match rule, sitting under the two scorers they shadow
 * so that a change to either is visibly a change to a pair.
 *
 * They exist here rather than in a component for one reason: a view that
 * re-derives "what matched" will drift from the thing that ranked, and it will
 * drift silently - marked text that scored nothing, or a room in the cluster
 * with nothing marked at all. Both take the SAME `foldedQuery` and `queryTokens`
 * the ranking was computed from, so a token dropped for being a stopword or for
 * being under `minTokenLength` cannot highlight. It did not score, so it does
 * not mark.
 *
 * The asymmetry between them is the asymmetry between the scorers, and it is
 * not incidental: a keyword matches by SUBSTRING (`k.includes(token)`), a story
 * word by PREFIX (`word.startsWith(token)`, the cheap stand-in for stemming).
 * One highlighter over both would mark text `keywordScore` never looked at and
 * miss text `storyScore` credited.
 *
 * Both return ranges into the ORIGINAL string - sorted, merged, non-overlapping
 * - which is what `<Highlight>` renders and what makes them assertable without
 * a DOM.
 */

/**
 * Merge sorted-by-start ranges, dropping empties and collapsing overlaps.
 *
 * Two query tokens routinely hit the same span (`art` and `artist` against
 * `artists`), and nested or duplicated `<mark>` elements are not what anyone
 * wants to render or to read out.
 *
 * @param {{start: number, end: number}[]} ranges
 * @returns {{start: number, end: number}[]}
 */
function mergeRanges(ranges) {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Turn a [start, end) span of FOLDED text into one of the original.
 *
 * The end is exclusive, so it is the source index of the character *after* the
 * span - `map[end]` when there is one, and the string's length when the span
 * runs to the end.
 */
function toSource(map, srcLength, start, end) {
  return {
    start: map[start] ?? srcLength,
    end: end < map.length ? map[end] : srcLength,
  };
}

/** Every occurrence of `needle` in `hay`, as folded-space ranges. */
function occurrences(hay, needle) {
  const found = [];
  if (!needle) return found;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1))
    found.push({ start: i, end: i + needle.length });
  return found;
}

/**
 * Where a query matched one keyword, mirroring `keywordScore`'s substring rule.
 *
 * The union of both of that function's readings - the whole query as a
 * substring, and each query token as a substring - rather than only whichever
 * of the two won the score. They almost always overlap into one range anyway,
 * since a query contains its own tokens, and the union is the honest answer to
 * the question the reader is asking ("why is this chip here?") rather than to
 * the narrower "which arithmetic produced the number".
 *
 * @param {string} text the keyword as written, unfolded
 * @param {string} foldedQuery
 * @param {string[]} queryTokens
 * @returns {{start: number, end: number}[]} ranges into `text`
 */
export function keywordMatchRanges(text, foldedQuery, queryTokens = []) {
  const src = String(text ?? '');
  if (!src) return [];
  const { folded, map } = foldWithMap(src);
  if (!folded) return [];

  const hits = occurrences(folded, foldedQuery);
  for (const token of queryTokens) hits.push(...occurrences(folded, token));

  return mergeRanges(hits.map((h) => toSource(map, src.length, h.start, h.end)));
}

/**
 * Where a query matched a story, mirroring `storyScore`'s STEM rule.
 *
 * Walks the text on the same word boundary `tokenise` splits on, and marks a
 * word whose Porter stem is one of the query's. That is the same test
 * `storyScore` makes against the pre-stemmed index `buildSearchIndex` holds -
 * stemming here rather than reusing that set because this needs to know WHICH
 * word in the original text matched, and the index has thrown the positions
 * away.
 *
 * Two details keep it faithful to what actually scored:
 *
 *   - words `tokenise` would have dropped are skipped, so a query token that
 *     stems onto a stopword marks nothing - `storyScore` tests against the
 *     tokenised story, where that word is not present.
 *   - the WHOLE matched word is marked, not the stem. `survey` marks all of
 *     `surveyed`. Marking three quarters of a word reads as a rendering bug;
 *     marking the word reads as "this is why this room is here", which is the
 *     question being asked.
 *
 * @param {string} text the story as written, unfolded
 * @param {string[]} queryTokens
 * @param {object} [opts]
 * @param {number} [opts.minLength] must match what built the story index
 * @returns {{start: number, end: number}[]} ranges into `text`
 */
export function storyMatchRanges(text, queryTokens = [], { minLength = 3 } = {}) {
  const src = String(text ?? '');
  if (!src || !queryTokens.length) return [];
  const { folded, map } = foldWithMap(src);
  if (!folded) return [];

  const stems = new Set(queryTokens.map(stemmer));
  const hits = [];
  // The complement of `tokenise`'s split, so the two agree on what a word is.
  for (const m of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0];
    if (word.length < minLength || STOPWORDS.has(word)) continue;
    if (!stems.has(stemmer(word))) continue;
    hits.push(toSource(map, src.length, m.index, m.index + word.length));
  }

  return mergeRanges(hits);
}

/**
 * Where each value falls among its peers, in [0, 1] - 1 for the highest, 0 for
 * the lowest, ties sharing the average of the ranks they span.
 *
 * This is what makes a raw cosine self-contextualising for a reader. `0.243`
 * means nothing without the rest of the list to hold it against; "beats 91% of
 * this search's rooms" carries that comparison inside the number itself, so a
 * reader never has to scroll to the top and bottom of the results to place it.
 * Unlike `normaliseScores`, this is rank-based rather than value-based - two
 * cosines 0.001 apart land at very different percentiles if the corpus is
 * dense there, which is the point: it answers "how many rooms did this beat",
 * not "how close to the best score".
 *
 * @param {ArrayLike<number>} values
 * @returns {Float32Array}
 */
function percentileRanks(values) {
  const n = values.length;
  const out = new Float32Array(n);
  if (n <= 1) return out;

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    const rank = (i + j) / (2 * (n - 1));
    for (let k = i; k <= j; k++) out[order[k]] = rank;
    i = j + 1;
  }
  return out;
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
 *            breakdown: {score: Float32Array, keyword: Float32Array,
 *                        story: Float32Array, clip: Float32Array,
 *                        cosine: Float32Array, clipPercentile: Float32Array},
 *            signals: {clip: boolean, keyword: boolean, story: boolean}}}
 *   `certainty` is parallel to `order`, i.e. by rank, which is how the map's
 *   density gradient wants it - and `breakdown` follows the same convention,
 *   every array indexed by rank rather than by room id.
 *
 *   `breakdown` is what the catalog shows under a room and what `explainScore`
 *   formats. It is returned always rather than behind a flag: a second pass
 *   that recomputed these for display could disagree with the one that sorted,
 *   and a scoring explanation that does not match the scoring is worse than
 *   none. Six arrays of `count` floats - 120 KB at 5,000 rooms, allocated in a
 *   loop that already runs.
 *
 *   `clipPercentile` is NaN wherever `cosine` is - it is `percentileRanks` over
 *   the raw cosines, not the min-maxed `clip` column, because the point is a
 *   number a reader can read alone: "beats 91% of this search" needs no top or
 *   bottom of the list to hold it against, where the min-maxed value still
 *   invites the "is 1.00 actually good here?" question `explainScore`'s header
 *   warns about.
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
  let clipPercentile = null;
  if (embeddings && dim > 0 && vector) {
    cosines = embeddingScores(embeddings, dim, Float32Array.from(vector));
    clip = normaliseScores(cosines);
    // By id, not by rank - the loop below re-indexes it like every other column.
    clipPercentile = percentileRanks(cosines);
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
      keyword: k,
      story: s,
      // Both CLIP numbers are kept, because they answer different questions and
      // the breakdown has to show both - see `explainScore`.
      clip: clip ? (clip[id] ?? 0) : 0,
      cosine: cosines ? (cosines[id] ?? NaN) : NaN,
      clipPercentile: clipPercentile ? (clipPercentile[id] ?? NaN) : NaN,
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
  const breakdown = {
    score: new Float32Array(count),
    keyword: new Float32Array(count),
    story: new Float32Array(count),
    clip: new Float32Array(count),
    cosine: new Float32Array(count),
    clipPercentile: new Float32Array(count),
  };
  for (let rank = 0; rank < count; rank++) {
    const row = scored[rank];
    certainty[rank] = row.certainty;
    breakdown.score[rank] = row.score;
    breakdown.keyword[rank] = row.keyword;
    breakdown.story[rank] = row.story;
    breakdown.clip[rank] = row.clip;
    breakdown.cosine[rank] = row.cosine;
    breakdown.clipPercentile[rank] = row.clipPercentile;
  }

  return {
    order: scored.map((s) => s.id),
    certainty,
    breakdown,
    signals: { clip: Boolean(clip), keyword: sawKeyword, story: sawStory },
  };
}

/**
 * One room's ranking, as rows a reader can check the sort against.
 *
 * The catalog shows this under every room while a search is running, and the
 * room card shows the same rows. It is the first place the distinction this
 * file's header spends a section on becomes something a reader can SEE rather
 * than something written down:
 *
 * > Ranking is relative; certainty is not.
 *
 * `breakdown.clip` is min-maxed across the corpus for this query, so SOME room
 * scores 1.00 for `art nouveau` and some room scores 1.00 for `cghjj`. Printing
 * that number alone would tell a reader the library was certain about a room it
 * has nothing to say about. So the CLIP row carries its RAW cosine alongside,
 * and `certainty` is its own row rather than being folded into the total - it
 * is the only number here computed against absolute bounds.
 *
 * A signal that contributed nothing is omitted rather than shown as zero: three
 * rows of 0.00 tell a reader less than their absence does, and the ranking of a
 * room no text touched genuinely is "CLIP alone".
 *
 * Two of the returned numbers are self-contextualising on purpose. A raw
 * cosine or a weighted total means nothing without the rest of the list held
 * up against it - that comparison is exactly what a `percentile` bakes in, so
 * "beats 91% of this search" needs nothing else on screen to make sense of.
 * `clipPercentile` comes from `rankHybrid` (rank-based, over the raw cosines);
 * `totalPercentile` is cheaper - the blend is already sorted, so a room's
 * percentile in the total is just its position in `order`.
 *
 * @param {number} rank position in `order`
 * @param {object} opts
 * @param {object} opts.breakdown from `rankHybrid`
 * @param {Float32Array} opts.certainty from `rankHybrid`
 * @param {{keyword: number, story: number, clip: number}} opts.weights
 * @returns {{rows: Array<{key: string, label: string, weighted: number,
 *            raw: number, percentile: number|null, note: string|null}>,
 *            total: number, totalPercentile: number|null, certainty: number}}
 */
export function explainScore(rank, { breakdown, certainty, weights }) {
  const at = (arr) => (arr && rank < arr.length ? arr[rank] : 0);
  const rows = [];

  const keyword = at(breakdown?.keyword);
  if (keyword > 0)
    rows.push({
      key: 'keyword',
      label: 'keyword',
      weighted: weights.keyword * keyword,
      raw: keyword,
      percentile: null,
      // Which way the ratio divides is the thing most likely to be misread off
      // a bare number, and the two signals divide opposite ways on purpose.
      note: 'share of the matched keyword',
    });

  const story = at(breakdown?.story);
  if (story > 0)
    rows.push({
      key: 'story',
      label: 'story',
      weighted: weights.story * story,
      raw: story,
      percentile: null,
      note: 'share of the query found',
    });

  const cosine = at(breakdown?.cosine);
  if (Number.isFinite(cosine)) {
    const clipPercentile = at(breakdown?.clipPercentile);
    rows.push({
      key: 'clip',
      label: 'picture',
      weighted: weights.clip * at(breakdown?.clip),
      raw: cosine,
      percentile: Number.isFinite(clipPercentile) ? clipPercentile : null,
      note: "CLIP's raw cosine, absolute; the percentile is where it lands among this search's rooms",
    });
  }

  // `order`'s length, not a magic count passed in separately - one fewer thing
  // that could disagree with what actually got sorted.
  const count = breakdown?.score?.length ?? 0;
  const totalPercentile = count > 1 ? (count - 1 - rank) / (count - 1) : null;

  return { rows, total: at(breakdown?.score), totalPercentile, certainty: at(certainty) };
}
