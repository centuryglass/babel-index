import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchIndex,
  CLIP_CERTAINTY,
  fold,
  keywordScore,
  matchCertainty,
  normaliseScores,
  rankHybrid,
  storyScore,
  tokenise,
} from './scoring.js';
import { CERTAINTY_FLOOR } from './ordering.js';
import { DEFAULTS } from '../config/config.mjs';

const WEIGHTS = DEFAULTS.search.weights;

/**
 * An index over rooms given as `[keywords, story]` pairs, in id order.
 * A bare `null` is a room with no metadata at all.
 */
const indexOf = (...rooms) =>
  buildSearchIndex(
    rooms.map((room) => {
      if (!room) return null;
      const [keywords, story] = room;
      if (!keywords?.length && !story) return null;
      return { keywords: (keywords ?? []).map((text) => ({ text, type: null })), story };
    })
  );

// --- folding and tokenising -------------------------------------------------

test('folding removes case and diacritics', () => {
  assert.equal(fold('  Art NOUVEAU  '), 'art nouveau');
  assert.equal(fold('rosé'), 'rose');
  assert.equal(fold('Jugendstil'), 'jugendstil');
  assert.equal(fold(null), '');
});

test('tokenising drops short words and stopwords', () => {
  assert.deepEqual(tokenise('The Room of Wet Collodion'), ['room', 'wet', 'collodion']);
  assert.deepEqual(tokenise('a to at'), [], 'nothing survives the length floor');
  assert.deepEqual(tokenise('art', { minLength: 4 }), [], 'the floor is configurable');
});

// --- keyword scoring --------------------------------------------------------

test('an exact keyword match scores 1, including a multi-word keyword', () => {
  // The case the whole-query reading exists for: by tokens alone "art nouveau"
  // would average 3/11 and 7/11 to 0.45, and an exact match must not do that.
  assert.equal(keywordScore('art nouveau', ['art', 'nouveau'], ['art nouveau', 'oak']), 1);
  assert.equal(keywordScore('oak', ['oak'], ['art nouveau', 'oak']), 1);
});

test('a partial match is the fraction of the keyword it covers', () => {
  assert.equal(keywordScore('art', ['art'], ['art nouveau']), 3 / 11);
  assert.ok(
    keywordScore('nouveau', ['nouveau'], ['art nouveau']) > keywordScore('art', ['art'], ['art nouveau']),
    'matching more of the keyword scores higher'
  );
});

test('a query matching more of itself scores higher', () => {
  const keywords = ['brutalism', 'mezzotint'];
  const both = keywordScore('brutalism mezzotint', ['brutalism', 'mezzotint'], keywords);
  const one = keywordScore('brutalism sailboat', ['brutalism', 'sailboat'], keywords);
  assert.equal(both, 1);
  assert.equal(one, 0.5, 'one of two tokens matched');
});

test('a reordered multi-word query still scores through the token reading', () => {
  const score = keywordScore('nouveau art', ['nouveau', 'art'], ['art nouveau']);
  assert.ok(score > 0 && score < 1, `expected a partial score, got ${score}`);
});

test('keyword scoring never leaves [0, 1]', () => {
  for (const q of ['art', 'art nouveau', 'a b c', 'brutalism mezzotint oak copper']) {
    const s = keywordScore(fold(q), tokenise(q), ['art nouveau', 'oak', 'brutalism']);
    assert.ok(s >= 0 && s <= 1, `${q} -> ${s}`);
  }
});

test('a room with no keywords scores zero rather than throwing', () => {
  assert.equal(keywordScore('art', ['art'], []), 0);
  assert.equal(keywordScore('art', ['art'], undefined), 0);
});

// --- story scoring ----------------------------------------------------------

const story = (text) => new Set(tokenise(text));

test('story scoring is normalised by the query, not by the text', () => {
  // The property that matters: the same hit in a longer story scores the same.
  const short = story('A cartographer waits.');
  const long = story(
    'A cartographer waits in a room that the catalogue insists was surveyed twice, ' +
      'though the second survey is filed under a name nobody will read aloud, and the ' +
      'shelves go on well past the point where counting them stops being useful.'
  );
  assert.equal(storyScore(['cartographer'], short), 1);
  assert.equal(storyScore(['cartographer'], long), 1);
});

test('longer query tokens carry more weight than short ones', () => {
  const s = story('The cartographer left.');
  // "cartographer" (12) matched, "oil" (3) not: 12/15.
  assert.equal(storyScore(['cartographer', 'oil'], s), 12 / 15);
  // the reverse: only "oil" matched, out of the same total.
  assert.equal(storyScore(['cartographer', 'oil'], story('An oil lamp.')), 3 / 15);
});

