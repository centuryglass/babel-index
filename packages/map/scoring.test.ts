import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchIndex,
  classifyTagTerm,
  CLIP_STRENGTH,
  explainRanking,
  fold,
  foldWithMap,
  keywordMatchRanges,
  lemmatise,
  longestMatchRun,
  matchStrength,
  parseQuery,
  rankHybrid,
  clipCurveStrength,
  STORY_LONG_RANGE,
  storyMatchRanges,
  storyPhraseRun,
  storyWordMatches,
  strengthPercent,
  tagTermsOf,
  tokenise,
} from './scoring.ts';
import { STRENGTH_FLOOR } from './ordering.ts';
import { DEFAULTS } from '../config/config.ts';

const WEIGHTS = DEFAULTS.search.weights;

/** One fixture room: `[keywords, story]`, or `null` for a room with no metadata at all. */
type RoomFixture = [string[] | null | undefined, string | null | undefined] | null;

/**
 * An index over rooms given as `[keywords, story]` pairs, in id order.
 * A bare `null` is a room with no metadata at all.
 */
const indexOf = (...rooms: RoomFixture[]) =>
  buildSearchIndex(
    rooms.map((room) => {
      if (!room) return null;
      const [keywords, story] = room;
      if (!keywords?.length && !story) return null;
      return { keywords: (keywords ?? []).map((text) => ({ text })), story };
    })
  );

// --- folding and tokenising -------------------------------------------------

test('folding removes case and diacritics [SR-02]', () => {
  assert.equal(fold('  Art NOUVEAU  '), 'art nouveau');
  assert.equal(fold('rosé'), 'rose');
  assert.equal(fold('Jugendstil'), 'jugendstil');
  assert.equal(fold(null), '');
});

test('folding transliterates letters NFD cannot decompose [SR-02]', () => {
  // ł, unlike é, is a letter in its own right rather than a base plus a
  // combining mark, so NFD leaves it untouched - any-ascii is what closes
  // the gap between "Zdzisław" and "Zdzislaw".
  assert.equal(fold('Zdzisław Beksiński'), fold('Zdzislaw Beksinski'));
  assert.equal(fold('Zdzisław'), 'zdzislaw');
});

test('tokenising drops short words and stopwords [SR-06]', () => {
  assert.deepEqual(tokenise('The Room of Wet Collodion'), ['room', 'wet', 'collodion']);
  assert.deepEqual(tokenise('a to at'), [], 'nothing survives the length floor');
  assert.deepEqual(tokenise('art', { minLength: 4 }), [], 'the floor is configurable');
});

// --- story scoring ----------------------------------------------------------

const story = (text) => buildSearchIndex([{ keywords: [], story: text }])[0].story;

test('a story word counts the same in a long story as in a short one', () => {
  const short = story('A cartographer waits.');
  const long = story(
    'A cartographer waits in a room that the catalogue insists was surveyed twice, ' +
      'though the second survey is filed under a name nobody will read aloud, and the ' +
      'shelves go on well past the point where counting them stops being useful.'
  );
  assert.equal(storyWordMatches(['cartographer'], short), 1);
  assert.equal(storyWordMatches(['cartographer'], long), 1);
});

test('story matches count distinct query words, and a word the story lacks takes nothing away', () => {
  const s = story('An oil lamp lit the cartographer.');
  assert.equal(storyWordMatches(['cartographer', 'oil'], s), 2);
  assert.equal(storyWordMatches(['cartographer', 'oil', 'zeppelin'], s), 2);
  assert.equal(storyWordMatches(['lamp', 'lamps'], s), 1, 'two tokens with one lemma count once');
});

test('a token matches a story word by lemma, both directions [SR-04]', () => {
  assert.equal(storyWordMatches(['room'], story('The rooms are numbered.')), 1);
  assert.equal(storyWordMatches(['survey'], story('It was surveyed once.')), 1);
  // Lemma matching is two-way: either word of the pair can come from the query.
  assert.equal(storyWordMatches(['surveyed'], story('A survey.')), 1, 'lemmatising is two-way');
});

test('a lemma match is a word match, not a prefix match [SR-04]', () => {
  // The motivating case: "cat" must not be dragged in by "catalogue".
  assert.equal(storyWordMatches(['cat'], story('The cats slept on the shelf.')), 1);
  assert.equal(storyWordMatches(['cat'], story('An intricate catalogue of rooms.')), 0);
});

test('a lemma match does not collide across unrelated word families [SR-04]', () => {
  // A suffix stemmer collapses "animation" and "animal" to one stem; lemma
  // lookup keeps the families apart.
  assert.equal(storyWordMatches(['animation'], story('A short animation played on loop.')), 1);
  assert.equal(storyWordMatches(['animation'], story('Stone animals lined the hall.')), 0);
  assert.equal(storyWordMatches(['animal'], story('Stone animals lined the hall.')), 1);
  assert.equal(storyWordMatches(['animal'], story('A short animation played on loop.')), 0);
});

