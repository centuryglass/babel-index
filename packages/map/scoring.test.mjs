import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchIndex,
  classifyTagTerm,
  CLIP_CERTAINTY,
  explainScore,
  fold,
  foldWithMap,
  keywordMatchRanges,
  keywordScore,
  lemmatise,
  longestMatchRun,
  matchCertainty,
  normaliseScores,
  parseQuery,
  rankHybrid,
  signedClipCertainty,
  STORY_FLOOR,
  STORY_LONG_RANGE,
  storyMatchRanges,
  storyPhraseRun,
  storyScore,
  TAG_PARTIAL_SATURATION,
  tokenise,
} from './scoring.js';
import { CERTAINTY_FLOOR } from './ordering.ts';
import { DEFAULTS } from '../config/config.ts';

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

test('folding transliterates letters NFD cannot decompose', () => {
  // ł, unlike é, is a letter in its own right rather than a base plus a
  // combining mark, so NFD leaves it untouched - any-ascii is what closes
  // the gap between "Zdzisław" and "Zdzislaw".
  assert.equal(fold('Zdzisław Beksiński'), fold('Zdzislaw Beksinski'));
  assert.equal(fold('Zdzisław'), 'zdzislaw');
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

const story = (text) => buildSearchIndex([{ keywords: [], story: text }])[0].story;

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

test('a token matches a story word by lemma, both directions', () => {
  assert.equal(storyScore(['room'], story('The rooms are numbered.')), 1);
  assert.equal(storyScore(['survey'], story('It was surveyed once.')), 1);
  // Lemmatising is symmetric, where the old prefix rule was one-way.
  assert.equal(storyScore(['surveyed'], story('A survey.')), 1, 'lemmatising is two-way');
});

test('a lemma match is a word match, not a prefix match', () => {
  // The motivating case: "cat" must not be dragged in by "catalogue".
  assert.equal(storyScore(['cat'], story('The cats slept on the shelf.')), 1);
  assert.equal(storyScore(['cat'], story('An intricate catalogue of rooms.')), 0);
});

test('a lemma match does not collide across unrelated word families', () => {
  // The bug this replaced the Porter stemmer for: "animation" and "animal"
  // both stemmed to "anim", so a search for one surfaced the other.
  assert.equal(storyScore(['animation'], story('A short animation played on loop.')), 1);
  assert.equal(storyScore(['animation'], story('Stone animals lined the hall.')), 0);
  assert.equal(storyScore(['animal'], story('Stone animals lined the hall.')), 1);
  assert.equal(storyScore(['animal'], story('A short animation played on loop.')), 0);
});

test('an empty story or query scores zero', () => {
  assert.equal(storyScore(['anything'], story('')), 0);
  assert.equal(storyScore([], story('a real story about copper')), 0);
});

// --- the story sequence: contiguous-run measurement --------------------------

test('the longest match run spans scattered hits less than one contiguous clause', () => {
  const scattered = story('The cat waited. Later a dog barked. A bird sang, and a fish swam by.');
  const clause = story('A room walled entirely in glass, floor to ceiling.');
  const lemmas = (...words) => new Set(words.map(lemmatise));

  const scatteredRun = longestMatchRun(scattered.sequence, lemmas('cat', 'dog', 'bird', 'fish'));
  const clauseRun = longestMatchRun(clause.sequence, lemmas('room', 'walled', 'entirely', 'glass'));

  // Each scattered word is its own one-word run; the clause is one long one.
  assert.ok(clauseRun > scatteredRun, `clause run ${clauseRun} should beat scattered run ${scatteredRun}`);
  assert.ok(clauseRun >= 20, `expected a near-full-clause span, got ${clauseRun}`);
});

test('a stopword or short word between two matches does not break the run', () => {
  // "of" (2 chars) and "a" never enter the sequence at all, so "room" and
  // "glass" are adjacent in it even though "a room of glass" is not.
  const s = story('a room of glass');
  const run = longestMatchRun(s.sequence, new Set([lemmatise('room'), lemmatise('glass')]));
  assert.ok(run > 0, 'room and glass count as contiguous');
});

test('the longest run is measured by lemma, matching storyScore', () => {
  const s = story('The rooms were surveyed twice.');
  const run = longestMatchRun(s.sequence, new Set([lemmatise('room'), lemmatise('survey')]));
  assert.ok(run > 0);
});

test('no match run when nothing in the query lemma set appears', () => {
  const s = story('A room of oak.');
  assert.equal(longestMatchRun(s.sequence, new Set([lemmatise('sailboat')])), 0);
  assert.equal(longestMatchRun(s.sequence, new Set()), 0);
  assert.equal(longestMatchRun([], new Set([lemmatise('room')])), 0);
});

test('a quoted phrase matches the story only as an ordered run', () => {
  const s = story('A room walled in glass, floor to ceiling.');
  const forward = ['room', 'walled', 'glass'].map(lemmatise);
  const reversed = ['glass', 'walled', 'room'].map(lemmatise);

  assert.ok(storyPhraseRun(s.sequence, forward) > 0, 'the phrase appears in order');
  assert.equal(storyPhraseRun(s.sequence, reversed), 0, 'reversed is not the same phrase');
});

test('a phrase run must be truly consecutive, not just present', () => {
  const s = story('A room, entirely walled in oak, then glass.');
  // "room" and "glass" both occur, far apart - not a phrase match.
  assert.equal(storyPhraseRun(s.sequence, ['room', 'glass'].map(lemmatise)), 0);
});

// --- query parsing: quoted phrases as single terms ---------------------------

test('an unquoted query splits into one term per word', () => {
  const { terms } = parseQuery('art nouveau oak');
  assert.deepEqual(terms.map((t) => t.text), ['art', 'nouveau', 'oak']);
  assert.ok(terms.every((t) => t.quoted === false));
  assert.deepEqual(terms.map((t) => t.words), [['art'], ['nouveau'], ['oak']]);
});

test('a quoted phrase is one term, not one per word inside it', () => {
  const { terms } = parseQuery('"art nouveau" oak');
  assert.equal(terms.length, 2);
  assert.equal(terms[0].quoted, true);
  assert.equal(terms[0].text, 'art nouveau');
  assert.equal(terms[0].folded, 'art nouveau');
  assert.deepEqual(terms[0].words, ['art', 'nouveau']);
  assert.equal(terms[1].quoted, false);
  assert.equal(terms[1].text, 'oak');
});

test('quoting a single word changes nothing about how it folds', () => {
  const bare = parseQuery('art');
  const quoted = parseQuery('"art"');
  assert.equal(bare.terms[0].folded, quoted.terms[0].folded);
  assert.equal(quoted.terms[0].quoted, true);
});

test('an unterminated quote falls back to ordinary word terms', () => {
  const { terms } = parseQuery('art "nouveau');
  assert.deepEqual(terms.map((t) => t.text), ['art', '"nouveau']);
  assert.ok(terms.every((t) => t.quoted === false));
});

test('folded and raw are preserved on the parsed query as a whole', () => {
  const parsed = parseQuery('  Art Nouveau  ');
  assert.equal(parsed.raw, '  Art Nouveau  ');
  assert.equal(parsed.folded, fold('  Art Nouveau  '));
});

test('an empty or whitespace-only query parses to no terms', () => {
  assert.deepEqual(parseQuery('').terms, []);
  assert.deepEqual(parseQuery('   ').terms, []);
  assert.deepEqual(parseQuery(null).terms, []);
});

// --- classifying one term against a room's keywords ---------------------------

test('an exact term match is exact, not a 1.0 partial', () => {
  const { terms } = parseQuery('oak');
  assert.deepEqual(classifyTagTerm(terms[0], ['oak', 'art nouveau']), { exact: true, partial: 0 });
});

test('a partial term match is the fraction of the keyword it covers', () => {
  const { terms } = parseQuery('art');
  assert.deepEqual(classifyTagTerm(terms[0], ['art nouveau']), { exact: false, partial: 3 / 11 });
});

test('a quoted phrase is classified as one whole-phrase match, not per word', () => {
  const { terms } = parseQuery('"art nouveau"');
  assert.deepEqual(classifyTagTerm(terms[0], ['art nouveau', 'oak']), { exact: true, partial: 0 });

  // The room tagged with the two words SEPARATELY gets no credit at all - the
  // phrase never appears as a contiguous run in either keyword.
  assert.deepEqual(classifyTagTerm(terms[0], ['art', 'nouveau']), { exact: false, partial: 0 });
});

test('no match is neither exact nor partial', () => {
  const { terms } = parseQuery('sailboat');
  assert.deepEqual(classifyTagTerm(terms[0], ['oak', 'art nouveau']), { exact: false, partial: 0 });
});

test('classifying against no keywords is a clean miss, not a throw', () => {
  const { terms } = parseQuery('oak');
  assert.deepEqual(classifyTagTerm(terms[0], []), { exact: false, partial: 0 });
  assert.deepEqual(classifyTagTerm(terms[0], undefined), { exact: false, partial: 0 });
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

test('a weak partial tag does not beat a room CLIP is certain about', () => {
  // This is the difference between blending and tiering, and the reason the
  // design blends. Room 0 matches "art" against a long keyword - a small
  // fraction of it - while room 1 is CLIP's clear favourite and matches no
  // text at all. Any scheme that sorts "has a keyword hit" ahead of "has
  // none" puts room 0 first; the blend correctly does not, because the
  // partial-tag budget (P) is capped below what a certain CLIP match earns.
  const { partial } = classifyTagTerm(parseQuery('art').terms[0], ['art nouveau and gilded rosewood']);
  assert.ok(
    WEIGHTS.tagPartial * Math.min(1, partial / TAG_PARTIAL_SATURATION) < WEIGHTS.clip,
    `partial ${partial} should be worth less than top CLIP`
  );

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
  const weights = { ...WEIGHTS, tagExact: 0 };
  const { order } = rankHybrid({
    query: 'brutalism',
    count: 2,
    weights,
    index: indexOf([['brutalism'], null], [[], 'brutalism everywhere']),
  });
  assert.deepEqual(order, [1, 0], 'story decides once tags are switched off');
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

// --- the spec's own inequalities, checked directly against the resolved
// weights, so a re-tune that breaks a margin fails loudly rather than
// silently reordering results (docs/search_rules.md "Balancing signals").

test('E clears the combined ceiling of every other signal', () => {
  const { tagExact, tagPartial, story, storyLong, clip } = WEIGHTS;
  assert.ok(tagExact > tagPartial + story + storyLong + clip, 'one exact tag always outranks everything else combined');
});

test('L (the long-story bonus) clears clip + tagPartial', () => {
  assert.ok(WEIGHTS.storyLong > WEIGHTS.clip + WEIGHTS.tagPartial);
});

test('a reasonably certain CLIP match (gate >= 0.5) clears the partial-tag budget', () => {
  assert.ok(WEIGHTS.clip * 0.5 >= WEIGHTS.tagPartial);
});

test('more exact tag matches always beat fewer', () => {
  const { order } = rankHybrid({
    query: 'alien impasto',
    count: 2,
    weights: WEIGHTS,
    index: indexOf([['alien'], null], [['alien', 'impasto'], null]),
  });
  assert.deepEqual(order, [1, 0], 'both tags beat one');
});

test('more partial tag matches beat fewer, for the same number of exact matches', () => {
  const { order } = rankHybrid({
    query: 'art deco moderne',
    count: 2,
    weights: WEIGHTS,
    // Neither term matches any keyword exactly; room 1 partially matches two,
    // room 0 only one - tagPartialSum is a SUM, so more terms is strictly more.
    index: indexOf([['art nouveau'], null], [['art nouveau', 'deco revival'], null]),
  });
  assert.deepEqual(order, [1, 0]);
});

test('a quoted phrase credits one match, not one per word it contains', () => {
  const [phraseRoom, splitRoom] = indexOf([['art nouveau', 'oak'], null], [['art', 'nouveau'], null]);

  const [phraseTerm] = parseQuery('"art nouveau"').terms;
  assert.deepEqual(classifyTagTerm(phraseTerm, phraseRoom.keywords), { exact: true, partial: 0 });
  // The room tagged with the two words SEPARATELY gets no credit at all - the
  // phrase never appears as a contiguous run in either keyword.
  assert.deepEqual(classifyTagTerm(phraseTerm, splitRoom.keywords), { exact: false, partial: 0 });
});

test('a long contiguous story match outranks CLIP and a maxed partial tag together', () => {
  // A whole matched clause outranks a room that is SIMULTANEOUSLY CLIP's top,
  // fully-confident pick and has a maxed-out partial tag match - the headline
  // property L's margin (L > clip + tagPartial) exists to guarantee. The query
  // needs enough contiguous content words to saturate storyLongChars's 40-char
  // ceiling (only glue words shorter than minTokenLength or on the stopword
  // list may sit between them without breaking the run).
  const query = 'a room walled entirely in glass and bathed in warm light';
  const clauseRoom = { keywords: [], story: `A ${query.replace(/^a /, '')}, though nothing else was said.` };
  // Near-misses of most query terms - each partial fraction is close to 1
  // (`term/(term+1)` chars), so seven of them comfortably saturate
  // TAG_PARTIAL_SATURATION without any of them being an exact match.
  const rivalRoom = {
    keywords: ['roomx', 'walledx', 'entirelyx', 'glassx', 'bathedx', 'warmx', 'lightx'],
    story: null,
  };

  assert.ok(
    longestMatchRun(
      buildSearchIndex([{ keywords: [], story: clauseRoom.story }])[0].story.sequence,
      new Set(tokenise(query).map(lemmatise))
    ) >= STORY_LONG_RANGE.high,
    'the fixture must actually saturate the long-match bonus'
  );

  const { order } = rankHybrid({
    query,
    count: 2,
    weights: WEIGHTS,
    embeddings: Int8Array.from([0, 0, 127, 0]),
    dim: 2,
    vector: Float32Array.from([1, 0]),
    index: indexOf([clauseRoom.keywords, clauseRoom.story], [rivalRoom.keywords, rivalRoom.story]),
  });
  assert.deepEqual(order, [0, 1], 'the long story match wins regardless');
});

test('a quoted phrase matches the story only as an ordered run, feeding storyLong', () => {
  const forward = { keywords: [], story: 'A room walled in glass, floor to ceiling.' };
  const scrambled = { keywords: [], story: 'The glass was walled in around the room, floor to ceiling.' };

  const { order } = rankHybrid({
    query: '"room walled in glass"',
    count: 2,
    weights: WEIGHTS,
    index: indexOf([forward.keywords, forward.story], [scrambled.keywords, scrambled.story]),
  });
  assert.deepEqual(order[0], 0, 'the ordered phrase match ranks above the scrambled words');
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
  assert.equal(matchCertainty({ tagCoverage: 1 }), 1, 'full tag coverage needs no help');
  assert.equal(matchCertainty({}), 0, 'nothing at all is certain of nothing');
  assert.ok(
    matchCertainty({ tagCoverage: 0.4, storyLongChars: STORY_LONG_RANGE.low, storyMatched: true }) >
      matchCertainty({ tagCoverage: 0.4 }),
    'agreement between two weak readings counts for more than either alone'
  );
});

test('a single matched story word sits at the moderate STORY_FLOOR, a full clause reaches 1', () => {
  assert.equal(matchCertainty({ storyMatched: true, storyLongChars: 0 }), STORY_FLOOR, 'one word, no run');
  assert.equal(matchCertainty({ storyMatched: true, storyLongChars: STORY_LONG_RANGE.high }), 1, 'a full clause');
  // storyLongChars alone cannot say "did anything match" - a match under the
  // ramp's floor and no match at all both read as chars=0.
  assert.equal(matchCertainty({ storyMatched: false, storyLongChars: 0 }), 0);
});

test('CLIP certainty is read off the raw cosine, against the three-anchor band', () => {
  const { centre, high, low } = CLIP_CERTAINTY;
  assert.equal(matchCertainty({ cosine: centre }), 0, 'at the no-opinion centre it says nothing');
  assert.equal(matchCertainty({ cosine: high + 0.05 }), 1, 'above the high extreme, as sure as it gets');
  assert.equal(matchCertainty({ cosine: low - 0.05 }), -1, 'below the low extreme, as sure it does NOT match');
  const posMid = matchCertainty({ cosine: (centre + high) / 2 });
  assert.ok(Math.abs(posMid - 0.5) < 1e-6, `halfway to the high extreme is ${posMid}`);
  const negMid = matchCertainty({ cosine: (centre + low) / 2 });
  assert.ok(Math.abs(negMid + 0.5) < 1e-6, `halfway to the low extreme is ${negMid}`);
});

test('signedClipCertainty is a monotone signed curve across all three anchors', () => {
  const { centre, high, low } = CLIP_CERTAINTY;
  assert.equal(signedClipCertainty(centre), 0, 'the no-opinion centre');
  assert.equal(signedClipCertainty(high + 1), 1, 'saturates at the high extreme');
  assert.equal(signedClipCertainty(low - 1), -1, 'saturates at the low extreme');
  assert.equal(signedClipCertainty(null), 0);
  assert.ok(signedClipCertainty((centre + high) / 2) > 0, 'above centre reads positive');
  assert.ok(signedClipCertainty((centre + low) / 2) < 0, 'below centre reads negative');
});

test('a query nothing matches clusters nothing, and does not even decide the order', () => {
  // The case the whole absolute reading exists for. Min-max normalisation gives
  // *some* room a score of 1 for any query at all, so relative CLIP alone
  // cannot tell "cghjj" from "art nouveau" - and a gradient driven by it would
  // cluster noise and claim a find. The raw cosines say what is really going
  // on: every one of these sits below the low extreme, so `clipCertaintyGate`
  // (the RANKING term, clamped to the positive half) is exactly 0 for all
  // three, and `clip * clipNorm * clipCertaintyGate` - the ranking's own CLIP
  // term - is silenced right along with any *positive* certainty. Ranking
  // falls back to stable id order, same as if there were no signal at all -
  // certainty itself now reads these as a confident mismatch (negative), which
  // is a different question the density gradient floors separately.
  const cosines = [-0.2, -0.15, -0.1];
  assert.ok(cosines.every((c) => c <= CLIP_CERTAINTY.low));
  const certainty = certaintyOf({ query: 'cghjj', embeddings: atCosines(...cosines) });

  assert.ok(Math.max(...certainty) <= 0, `expected no positive certainty, got ${[...certainty]}`);
  assert.ok(certainty.every((c) => c < CERTAINTY_FLOOR), 'and nothing that would survive the floor');

  assert.equal(Math.max(...normaliseScores(cosines)), 1, 'relative CLIP alone would have picked a "winner"');
  const { order } = rankHybrid({
    query: 'cghjj',
    count: 3,
    weights: WEIGHTS,
    embeddings: atCosines(...cosines),
    dim: 2,
    vector: CLIP_QUERY,
  });
  assert.deepEqual(order, [0, 1, 2], 'no signal cleared the gate, so nothing decided the order');
});

test('a cosine that clears the gate still leads once some of the corpus does not', () => {
  // The gate is continuous, not all-or-nothing across a corpus - once at
  // least one room clears it, the relative CLIP term differentiates the rest
  // exactly as before.
  const cosines = [0.4, -0.2, -0.3];
  const { order } = rankHybrid({
    query: 'cghjj',
    count: 3,
    weights: WEIGHTS,
    embeddings: atCosines(...cosines),
    dim: 2,
    vector: CLIP_QUERY,
  });
  assert.equal(order[0], 0, 'the room that actually cleared the gate still leads');
});

test('a strong cosine is certain on its own', () => {
  // "red", against rooms CLIP really does think are red: certainty falls off
  // gradually with the cosine, which is what makes the density falloff gradual.
  // `atCosines` round-trips every cosine through int8 quantisation, so these
  // land close to but not exactly on the anchors - the assertions below tie
  // to that, not to exact equality.
  const { centre, high } = CLIP_CERTAINTY;
  const midHigh = centre + (high - centre) / 2;
  const certainty = certaintyOf({ query: 'red', embeddings: atCosines(high + 0.1, midHigh, centre) });
  assert.equal(certainty[0], 1);
  assert.ok(Math.abs(certainty[1] - 0.5) < 0.05, `halfway to the high extreme gave ${certainty[1]}`);
  assert.ok(Math.abs(certainty[2]) < 0.05, `near the no-opinion centre gave ${certainty[2]}`);
});

test('an exact keyword match is certain whatever the picture looks like', () => {
  // "lora:yuiop" tagged on a room CLIP genuinely has no opinion about (cosine
  // at the no-opinion centre). The tag is the answer; the cosine has no say in
  // whether it is one.
  const { centre } = CLIP_CERTAINTY;
  const certainty = certaintyOf({
    query: 'yuiop',
    embeddings: atCosines(centre, centre, centre),
    index: indexOf([['yuiop'], null], [['oak'], null], [['pine'], null]),
  });
  assert.equal(certainty[0], 1, 'the tagged room');
  // `atCosines` round-trips `centre` through int8 quantisation, so it lands
  // close to but not exactly on it - hence the tolerance rather than `=== 0`.
  assert.ok(
    certainty.slice(1).every((c) => Math.abs(c) < 0.01),
    `expected nothing else to cluster at all, got ${[...certainty.slice(1)]}`
  );
});

test('a partial keyword is partially certain', () => {
  // 3/11 of "art nouveau" matched is 3/11 of a reason to pull it to the center.
  const certainty = certaintyOf({
    query: 'art',
    embeddings: atCosines(-0.1, -0.1, -0.1),
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
  const opts = { query: 'red', embeddings: atCosines(-0.1, -0.1, -0.1), dim: 2, vector: CLIP_QUERY };
  assert.equal(
    rankHybrid({ count: 3, weights: WEIGHTS, ...opts }).certainty[0],
    -1,
    'the default band reads it as a confident mismatch'
  );
  const loosened = rankHybrid({
    count: 3,
    weights: WEIGHTS,
    ...opts,
    clipCertainty: { centre: -0.2, high: -0.15, low: -0.3 },
  });
  assert.equal(loosened.certainty[0], 1, 'a shifted band makes the same cosine certain');
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

// --- folding with an index map, and the highlight ranges over it ------------

const marked = (text, ranges) => ranges.map((r) => text.slice(r.start, r.end));

test('foldWithMap agrees with fold, and maps every folded unit to its source', () => {
  for (const s of ['Art Nouveau', 'CAFE\u0301', 'caf\u00e9', '  padded  ', '', 'Ren\u00e9 & Co.']) {
    const { folded, map } = foldWithMap(s);
    assert.equal(folded.trim(), fold(s), `folded form of ${JSON.stringify(s)}`);
    assert.equal(map.length, folded.length, `map length for ${JSON.stringify(s)}`);
    // Non-decreasing, and always pointing inside the source.
    for (let i = 0; i < map.length; i++) {
      assert.ok(map[i] >= 0 && map[i] < s.length);
      if (i) assert.ok(map[i] >= map[i - 1]);
    }
  }
});

test('a range lands on the original text even when folding changed its length', () => {
  // Decomposed: five UTF-16 units for four folded ones. A folded index used as
  // a source index would slice one character short of the accent.
  const story = 'the cafe\u0301 was surveyed';
  assert.equal(story.length, 22);
  assert.deepEqual(marked(story, storyMatchRanges(story, ['cafe'])), ['cafe\u0301']);
});

test('a story marks the whole matched word, by lemma, and only real tokens', () => {
  // `with` is the only place `wit` occurs, and `with` is a stopword.
  const story = 'They surveyed the room with care.';

  // Lemmas agree, and the WHOLE word is marked rather than the lemma - `survey`
  // alone is not a thing a reader should be shown in place of `surveyed`.
  assert.deepEqual(marked(story, storyMatchRanges(story, ['survey'])), ['surveyed']);

  // `wit` shares no lemma with anything here, and `with` - the only word it
  // could have reached under the old prefix rule - is a stopword the story
  // index drops, so storyScore never credited it and nothing may be marked.
  assert.equal(storyScore(['wit'], buildSearchIndex([{ keywords: [], story }])[0].story), 0);
  assert.deepEqual(storyMatchRanges(story, ['wit']), []);

  // Two tokens overlapping one word produce ONE range, not two nested ones.
  assert.deepEqual(marked(story, storyMatchRanges(story, ['survey', 'surveyed'])), ['surveyed']);
});

test('a keyword marks by substring, where a story would have needed a lemma', () => {
  // `nouveau` is neither the lemma nor the start of `art nouveau`, but
  // keywordScore matches it by substring - so it must mark, and the story rule
  // must not be used here. The asymmetry between the two is the point.
  assert.ok(keywordScore(fold('nouveau'), ['nouveau'], ['art nouveau']) > 0);
  assert.deepEqual(marked('Art Nouveau', keywordMatchRanges('Art Nouveau', fold('nouveau'), ['nouveau'])), ['Nouveau']);

  // The whole query and its tokens, unioned into one range where they overlap.
  assert.deepEqual(
    marked('Art Nouveau', keywordMatchRanges('Art Nouveau', fold('art nouveau'), ['art', 'nouveau'])),
    ['Art Nouveau']
  );
});

test('anything marked scored, and anything that scored is marked', () => {
  const keywords = ['art nouveau', 'gilt', 'oak panelling'];
  const story = 'A surveyed hall of gilded oak, catalogued by an unnamed cartographer.';
  // Built by `buildSearchIndex`, not by hand. The index is lemmatised, and a
  // hand-rolled `new Set(tokenise(story))` silently stopped matching what the
  // scorer expects the moment story matching moved from prefixes to stems -
  // which made this test fail for a reason that was about the FIXTURE rather
  // than about the agreement it exists to check.
  const { keywords: indexed, story: storyStems } = buildSearchIndex([{ keywords: keywords.map((text) => ({ text })), story }])[0];

  for (const query of ['art', 'nouveau', 'gilt', 'oak', 'cartographer', 'survey', 'catalogue', 'the', 'a', 'zzz', 'art nouveau']) {
    const folded = fold(query);
    const tokens = tokenise(query);

    const kScored = keywordScore(folded, tokens, indexed) > 0;
    const kMarked = keywords.some((k) => keywordMatchRanges(k, folded, tokens).length > 0);
    assert.equal(kMarked, kScored, `keyword agreement for ${JSON.stringify(query)}`);

    const sScored = storyScore(tokens, storyStems) > 0;
    const sMarked = storyMatchRanges(story, tokens).length > 0;
    assert.equal(sMarked, sScored, `story agreement for ${JSON.stringify(query)}`);
  }
});

// --- the score breakdown, and the rule it has to keep honest ---------------

test('rankHybrid reports the components it sorted on, by rank', () => {
  const { order, breakdown } = rankHybrid({
    query: 'oak',
    count: 3,
    weights: WEIGHTS,
    index: indexOf([['oak'], null, ['gilt']], null, null),
  });

  // Parallel to `order`, i.e. by RANK - the same convention `certainty` uses.
  assert.equal(order[0], 0);
  assert.equal(breakdown.tagExact[0], 1);
  assert.equal(breakdown.score[0], WEIGHTS.tagExact * 1);
  // Ranks nothing matched carry zeroes rather than being absent.
  assert.equal(breakdown.tagExact[1], 0);
  assert.equal(breakdown.score[1], 0);
  for (const arr of Object.values(breakdown)) assert.equal(arr.length, 3);
});

test('ranks/ties are independent per-signal sorts, parallel to order like breakdown', () => {
  // Room 0: a weak partial tag hit, nothing else. Room 1: no text at all, but
  // the corpus's strongest CLIP cosine (weights.clip's full 1.0 clears
  // weights.tagPartial's 0.45 ceiling outright, whatever the partial fraction
  // is) - so the COMPOSITE score puts room 1 first. The tag axis must still
  // put room 0 first, since it is the only one of the two with any tag signal
  // at all - that divergence from `order` is the whole reason a per-axis rank
  // exists separately from it.
  const { order, ranks, ties } = rankHybrid({
    query: 'oak',
    count: 3,
    weights: WEIGHTS,
    index: indexOf([['oakenwood'], null], null, null),
    embeddings: atCosines(0.05, 0.3, -0.5),
    dim: 2,
    vector: CLIP_QUERY,
  });

  assert.equal(order[0], 1, 'the composite score favors the maxed-out clip term');
  const rankOfRoom = (axis, id) => ranks[axis][order.indexOf(id)];
  const tiesOfRoom = (axis, id) => ties[axis][order.indexOf(id)];

  assert.equal(rankOfRoom('tag', 0), 1, 'room 0 is the only one with any tag signal at all');
  assert.equal(tiesOfRoom('tag', 0), 0);
  // Rooms 1 and 2 both score zero on the tag axis - genuinely tied there, even
  // though the composite score (reading CLIP) puts them at opposite ends.
  assert.equal(rankOfRoom('tag', 1), 2);
  assert.equal(rankOfRoom('tag', 2), 2);
  assert.equal(tiesOfRoom('tag', 1), 1);
  assert.equal(tiesOfRoom('tag', 2), 1);
});

test('a tie on one axis is reported as tied, even when the composite score is not', () => {
  // Same tag signal (one exact match each), different CLIP cosines - so the
  // composite order separates them, but the tag axis must call it a tie.
  const { order, ranks, ties } = rankHybrid({
    query: 'oak',
    count: 3,
    weights: WEIGHTS,
    index: indexOf([['oak'], null], [['oak'], null], null),
    embeddings: atCosines(0.3, 0.1, -0.5),
    dim: 2,
    vector: CLIP_QUERY,
  });

  const rankOfRoom = (axis, id) => ranks[axis][order.indexOf(id)];
  const tiesOfRoom = (axis, id) => ties[axis][order.indexOf(id)];
  assert.equal(rankOfRoom('tag', 0), 1);
  assert.equal(rankOfRoom('tag', 1), 1, 'competition ranking: a tie shares the better rank, not the worse');
  assert.equal(tiesOfRoom('tag', 0), 1);
  assert.equal(tiesOfRoom('tag', 1), 1);
  // Room 2 has no tag match at all - not tied with the two that share one.
  assert.equal(rankOfRoom('tag', 2), 3);
  assert.equal(tiesOfRoom('tag', 2), 0);

  // The CLIP axis, meanwhile, has no ties: three distinct cosines.
  for (const id of [0, 1, 2]) assert.equal(tiesOfRoom('clip', id), 0);
  assert.equal(rankOfRoom('clip', 0), 1, 'highest cosine (0.3)');
  assert.equal(rankOfRoom('clip', 1), 2);
  assert.equal(rankOfRoom('clip', 2), 3, 'lowest cosine (-0.5)');
});

test('explainScore omits a silent signal rather than printing it as zero', () => {
  const { breakdown, certainty } = rankHybrid({
    query: 'oak',
    count: 2,
    weights: WEIGHTS,
    index: indexOf([['oak'], null], null, null),
  });

  const { rows, total } = explainScore(0, { breakdown, certainty, weights: WEIGHTS });
  assert.deepEqual(rows.map((r) => r.key), ['tagExact']);
  assert.equal(rows[0].weighted, WEIGHTS.tagExact);
  assert.equal(total, WEIGHTS.tagExact);
});

test('a CLIP row shows the raw cosine beside the relative one, so a certain-looking 1.00 reads as uncertain', () => {
  // Every cosine is below `clipLow`: CLIP reads all of these as a confident
  // MISMATCH, not merely "no opinion". Min-maxing still puts the best of them
  // at exactly 1.00, which is the trap - a breakdown printing that alone would
  // claim a confident match.
  const cosines = [-0.1, -0.15, -0.2];
  assert.ok(cosines.every((c) => c < CLIP_CERTAINTY.low));

  const { breakdown, certainty } = rankHybrid({
    query: 'cghjj',
    count: 3,
    weights: WEIGHTS,
    dim: 2,
    vector: CLIP_QUERY,
    embeddings: atCosines(...cosines),
  });

  const { rows, certainty: sure } = explainScore(0, { breakdown, certainty, weights: WEIGHTS });
  const clip = rows.find((r) => r.key === 'clip');

  assert.equal(breakdown.clip[0], 1, 'relative score is the top of the range');
  assert.ok(Math.abs(clip.raw - cosines[0]) < 0.01, 'the row carries the RAW cosine');
  assert.ok(clip.raw < CLIP_CERTAINTY.low, 'which is below the low extreme');
  assert.equal(clip.signedPercent, -99.99, 'the CLIP row reports it as a clamped signed percentage');
  assert.equal(sure, -1, 'and certainty, computed absolutely, agrees it is a confident mismatch');
});