test('a token matches a story word it prefixes, as a stand-in for stemming', () => {
  assert.equal(storyScore(['room'], story('The rooms are numbered.')), 1);
  assert.equal(storyScore(['survey'], story('It was surveyed once.')), 1);
  assert.equal(storyScore(['surveyed'], story('A survey.')), 0, 'prefixing is one-way');
});

test('an empty story or query scores zero', () => {
  assert.equal(storyScore(['anything'], story('')), 0);
  assert.equal(storyScore([], story('a real story about copper')), 0);
});

// --- normalisation ----------------------------------------------------------

test('min-max puts a spread of scores on [0, 1]', () => {
  const out = normaliseScores([0.20, 0.24, 0.22]);
  assert.equal(out[0], 0);
  assert.equal(out[1], 1);
  assert.ok(Math.abs(out[2] - 0.5) < 1e-6);
});

test('a flat signal normalises to zero, not to one', () => {
  // A signal that cannot distinguish anything must not contribute a constant
  // that outranks one that can.
  assert.deepEqual(Array.from(normaliseScores([0.3, 0.3, 0.3])), [0, 0, 0]);
  assert.deepEqual(Array.from(normaliseScores([])), []);
});

test('normalisation is what makes a narrow CLIP band comparable to a keyword', () => {
  // The real shape of the problem: cosines on this corpus sit in a narrow band,
  // so before normalising, the *whole spread* of CLIP is worth less than the
  // smallest keyword partial. After, its best is worth exactly its weight.
  const raw = [0.213, 0.219, 0.224];
  const rawSpread = Math.max(...raw) - Math.min(...raw);
  assert.ok(rawSpread < 0.02, 'the band really is narrow');
  const normalised = normaliseScores(raw);
  assert.equal(Math.max(...normalised), 1);
});

// --- the blend --------------------------------------------------------------

test('an exact keyword match outranks the best possible CLIP score', () => {
  // The design's headline property, and the reason the weights are what they
  // are. Room 1 is CLIP's favourite; room 0 merely has the keyword.
  const embeddings = Int8Array.from([0, 127, 127, 0]);
  const { order } = rankHybrid({
    query: 'brutalism',
    count: 2,
    weights: WEIGHTS,
    embeddings,
    dim: 2,
    vector: Float32Array.from([0, 1]),
    index: indexOf([['brutalism'], null], [['oak'], null]),
  });
  assert.deepEqual(order, [0, 1]);
});

test('CLIP still orders everything the text signals are silent about', () => {
  // Most of the corpus, for most queries. Rooms 1 and 2 have no keyword match,
  // so their relative order is CLIP's to decide.
  const embeddings = Int8Array.from([0, 0, 40, 0, 127, 0]);
  const { order } = rankHybrid({
    query: 'brutalism',
    count: 3,
    weights: WEIGHTS,
    embeddings,
    dim: 2,
    vector: Float32Array.from([1, 0]),
    index: indexOf([['brutalism'], null], [['oak'], null], [['pine'], null]),
  });
  assert.deepEqual(order, [0, 2, 1], 'keyword first, then the two by CLIP');
});

test('a weak partial keyword does not beat a room CLIP is certain about', () => {
  // This is the difference between blending and tiering, and the reason the
  // design blends. Room 0 matches "art" against a long keyword - 3/31 of it -
  // while room 1 is CLIP's clear favourite and matches no text at all. Any
  // scheme that sorts "has a keyword hit" ahead of "has none" puts room 0
  // first; the blend correctly does not.
  const weak = keywordScore('art', ['art'], ['art nouveau and gilded rosewood']);
  assert.ok(weak * WEIGHTS.keyword < WEIGHTS.clip, `partial ${weak} should be worth less than top CLIP`);

  const { order } = rankHybrid({
    query: 'art',
    count: 2,
    weights: WEIGHTS,
    embeddings: Int8Array.from([0, 0, 127, 0]),
    dim: 2,
    vector: Float32Array.from([1, 0]),
    index: indexOf([['art nouveau and gilded rosewood'], null], [['oak'], null]),
  });
  assert.deepEqual(order, [1, 0], 'CLIP wins over a weak partial - blended, not tiered');
});

test('an undescribed room still outranks a described one CLIP likes less', () => {
  // Most of a real corpus has no metadata yet. Rooms without an entry must be
  // ranked by whatever signal does apply, not parked below every described
  // room - otherwise adding keywords to one room demotes the whole rest.
  const { order } = rankHybrid({
    query: 'sailboat',
    count: 2,
    weights: WEIGHTS,
    embeddings: Int8Array.from([0, 0, 127, 0]),
    dim: 2,
    vector: Float32Array.from([1, 0]),
    index: indexOf([['oak'], 'A room of oak.'], null),
  });
  assert.deepEqual(order, [1, 0], 'the undescribed room is CLIP-preferred and wins');
});