test('an empty story or query scores zero', () => {
  assert.equal(storyWordMatches(['anything'], story('')), 0);
  assert.equal(storyWordMatches([], story('a real story about copper')), 0);
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

test('the longest run is measured by lemma, matching storyWordMatches', () => {
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

test('a phrase run must be truly consecutive, not just present [SR-05]', () => {
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

test('a quoted phrase is one term, not one per word inside it [SR-05]', () => {
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

test('an exact term match is exact, not a 1.0 partial [SR-12]', () => {
  const { terms } = parseQuery('oak');
  assert.deepEqual(classifyTagTerm(terms[0], ['oak', 'art nouveau']), { exact: true, partial: 0 });
});

test('a partial term match is the fraction of the keyword it covers', () => {
  const { terms } = parseQuery('art');
  assert.deepEqual(classifyTagTerm(terms[0], ['art nouveau']), { exact: false, partial: 3 / 11 });
});

test('a quoted phrase is classified as one whole-phrase match, not per word [SR-05]', () => {
  const { terms } = parseQuery('"art nouveau"');
  assert.deepEqual(classifyTagTerm(terms[0], ['art nouveau', 'oak']), { exact: true, partial: 0 });

  // The room tagged with the two words separately gets no credit at all - the
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

// --- the blend --------------------------------------------------------------

test('an exact keyword match outranks the best possible CLIP score [SR-10]', () => {
  // The design's headline property, and the reason the weights are what they
  // are. Room 1 is CLIP's favourite; room 0 merely has the keyword.
  const embeddings = Int8Array.from([0, 127, 127, 0]);
  const { order } = rankHybrid({
    query: 'brutalism',
    count: 2,
    weights: WEIGHTS,
    embeddings,
    dim: 2,
    scale: 127,
    vector: Float32Array.from([0, 1]),
    index: indexOf([['brutalism'], null], [['oak'], null]),
  });
  assert.deepEqual(order, [0, 1]);
});

test('CLIP still orders everything the text signals are silent about [SR-11]', () => {
  // Most of the collection, for most queries. Rooms 1 and 2 have no keyword match,
  // so their relative order is CLIP's to decide.
  const embeddings = Int8Array.from([0, 0, 40, 0, 127, 0]);
  const { order } = rankHybrid({
    query: 'brutalism',
    count: 3,
    weights: WEIGHTS,
    embeddings,
    dim: 2,
    scale: 127,
    vector: Float32Array.from([1, 0]),
    index: indexOf([['brutalism'], null], [['oak'], null], [['pine'], null]),
  });
  assert.deepEqual(order, [0, 2, 1], 'keyword first, then the two by CLIP');
});

test('a weak partial tag does not beat a room CLIP is confident about [SR-12]', () => {
  // The difference between blending and tiering. Room 0 matches "art"
  // against a long keyword - a small fraction of it - while room 1 is CLIP's
  // clear favourite and matches no text at all. Any scheme that sorts "has a
  // keyword hit" ahead of "has none" puts room 0 first; the blend does not,
  // because a partial pulls at `tagPartial` times its fraction.
  const { partial } = classifyTagTerm(parseQuery('art').terms[0], ['art nouveau and gilded rosewood']);
  assert.ok(WEIGHTS.tagPartial * partial < WEIGHTS.clip, `partial ${partial} should pull less than top CLIP`);

  const { order } = rankHybrid({
    query: 'art',
    count: 2,
    weights: WEIGHTS,
    embeddings: Int8Array.from([0, 0, 127, 0]),
    dim: 2,
    scale: 127,
    vector: Float32Array.from([1, 0]),
    index: indexOf([['art nouveau and gilded rosewood'], null], [['oak'], null]),
  });
  assert.deepEqual(order, [1, 0], 'CLIP wins over a weak partial - blended, not tiered');
});

test('an undescribed room still outranks a described one CLIP likes less', () => {
  // Most of a real collection has no metadata yet. Rooms without an entry must be
  // ranked by whatever signal does apply, not parked below every described
  // room - otherwise adding keywords to one room demotes the whole rest.
  const { order } = rankHybrid({
    query: 'sailboat',
    count: 2,
    weights: WEIGHTS,
    embeddings: Int8Array.from([0, 0, 127, 0]),
    dim: 2,
    scale: 127,
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

test('the whole collection is sorted, not just the matches [SR-08]', () => {
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

test('rooms nothing matched keep their id order rather than shuffling [SR-15]', () => {
  const { order } = rankHybrid({
    query: 'copper',
    count: 4,
    weights: WEIGHTS,
    index: indexOf([['copper'], null], null, null, null),
  });
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test('text-only ranking works with no embeddings at all [SR-21]', () => {
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

test('CLIP-only ranking works with no metadata at all [SR-21]', () => {
  const { order, signals } = rankHybrid({
    query: 'anything',
    count: 2,
    weights: WEIGHTS,
    embeddings: Int8Array.from([0, 127, 127, 0]),
    dim: 2,
    scale: 127,
    vector: Float32Array.from([1, 0]),
    index: null,
  });
  assert.deepEqual(order, [1, 0]);
  assert.equal(signals.clip, true);
  assert.equal(signals.keyword, false);
});

test('signals report what matched, not what was available [SR-01] [SR-21]', () => {
  // A collection full of keywords that this query missed must not be reported as a
  // keyword-driven ranking.
  const { signals } = rankHybrid({
    query: 'sailboat',
    count: 2,
    weights: WEIGHTS,
    index: indexOf([['brutalism'], 'A room of concrete.'], [['oak'], null]),
  });
  assert.deepEqual(signals, { clip: false, keyword: false, title: false, story: false });
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

test('rooms without metadata are ranked, not dropped [SR-08]', () => {
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
  assert.deepEqual(signals, { clip: false, keyword: false, title: false, story: false });
});

test('a story index built at minTokenLength matches the short query words that setting lets through', () => {
  const story = 'An ox stands in the reading room.';
  const index = buildSearchIndex([{ keywords: [], story }], { minLength: 2 });
  const { breakdown } = rankHybrid({ query: 'ox', count: 1, weights: WEIGHTS, index, minTokenLength: 2 });
  assert.ok(breakdown.story[0] > 0, 'the two-letter word is in the index and scores');
  assert.deepEqual(storyMatchRanges(story, ['ox'], { minLength: 2 }), [{ start: 3, end: 5 }]);
});

test('an exact title match is as strong as an exact tag match', () => {
  const index = buildSearchIndex([
    { keywords: [{ text: 'unsurveyed' }], story: null },
    { title: 'Unsurveyed', story: null },
  ]);
  const { order, strength, breakdown } = rankHybrid({ query: 'unsurveyed', count: 2, weights: WEIGHTS, index });
  assert.deepEqual([...strength], [1, 1]);
  assert.equal(breakdown.tagExact[order.indexOf(0)], 1);
  assert.equal(breakdown.titleExact[order.indexOf(1)], 1);
});

test('two exact tag matches still beat one exact title match', () => {
  const index = buildSearchIndex([
    { keywords: [{ text: 'brass' }, { text: 'oak' }], story: null },
    { title: 'Brass Oak', story: null },
  ]);
  const { order } = rankHybrid({ query: 'brass oak', count: 2, weights: WEIGHTS, index });
  assert.equal(order[0], 0, 'two exact tags outrank a single exact title match');
});

test('a partial title match does not sum across terms - it is the same string read twice', () => {
  const index = buildSearchIndex([{ title: 'The Unsurveyed Room', story: null }]);
  const { breakdown } = rankHybrid({ query: 'unsurveyed room', count: 1, weights: WEIGHTS, index });
  // "unsurveyed", "room" and the whole query each partially match the same
  // title; titlePartial is the best of the three, never their sum
  // (docs/search_rules.md "Title matching"). The whole query wins here - it
  // covers 15 of the title's 19 characters where either word alone covers
  // less - which is the whole-query reading working, not a sum.
  const title = 'the unsurveyed room';
  const best = 'unsurveyed room'.length / title.length;
  assert.ok(Math.abs(breakdown.titlePartial[0] - best) < 1e-6, `expected ${best}, got ${breakdown.titlePartial[0]}`);
  assert.ok(breakdown.titlePartial[0] <= 1, 'a fraction of one string, never a sum over terms');
  assert.equal(breakdown.titleExact[0], 0);
});

// --- the whole-query reading ------------------------------------------------

test('a multi-word tag typed plainly is an exact match, same as quoted [SR-03]', () => {
  const index = indexOf([['outsider art'], null], [['oak'], null]);
  const plain = rankHybrid({ query: 'outsider art', count: 2, weights: WEIGHTS, index });
  const quoted = rankHybrid({ query: '"outsider art"', count: 2, weights: WEIGHTS, index });
  assert.equal(plain.breakdown.tagExact[0], 1, 'typing the tag is an exact tag match');
  assert.equal(quoted.breakdown.tagExact[0], 1, 'and quoting it still is');
  assert.equal(plain.order[0], 0);
});

test('typing a room tag verbatim reports it as a maximally strong match [SR-18]', () => {
  for (const query of ['outsider art', '"outsider art"', 'databending']) {
    const index = indexOf([['outsider art', 'databending'], null], [['oak'], null]);
    const { strength, order } = rankHybrid({ query, count: 2, weights: WEIGHTS, index });
    assert.equal(order[0], 0, `${query} should find the room it names`);
    assert.equal(strength[0], 1, `${query} should read as a full-strength match, got ${strength[0]}`);
  }
});

test('the better of the two readings wins, so separate exact tags still beat one phrase [SR-03]', () => {
  // `brutalism mezzotint` matches two keywords exactly per term, and the
  // whole-query reading matches neither - the per-term reading has to stand.
  const index = indexOf([['brutalism', 'mezzotint'], null], [['brutalism mezzotint'], null]);
  const { breakdown, order } = rankHybrid({ query: 'brutalism mezzotint', count: 2, weights: WEIGHTS, index });
  assert.equal(order[0], 0, 'two exact tag matches outrank one exact phrase match');
  assert.equal(breakdown.tagExact[0], 2);
  assert.equal(breakdown.tagExact[1], 1, 'the phrase room still gets its one exact match');
});

test('a one-term query gains nothing from the whole-query reading [SR-03]', () => {
  const index = indexOf([['oak'], null]);
  const { breakdown } = rankHybrid({ query: 'oak', count: 1, weights: WEIGHTS, index });
  assert.equal(breakdown.tagExact[0], 1, 'counted once, not once per reading');
});

// --- strength is absolute, not a share of the query -------------------------

test('a room matching one tag exactly does not weaken as the query grows [SR-17]', () => {
  const index = indexOf([['verdigris'], null], [['oak'], null]);
  const short = rankHybrid({ query: 'verdigris', count: 2, weights: WEIGHTS, index });
  const long = rankHybrid({
    query: 'verdigris green smear across the walls',
    count: 2,
    weights: WEIGHTS,
    index,
  });
  assert.equal(short.strength[0], 1);
  assert.equal(
    long.strength[0],
    1,
    `adding unrelated words must not weaken a room that still matches a tag exactly, got ${long.strength[0]}`
  );
});

test('the best term decides strength, while the count still decides rank [SR-17]', () => {
  // One room matches both terms, the other only one. Both are full strength
  // for what they matched; the placement tiebreak on exact count separates
  // them.
  const index = indexOf([['brutalism', 'mezzotint'], null], [['brutalism'], null]);
  const { order, strength, breakdown } = rankHybrid({
    query: 'brutalism mezzotint',
    count: 2,
    weights: WEIGHTS,
    index,
  });
  assert.deepEqual([...order], [0, 1], 'more exact matches still ranks higher');
  assert.ok(breakdown.tagExact[0] > breakdown.tagExact[1], 'and the count is what says so');
  assert.equal(strength[0], 1);
  assert.equal(strength[1], 1, 'a room that matched one tag exactly is full strength for that tag');
});

test('a quoted phrase matching the whole title is one exact title match', () => {
  const index = buildSearchIndex([{ title: 'The Unsurveyed Room', story: null }]);
  const { breakdown } = rankHybrid({ query: '"the unsurveyed room"', count: 1, weights: WEIGHTS, index });
  assert.equal(breakdown.titleExact[0], 1);
});

test('a room with no title contributes nothing on the title axis', () => {
  const index = buildSearchIndex([{ keywords: [{ text: 'oak' }], story: null }]);
  const { breakdown, signals } = rankHybrid({ query: 'oak', count: 1, weights: WEIGHTS, index });
  assert.equal(breakdown.titleExact[0], 0);
  assert.equal(breakdown.titlePartial[0], 0);
  assert.equal(signals.title, false);
});

test('an exact title match is full strength whatever the picture looks like', () => {
  assert.equal(matchStrength({ title: 1 }), 1);
});

test('more exact tag matches always beat fewer [SR-13]', () => {
  const { order } = rankHybrid({
    query: 'alien impasto',
    count: 2,
    weights: WEIGHTS,
    index: indexOf([['alien'], null], [['alien', 'impasto'], null]),
  });
  assert.deepEqual(order, [1, 0], 'both tags beat one');
});

test('more partial tag matches beat fewer, for the same number of exact matches [SR-13]', () => {
  const { order } = rankHybrid({
    query: 'art deco moderne',
    count: 2,
    weights: WEIGHTS,
    // Neither term matches any keyword exactly; room 1 partially matches two,
    // room 0 only one - tagPartialSum is a sum, so more terms is strictly more.
    index: indexOf([['art nouveau'], null], [['art nouveau', 'deco revival'], null]),
  });
  assert.deepEqual(order, [1, 0]);
});

test('a quoted phrase credits one match, not one per word it contains', () => {
  const [phraseRoom, splitRoom] = indexOf([['art nouveau', 'oak'], null], [['art', 'nouveau'], null]);

  const [phraseTerm] = parseQuery('"art nouveau"').terms;
  assert.deepEqual(classifyTagTerm(phraseTerm, phraseRoom.keywords), { exact: true, partial: 0 });
  // The room tagged with the two words separately gets no credit at all - the
  // phrase never appears as a contiguous run in either keyword.
  assert.deepEqual(classifyTagTerm(phraseTerm, splitRoom.keywords), { exact: false, partial: 0 });
});

test('a long contiguous story match outranks CLIP at its most confident [SR-10]', () => {
  // A whole matched clause outranks a room that is CLIP's top pick and
  // matches no text. The query needs enough contiguous content words to
  // saturate the run curve (`STORY_LONG_RANGE.high`); only glue words shorter
  // than minTokenLength or on the stopword list may sit between them.
  const query = 'a room walled entirely in glass and bathed in warm light';
  const clauseStory = `A ${query.replace(/^a /, '')}, though nothing else was said.`;

  assert.ok(
    longestMatchRun(
      buildSearchIndex([{ keywords: [], story: clauseStory }])[0].story.sequence,
      new Set(tokenise(query).map(lemmatise))
    ) >= STORY_LONG_RANGE.high,
    'the fixture must actually saturate the run curve'
  );
  assert.ok(WEIGHTS.storyLong > WEIGHTS.clip, 'a full run alone outpulls CLIP at its most confident');

  const { order } = rankHybrid({
    query,
    count: 2,
    weights: WEIGHTS,
    embeddings: Int8Array.from([0, 0, 127, 0]),
    dim: 2,
    scale: 127,
    vector: Float32Array.from([1, 0]),
    index: indexOf([[], clauseStory], [['oak'], null]),
  });
  assert.deepEqual(order, [0, 1], 'the long story match wins');
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

// --- strength, which drives the map's density gradient ---------------------

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

const strengthOf = (opts) =>
  rankHybrid({ count: 3, weights: WEIGHTS, dim: 2, scale: 127, vector: CLIP_QUERY, ...opts }).strength;

test('a soft OR: any axis can carry strength, and two weak ones agree [SR-14]', () => {
  assert.equal(matchStrength({ tag: 1 }), 1, 'a tag matched whole needs no help');
  assert.equal(matchStrength({}), 0, 'no evidence is no strength');
  assert.ok(matchStrength({ tag: 0.4, story: 0.3 }) > matchStrength({ tag: 0.4 }), 'two weak axes beat either alone');
});

test('one matched story word pulls at weights.story, and a full clause at least weights.storyLong', () => {
  const clause = 'a room walled entirely in glass and bathed in warm light';
  const index = indexOf([[], 'The cat slept.'], [[], `A ${clause.replace(/^a /, '')}.`]);
  const word = rankHybrid({ query: 'cat', count: 2, weights: WEIGHTS, index });
  assert.ok(Math.abs(word.strength[0] - WEIGHTS.story) < 1e-6, `one word gave ${word.strength[0]}`);
  const run = rankHybrid({ query: clause, count: 2, weights: WEIGHTS, index });
  assert.equal(run.order[0], 1);
  assert.ok(run.strength[0] >= WEIGHTS.storyLong, `a full clause gave ${run.strength[0]}`);
});

test('CLIP strength is read off the raw cosine, against the anchor band [SR-16] [SR-19]', () => {
  const { centre, high } = CLIP_STRENGTH;
  const strength = strengthOf({ query: 'red', embeddings: atCosines(high + 0.05, centre - 0.1, (centre + high) / 2) });
  // `atCosines` round-trips each cosine through int8, hence the tolerances.
  assert.ok(Math.abs(strength[0] - WEIGHTS.clip) < 1e-6, `past the high anchor gave ${strength[0]}`);
  assert.ok(Math.abs(strength[1] - WEIGHTS.clip / 2) < 0.05, `halfway gave ${strength[1]}`);
  assert.equal(strength[2], 0, 'below centre is no evidence, not a mismatch');
});

test('strengthPercent reports the full 0-100 range, clamped at both ends', () => {
  assert.equal(strengthPercent(0), 0);
  assert.equal(strengthPercent(1), 100);
  assert.equal(strengthPercent(0.41), 41);
  assert.equal(strengthPercent(-0.5), 0);
  assert.equal(strengthPercent(1.5), 100);
});

test('clipCurveStrength is a monotone [0, 1] curve, zero at and below the centre [SR-16]', () => {
  const { centre, high } = CLIP_STRENGTH;
  assert.equal(clipCurveStrength(centre), 0, 'the no-opinion centre');
  assert.equal(clipCurveStrength(high + 1), 1, 'saturates at the high extreme');
  assert.equal(clipCurveStrength(centre - 0.01), 0, 'below centre reads as no evidence');
  assert.equal(clipCurveStrength(centre - 1), 0, 'however far below');
  assert.equal(clipCurveStrength(null), 0);
  assert.ok(clipCurveStrength((centre + high) / 2) > 0, 'above centre reads positive');
});

test('match strength stays in [0, 1], whatever the pulls [SR-16]', () => {
  for (const parts of [{ clip: -1 }, { tag: 0.3, clip: -1 }, { story: 2 }, { tag: NaN }, {}]) {
    const s = matchStrength(parts);
    assert.ok(s >= 0 && s <= 1, `${JSON.stringify(parts)} gave ${s}`);
    assert.ok(!Object.is(s, -0), `${JSON.stringify(parts)} gave -0`);
  }
});

test('a query nothing matches clusters nothing, and does not even decide the order [SR-19]', () => {
  // Every cosine sits below the no-opinion centre, so CLIP finds no evidence
  // for any room. A reading relative to the collection would still crown one of
  // them; strength reads the raw cosine, so all three stay at 0 and keep id
  // order, as if there were no signal at all.
  const cosines = [-0.2, -0.15, -0.1];
  assert.ok(cosines.every((c) => c < CLIP_STRENGTH.centre));
  const { order, strength } = rankHybrid({
    query: 'cghjj',
    count: 3,
    weights: WEIGHTS,
    embeddings: atCosines(...cosines),
    dim: 2,
    scale: 127,
    vector: CLIP_QUERY,
  });
  assert.ok(strength.every((c) => c === 0), `expected zero strength, got ${[...strength]}`);
  assert.ok(strength.every((c) => c < STRENGTH_FLOOR), 'and nothing that would survive the floor');
  assert.deepEqual(order, [0, 1, 2], 'nothing cleared the centre, so nothing decided the order');
});

test('a cosine that clears the centre leads the rooms that do not [SR-11]', () => {
  const cosines = [0.4, -0.2, -0.3];
  const { order } = rankHybrid({
    query: 'cghjj',
    count: 3,
    weights: WEIGHTS,
    embeddings: atCosines(...cosines),
    dim: 2,
    scale: 127,
    vector: CLIP_QUERY,
  });
  assert.equal(order[0], 0, 'the room that cleared the centre leads');
});

test('a strong cosine reaches CLIP\'s full weight on its own [SR-16]', () => {
  // "red", against rooms planted past the high anchor, halfway to it, and at
  // the no-opinion centre: strength falls off gradually with the cosine,
  // which is what makes the density falloff gradual. `atCosines` round-trips
  // every cosine through int8 quantisation, so these land close to but not
  // on the anchors - hence the tolerances.
  const { centre, high } = CLIP_STRENGTH;
  const midHigh = centre + (high - centre) / 2;
  const strength = strengthOf({ query: 'red', embeddings: atCosines(high + 0.1, midHigh, centre) });
  assert.ok(Math.abs(strength[0] - WEIGHTS.clip) < 1e-6);
  assert.ok(Math.abs(strength[1] - WEIGHTS.clip / 2) < 0.05, `halfway to the high extreme gave ${strength[1]}`);
  assert.ok(Math.abs(strength[2]) < 0.05, `near the no-opinion centre gave ${strength[2]}`);
});

test('an exact keyword match is full strength whatever the picture looks like', () => {
  // "lora:yuiop" tagged on a room CLIP genuinely has no opinion about (cosine
  // at the no-opinion centre). The tag is the answer; the cosine has no say in
  // whether it is one.
  const { centre } = CLIP_STRENGTH;
  const strength = strengthOf({
    query: 'yuiop',
    embeddings: atCosines(centre, centre, centre),
    index: indexOf([['yuiop'], null], [['oak'], null], [['pine'], null]),
  });
  assert.equal(strength[0], 1, 'the tagged room');
  // `centre` round-trips through `atCosines`' int8 quantisation, so it lands
  // near it but not on it - hence the tolerance rather than `=== 0`.
  assert.ok(
    strength.slice(1).every((c) => Math.abs(c) < 0.01),
    `expected nothing else to cluster at all, got ${[...strength.slice(1)]}`
  );
});

test('a partial keyword pulls by the fraction it covers', () => {
  // 3/11 of "art nouveau" matched pulls at 3/11 of `tagPartial`.
  const strength = strengthOf({
    query: 'art',
    embeddings: atCosines(-0.1, -0.1, -0.1),
    index: indexOf([['art nouveau'], null], [['oak'], null], [['pine'], null]),
  });
  assert.ok(Math.abs(strength[0] - (WEIGHTS.tagPartial * 3) / 11) < 1e-6, `got ${strength[0]}`);
});

test('strength is indexed by rank, not by room', () => {
  // The layout pours it into slots in rank order, so a mismatch here would
  // cluster the wrong rooms - and would look plausible while doing it.
  const { order, strength } = rankHybrid({
    query: 'oak',
    count: 3,
    weights: WEIGHTS,
    index: indexOf(null, null, [['oak'], null]),
  });
  assert.equal(order[0], 2, 'room 2 has the keyword');
  assert.equal(strength[0], 1, 'and its strength is at rank 0, not at index 2');
  assert.equal(strength.length, 3);
});

test('a room is placed by the strength it reports, so strength never rises with rank [SR-22]', () => {
  // One room per axis, in id order that disagrees with strength order: a
  // partial tag, scattered story words, a confident CLIP match and an exact
  // tag. Each rank's strength must be the soft OR of the pulls reported for
  // that same rank, and no rank may report more than the one above it.
  const { centre, high } = CLIP_STRENGTH;
  const { order, strength, breakdown } = rankHybrid({
    query: 'glass tower',
    count: 5,
    weights: WEIGHTS,
    embeddings: atCosines(centre - 0.1, centre - 0.1, centre - 0.1, high + 0.1, centre - 0.1),
    dim: 2,
    scale: 127,
    vector: CLIP_QUERY,
    index: indexOf(
      null,
      [['glassblowing'], null],
      [[], 'The tower leaned. Its glass had long since gone.'],
      null,
      [['glass'], null]
    ),
  });

  assert.deepEqual(order, [4, 3, 2, 1, 0], 'exact tag, then CLIP, then story words, then partial tag');
  for (let rank = 0; rank < order.length; rank++) {
    const pulls = {
      tag: breakdown.tag[rank],
      title: breakdown.title[rank],
      story: breakdown.story[rank],
      clip: breakdown.clip[rank],
    };
    assert.ok(Math.abs(strength[rank] - matchStrength(pulls)) < 1e-6, `rank ${rank} reports its own pulls`);
    if (rank > 0) assert.ok(strength[rank] <= strength[rank - 1], `rank ${rank} rose above rank ${rank - 1}`);
  }
});

test('the strength bounds are configurable', () => {
  // They are the one part of the gradient that wants measuring against a real
  // collection, which is why they are config rather than a constant in the blend.
  const opts = { query: 'red', embeddings: atCosines(-0.1, -0.1, -0.1), dim: 2, scale: 127, vector: CLIP_QUERY };
  assert.equal(
    rankHybrid({ count: 3, weights: WEIGHTS, ...opts }).strength[0],
    0,
    'the default band reads it as no evidence'
  );
  const loosened = rankHybrid({
    count: 3,
    weights: WEIGHTS,
    ...opts,
    clipStrength: { centre: -0.2, high: -0.15 },
  });
  assert.ok(Math.abs(loosened.strength[0] - WEIGHTS.clip) < 1e-6, 'a shifted band gives the same cosine CLIP\'s full pull');
});

test('no blob means no CLIP strength, rather than a strength of zero cosines', () => {
  // A collection with keywords and no embeddings must still cluster its keyword
  // hits; only the CLIP channel goes quiet.
  const { strength } = rankHybrid({
    query: 'oak',
    count: 3,
    weights: WEIGHTS,
    index: indexOf([['oak'], null], null, null),
  });
  assert.equal(strength[0], 1);
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

test('a range lands on the original text even when folding changed its length [SR-34]', () => {
  // Decomposed: five UTF-16 units for four folded ones. A folded index used as
  // a source index would slice one character short of the accent.
  const story = 'the cafe\u0301 was surveyed';
  assert.equal(story.length, 22);
  assert.deepEqual(marked(story, storyMatchRanges(story, ['cafe'])), ['cafe\u0301']);
});

test('a story marks the whole matched word, by lemma, and only real tokens [SR-34]', () => {
  // `with` is the only place `wit` occurs, and `with` is a stopword.
  const story = 'They surveyed the room with care.';

  // Lemmas agree, and the whole word is marked, not the lemma - `survey`
  // alone is not a thing a reader should be shown in place of `surveyed`.
  assert.deepEqual(marked(story, storyMatchRanges(story, ['survey'])), ['surveyed']);

  // `wit` shares no lemma with anything here, and the word it would have
  // substring-reached - `with` - is a stopword the story index drops, so
  // `storyWordMatches` never credited it and nothing may be marked.
  assert.equal(storyWordMatches(['wit'], buildSearchIndex([{ keywords: [], story }])[0].story), 0);
  assert.deepEqual(storyMatchRanges(story, ['wit']), []);

  // Two tokens overlapping one word produce one range, not two nested ones.
  assert.deepEqual(marked(story, storyMatchRanges(story, ['survey', 'surveyed'])), ['surveyed']);
});

/**
 * Did the tag rule score this query against these folded keywords - the same
 * classification `rankHybrid` runs, whole-query reading included.
 *
 * Written from `parseQuery`/`classifyTagTerm` rather than asserting against a
 * scorer of its own, so "what marked" is checked against what the ranking
 * actually reads.
 */
const tagScored = (query, keywords) => {
  const { terms, whole } = tagTermsOf(parseQuery(query), tokenise(query));
  return [...terms, ...(whole ? [whole] : [])].some((t) => {
    const { exact, partial } = classifyTagTerm(t, keywords);
    return exact || partial > 0;
  });
};

/** What `useSearch` hands `keywordMatchRanges` - the same rule, read from one place. */
const highlightQuery = (query) => {
  const tokens = tokenise(query);
  const { whole } = tagTermsOf(parseQuery(query), tokens);
  return { foldedQuery: whole?.folded ?? '', tokens };
};

test('a keyword marks by substring, where a story would have needed a lemma [SR-34]', () => {
  // `nouveau` is neither the lemma nor the start of `art nouveau`, but
  // `classifyTagTerm` matches it by substring - so it must mark, and the
  // story rule must not be used here. The asymmetry between the two is the point.
  assert.ok(tagScored('nouveau', ['art nouveau']));
  assert.deepEqual(marked('Art Nouveau', keywordMatchRanges('Art Nouveau', fold('nouveau'), ['nouveau'])), ['Nouveau']);

  // The whole query and its tokens, unioned into one range where they overlap.
  assert.deepEqual(
    marked('Art Nouveau', keywordMatchRanges('Art Nouveau', fold('art nouveau'), ['art', 'nouveau'])),
    ['Art Nouveau']
  );
});

test('anything marked scored, and anything that scored is marked [SR-35]', () => {
  const keywords = ['art nouveau', 'gilt', 'oak panelling'];
  const story = 'A surveyed hall of gilded oak, catalogued by an unnamed cartographer.';
  // Built by `buildSearchIndex`, not by hand: the index is lemmatised, and a
  // hand-rolled `new Set(tokenise(story))` drifts from what the scorer reads,
  // which would make this test fail for a reason about the fixture rather
  // than about the agreement it exists to check.
  const { keywords: indexed, story: storyStems } = buildSearchIndex([{ keywords: keywords.map((text) => ({ text })), story }])[0];

  for (const query of ['art', 'nouveau', 'gilt', 'oak', 'cartographer', 'survey', 'catalogue', 'the', 'a', 'zzz', 'art nouveau']) {
    // Marked through exactly what `useSearch` passes, not the raw folded
    // query: a term the vocabulary floor drops cannot score, so it must not
    // mark either.
    const { foldedQuery, tokens } = highlightQuery(query);

    const kScored = tagScored(query, indexed);
    const kMarked = keywords.some((k) => keywordMatchRanges(k, foldedQuery, tokens).length > 0);
    assert.equal(kMarked, kScored, `keyword agreement for ${JSON.stringify(query)}`);

    const sScored = storyWordMatches(tokens, storyStems) > 0;
    const sMarked = storyMatchRanges(story, tokens).length > 0;
    assert.equal(sMarked, sScored, `story agreement for ${JSON.stringify(query)}`);
  }
});

// --- the score breakdown, and the rule it has to keep honest ---------------

test('rankHybrid reports the pulls it combined, by rank', () => {
  const { order, breakdown } = rankHybrid({
    query: 'oak',
    count: 3,
    weights: WEIGHTS,
    index: indexOf([['oak'], null], null, null),
  });

  // Parallel to `order`, i.e. by rank - the convention `strength` uses too.
  assert.equal(order[0], 0);
  assert.equal(breakdown.tagExact[0], 1);
  assert.equal(breakdown.tag[0], WEIGHTS.tagExact);
  // Ranks nothing matched carry zeroes rather than being absent.
  assert.equal(breakdown.tagExact[1], 0);
  assert.equal(breakdown.tag[1], 0);
  for (const arr of Object.values(breakdown)) assert.equal(arr.length, 3);
});

test('ranks/ties are independent per-signal sorts, parallel to order like breakdown [SR-33]', () => {
  // Room 0: a weak partial tag hit, nothing else. Room 1: no text at all, but
  // a cosine past the high anchor, so CLIP's full pull - placement puts room
  // 1 first. The tag axis must still put room 0 first, since it is the only
  // one with any tag signal at all - that divergence from `order` is the
  // reason a per-axis rank exists separately from it.
  const { order, ranks, ties } = rankHybrid({
    query: 'oak',
    count: 3,
    weights: WEIGHTS,
    index: indexOf([['oakenwood'], null], null, null),
    embeddings: atCosines(0.05, 0.3, -0.5),
    dim: 2,
    scale: 127,
    vector: CLIP_QUERY,
  });

  assert.equal(order[0], 1, 'placement favours the full CLIP pull');
  const rankOfRoom = (axis, id) => ranks[axis][order.indexOf(id)];
  const tiesOfRoom = (axis, id) => ties[axis][order.indexOf(id)];

  assert.equal(rankOfRoom('tag', 0), 1, 'room 0 is the only one with any tag signal at all');
  assert.equal(tiesOfRoom('tag', 0), 0);
  // Rooms 1 and 2 both pull zero on the tag axis - tied there, even though
  // placement (reading CLIP) puts them at opposite ends.
  assert.equal(rankOfRoom('tag', 1), 2);
  assert.equal(rankOfRoom('tag', 2), 2);
  assert.equal(tiesOfRoom('tag', 1), 1);
  assert.equal(tiesOfRoom('tag', 2), 1);
});

test('a tie on one axis is reported as tied, even when placement is not [SR-33]', () => {
  // Same tag signal (one exact match each), different CLIP cosines - so
  // placement separates them, but the tag axis must call it a tie.
  const { order, ranks, ties } = rankHybrid({
    query: 'oak',
    count: 3,
    weights: WEIGHTS,
    index: indexOf([['oak'], null], [['oak'], null], null),
    embeddings: atCosines(0.3, 0.1, -0.5),
    dim: 2,
    scale: 127,
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

test('explainRanking omits an axis that found nothing, and returns null when nothing at all did [SR-32]', () => {
  const { breakdown, strength, ranks, ties } = rankHybrid({
    query: 'oak',
    count: 2,
    weights: WEIGHTS,
    index: indexOf([['oak'], null], null, null),
  });

  const explanation = explainRanking(0, { breakdown, strength, ranks, ties, total: 2 });
  assert.ok(explanation.tag, 'room 0 matched a tag');
  assert.equal(explanation.tag.exact, 1);
  assert.equal(explanation.title, null, 'no title to report');
  assert.equal(explanation.story, null, 'no story to report');
  assert.equal(explanation.clip, null, 'no embeddings at all');
  assert.deepEqual(explanation.contributions.map((c) => c.key), ['tag'], 'the only axis that contributed anything');

  assert.equal(
    explainRanking(1, { breakdown, strength, ranks, ties, total: 2 }),
    null,
    'room 1 matched nothing on any axis'
  );
});

test('explainRanking reports an exact vs. a partial title match', () => {
  const index = buildSearchIndex([{ title: 'Unsurveyed', story: null }, { title: 'The Unsurveyed Room', story: null }]);
  const { breakdown, strength, ranks, ties } = rankHybrid({ query: 'unsurveyed', count: 2, weights: WEIGHTS, index });

  const exact = explainRanking(0, { breakdown, strength, ranks, ties, total: 2 });
  assert.ok(exact.title);
  assert.equal(exact.title.exact, true);

  const partial = explainRanking(1, { breakdown, strength, ranks, ties, total: 2 });
  assert.ok(partial.title);
  assert.equal(partial.title.exact, false);
  assert.ok(partial.title.partial > 0 && partial.title.partial < 1);
});

test('the CLIP line reads a cosine below the centre as 0%, off the raw cosine [SR-32] [SR-36]', () => {
  // Every cosine is below `CLIP_STRENGTH.centre`: CLIP finds no evidence for
  // any of these rooms. The line must carry the raw cosine, so a reader can
  // see why it reads 0, and never a negative percentage.
  const cosines = [-0.1, -0.15, -0.2];
  assert.ok(cosines.every((c) => c < CLIP_STRENGTH.centre));

  const { breakdown, strength, ranks, ties } = rankHybrid({
    query: 'cghjj',
    count: 3,
    weights: WEIGHTS,
    dim: 2,
    scale: 127,
    vector: CLIP_QUERY,
    embeddings: atCosines(...cosines),
  });

  const explanation = explainRanking(0, { breakdown, strength, ranks, ties, total: 3 });

  assert.equal(breakdown.clip[0], 0, 'no pull');
  assert.ok(Math.abs(explanation.clip.cosine - cosines[0]) < 0.01, 'the clip summary carries the raw cosine');
  assert.ok(explanation.clip.cosine < CLIP_STRENGTH.centre, 'which is below the no-opinion centre');
  assert.equal(explanation.clip.percent, 0, 'reported at the clamped floor, never negative');
  assert.equal(explanation.percent, 0, 'and the composite reading agrees there is no evidence');
});
