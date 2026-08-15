import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinMetadata, metadataCoverage, normaliseEntry } from './metadata.js';

const rooms = [
  { id: 0, file: '001.jpg' },
  { id: 1, file: '002.jpg' },
  { id: 2, file: '003.jpg' },
];

test('a full entry normalises to keywords and a story', () => {
  const e = normaliseEntry({
    keywords: [
      { text: 'verdigris copper', type: 'material' },
      { text: 'art nouveau', type: 'movement' },
      { text: 'wet collodion', type: 'technique' },
    ],
    story: 'The catalogue lists a room that has never been surveyed.',
  });
  assert.equal(e.keywords.length, 3);
  assert.deepEqual(e.keywords[1], { text: 'art nouveau', type: 'movement' });
  assert.match(e.story, /never been surveyed/);
});

test('plain-string keywords are accepted, with no type', () => {
  // The generator may not record which category a keyword came from, and losing
  // the keyword because of that would be the wrong trade.
  const e = normaliseEntry({ keywords: ['brutalism', 'mezzotint'] });
  assert.deepEqual(e.keywords, [
    { text: 'brutalism', type: null },
    { text: 'mezzotint', type: null },
  ]);
  assert.equal(e.story, null);
});

test('the keyword count is not enforced', () => {
  // "Exactly three" is a fact about generation, not a constraint the map needs.
  assert.equal(normaliseEntry({ keywords: ['one'] }).keywords.length, 1);
  assert.equal(normaliseEntry({ keywords: ['a', 'b', 'c', 'd', 'e'] }).keywords.length, 5);
});

test('empty and malformed entries come back as null, not as empty records', () => {
  // "Has metadata" has to stay a real question, or every room looks described.
  for (const raw of [null, undefined, 'text', 42, [], {}, { keywords: [] }, { story: '   ' }])
    assert.equal(normaliseEntry(raw), null, JSON.stringify(raw) ?? 'undefined');
});

test('junk inside a keyword list is dropped, and the rest survives', () => {
  const e = normaliseEntry({ keywords: ['  spalted maple  ', null, 42, { type: 'movement' }, { text: '' }] });
  assert.deepEqual(e.keywords, [{ text: 'spalted maple', type: null }]);
});

test('the join is by filename and indexed by room id', () => {
  const joined = joinMetadata(rooms, {
    '003.jpg': { keywords: ['third'] },
    '001.jpg': { keywords: ['first'] },
  });
  assert.equal(joined.length, 3);
  assert.equal(joined[0].keywords[0].text, 'first');
  assert.equal(joined[1], null, 'a room with no entry has none');
  assert.equal(joined[2].keywords[0].text, 'third');
});

test('a renamed or added room loses only its own entry', () => {
  // The whole reason this is keyed on filename rather than on row order: the
  // embedding blob has to be thrown away when the corpus moves, and this does
  // not. Room 1 is new and undescribed; everything else still lands.
  const grown = [...rooms, { id: 3, file: '004.jpg' }];
  const joined = joinMetadata(grown, { '001.jpg': { story: 'a' }, '004.jpg': { story: 'd' } });
  assert.equal(joined[0].story, 'a');
  assert.equal(joined[3].story, 'd');
});

test('entries for files not in the corpus are ignored', () => {
  const joined = joinMetadata(rooms, { 'nope.jpg': { story: 'orphan' } });
  assert.deepEqual(joined, [null, null, null]);
});

test('coverage separates "no metadata" from "metadata that matches nothing"', () => {
  // These look identical from the map, and only one of them is a mistake.
  assert.deepEqual(metadataCoverage(rooms, {}), { matched: 0, entries: 0 });
  assert.deepEqual(
    metadataCoverage(rooms, { 'old-001.jpg': { story: 'a' }, 'old-002.jpg': { story: 'b' } }),
    { matched: 0, entries: 2 }
  );
  assert.deepEqual(metadataCoverage(rooms, { '002.jpg': { story: 'b' } }), { matched: 1, entries: 1 });
});

test('an entry that is present but empty does not count as covered', () => {
  assert.deepEqual(metadataCoverage(rooms, { '001.jpg': {} }), { matched: 0, entries: 1 });
});