test('keywords outrank story text', () => {
  const { order } = rankHybrid({
    query: 'mezzotint',
    count: 2,
    weights: WEIGHTS,
    index: indexOf([[], 'A room of mezzotint and dust.'], [['mezzotint'], null]),
  });
  assert.deepEqual(order, [1, 0]);
});

test('the whole corpus is sorted, not just the matches', () => {
  // The property the map depends on: every room has a place in the new order,
  // so the library rearranges rather than splicing a few results to the front.
  const count = 6;
  const { order } = rankHybrid({
    query: 'copper',
    count,
    weights: WEIGHTS,
    index: indexOf([['copper'], null], null, null, [[], 'copper piping'], null, null),
  });
  assert.equal(order.length, count);
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], 'a permutation');
});

test('rooms nothing matched keep their id order rather than shuffling', () => {
  const { order } = rankHybrid({
    query: 'copper',
    count: 4,
    weights: WEIGHTS,
    index: indexOf([['copper'], null], null, null, null),
  });
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test('text-only ranking works with no embeddings at all', () => {
  const { order, signals } = rankHybrid({
    query: 'collodion',
    count: 3,
    weights: WEIGHTS,
    index: indexOf([['oak'], null], [['wet collodion'], null], [[], 'nothing relevant']),
  });
  assert.equal(order[0], 1);
  assert.equal(signals.clip, false);
  assert.equal(signals.keyword, true);
});

test('CLIP-only ranking works with no metadata at all', () => {
  const { order, signals } = rankHybrid({
    query: 'anything',
    count: 2,
    weights: WEIGHTS,
    embeddings: Int8Array.from([0, 127, 127, 0]),
    dim: 2,
    vector: Float32Array.from([1, 0]),
    index: null,
  });
  assert.deepEqual(order, [1, 0]);
  assert.equal(signals.clip, true);
  assert.equal(signals.keyword, false);
});

test('signals report what matched, not what was available', () => {
  // A corpus full of keywords that this query missed must not be reported as a
  // keyword-driven ranking.
  const { signals } = rankHybrid({
    query: 'sailboat',
    count: 2,
    weights: WEIGHTS,
    index: indexOf([['brutalism'], 'A room of concrete.'], [['oak'], null]),
  });
  assert.deepEqual(signals, { clip: false, keyword: false, story: false });
});

test('a zero weight silences a signal without removing it', () => {
  const weights = { ...WEIGHTS, keyword: 0 };
  const { order } = rankHybrid({
    query: 'brutalism',
    count: 2,
    weights,
    index: indexOf([['brutalism'], null], [[], 'brutalism everywhere']),
  });
  assert.deepEqual(order, [1, 0], 'story decides once keywords are switched off');
});

test('rooms without metadata are ranked, not dropped', () => {
  const { order } = rankHybrid({
    query: 'oak',
    count: 3,
    weights: WEIGHTS,
    index: indexOf(null, [['oak'], null], null),
  });
  assert.equal(order.length, 3);
  assert.equal(order[0], 1);
});

test('an empty index behaves like no index', () => {
  const { order, signals } = rankHybrid({ query: 'oak', count: 3, weights: WEIGHTS, index: [null, null, null] });
  assert.deepEqual(order, [0, 1, 2]);
  assert.deepEqual(signals, { clip: false, keyword: false, story: false });
});

// --- certainty, which drives the map's density gradient ---------------------

/**
 * An embedding blob whose rooms sit at the given cosines from the query
 * `[1, 0]`. Two dimensions is enough: the second carries whatever the first
 * does not, so every row stays a unit vector and the dot product is the cosine
 * that was asked for.
 */
const atCosines = (...cosines) =>
  Int8Array.from(
    cosines.flatMap((c) => [Math.round(c * 127), Math.round(Math.sqrt(1 - c * c) * 127)])
  );

const CLIP_QUERY = Float32Array.from([1, 0]);

const certaintyOf = (opts) =>
  rankHybrid({ count: 3, weights: WEIGHTS, dim: 2, vector: CLIP_QUERY, ...opts }).certainty;

test('a soft OR: any signal can carry certainty, and two weak ones agree', () => {
  assert.equal(matchCertainty({ keyword: 1 }), 1, 'an exact keyword needs no help');
  assert.equal(matchCertainty({}), 0, 'nothing at all is certain of nothing');
  assert.equal(matchCertainty({ keyword: 0.5, story: 0.5 }), 0.75);
  assert.ok(
    matchCertainty({ keyword: 0.4, story: 0.4 }) > matchCertainty({ keyword: 0.4 }),
    'agreement between two weak readings counts for more than either alone'
  );
});

test('CLIP certainty is read off the raw cosine, against absolute bounds', () => {
  const { low, high } = CLIP_CERTAINTY;
  assert.equal(matchCertainty({ cosine: low - 0.05 }), 0, 'below the band it is saying nothing');
  assert.equal(matchCertainty({ cosine: high + 0.05 }), 1, 'above it, as sure as it gets');
  const mid = matchCertainty({ cosine: (low + high) / 2 });
  assert.ok(Math.abs(mid - 0.5) < 1e-6, `halfway across the band is ${mid}`);
});

test('a query nothing matches clusters nothing, however the ranking came out', () => {
  // The case the whole absolute reading exists for. Min-max normalisation gives
  // *some* room a score of 1 for any query at all, so the blend cannot tell
  // "cghjj" from "art nouveau" - and a gradient driven by the blend would
  // cluster noise and claim a find. The raw cosines say what is really going on.
  const cosines = [0.11, 0.12, 0.13];
  const certainty = certaintyOf({ query: 'cghjj', embeddings: atCosines(...cosines) });

  assert.equal(Math.max(...certainty), 0, `expected no certainty, got ${[...certainty]}`);
  assert.ok(certainty.every((c) => c < CERTAINTY_FLOOR), 'and nothing that would survive the floor');

  // The ranking is still a real ranking - the map reorders, it just does not
  // pretend to be sure. That contrast is the point.
  assert.equal(Math.max(...normaliseScores(cosines)), 1);
  const { order } = rankHybrid({
    query: 'cghjj',
    count: 3,
    weights: WEIGHTS,
    embeddings: atCosines(...cosines),
    dim: 2,
    vector: CLIP_QUERY,
  });
  assert.deepEqual(order, [2, 1, 0], 'best cosine still leads, faint as it is');
});

test('a strong cosine is certain on its own', () => {
  // "red", against rooms CLIP really does think are red: certainty falls off
  // gradually with the cosine, which is what makes the density falloff gradual.
  const certainty = certaintyOf({ query: 'red', embeddings: atCosines(0.32, 0.24, 0.12) });
  assert.equal(certainty[0], 1);
  assert.ok(certainty[1] > 0.4 && certainty[1] < 0.6, `middling cosine gave ${certainty[1]}`);
  assert.equal(certainty[2], 0);
});

test('an exact keyword match is certain whatever the picture looks like', () => {
  // "lora:yuiop" tagged on a room CLIP has no opinion about. The tag is the
  // answer; the cosine has no say in whether it is one.
  const certainty = certaintyOf({
    query: 'yuiop',
    embeddings: atCosines(0.1, 0.1, 0.1),
    index: indexOf([['yuiop'], null], [['oak'], null], [['pine'], null]),
  });
  assert.equal(certainty[0], 1, 'the tagged room');
  assert.deepEqual([...certainty.slice(1)], [0, 0], 'and nothing else clusters at all');
});

test('a partial keyword is partially certain', () => {
  // 3/11 of "art nouveau" matched is 3/11 of a reason to pull it to the centre.
  const certainty = certaintyOf({
    query: 'art',
    embeddings: atCosines(0.1, 0.1, 0.1),
    index: indexOf([['art nouveau'], null], [['oak'], null], [['pine'], null]),
  });
  assert.ok(Math.abs(certainty[0] - 3 / 11) < 1e-6, `got ${certainty[0]}`);
});

test('certainty is indexed by rank, not by room', () => {
  // The layout pours it into slots in rank order, so a mismatch here would
  // cluster the wrong rooms - and would look plausible while doing it.
  const { order, certainty } = rankHybrid({
    query: 'oak',
    count: 3,
    weights: WEIGHTS,
    index: indexOf(null, null, [['oak'], null]),
  });
  assert.equal(order[0], 2, 'room 2 has the keyword');
  assert.equal(certainty[0], 1, 'and its certainty is at rank 0, not at index 2');
  assert.equal(certainty.length, 3);
});

test('the certainty bounds are configurable', () => {
  // They are the one part of the gradient that wants measuring against a real
  // corpus, which is why they are config rather than a constant in the blend.
  const opts = { query: 'red', embeddings: atCosines(0.15, 0.15, 0.15), dim: 2, vector: CLIP_QUERY };
  assert.equal(rankHybrid({ count: 3, weights: WEIGHTS, ...opts }).certainty[0], 0);
  const loosened = rankHybrid({
    count: 3,
    weights: WEIGHTS,
    ...opts,
    clipCertainty: { low: 0.05, high: 0.1 },
  });
  assert.equal(loosened.certainty[0], 1, 'a lower band makes the same cosine certain');
});

test('no blob means no CLIP certainty, rather than a certainty of zero cosines', () => {
  // A corpus with keywords and no embeddings must still cluster its keyword
  // hits; only the CLIP channel goes quiet.
  const { certainty } = rankHybrid({
    query: 'oak',
    count: 3,
    weights: WEIGHTS,
    index: indexOf([['oak'], null], null, null),
  });
  assert.equal(certainty[0], 1);
});
