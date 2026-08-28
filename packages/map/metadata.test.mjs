import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinMetadata, metadataCoverage, normaliseEntry } from './metadata.ts';

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

test('the optional alt is carried, trimmed, and null when absent', () => {
  const withAlt = normaliseEntry({
    story: 'The catalogue lists a room that has never been surveyed.',
    alt: '  A tall shelved wall in green shadow, its brass rail catching one lamp.  ',
  });
  assert.match(withAlt.alt, /^A tall shelved wall/);
  assert.doesNotMatch(withAlt.alt, /\s$/);

  // Absent, blank, or the wrong type all read the same: no caption, rather
  // than an empty one a consumer would render as a blank line.
  for (const raw of [{ story: 'x' }, { story: 'x', alt: '   ' }, { story: 'x', alt: 42 }])
    assert.equal(normaliseEntry(raw).alt, null, JSON.stringify(raw));
});

test('an entry carrying only an alt still counts as an entry', () => {
  // It describes the room, which is the question "has metadata" is asking -
  // and a caption is the one description some rooms will ever have.
  const e = normaliseEntry({ alt: 'A shelved wall lit from the left.' });
  assert.ok(e);
  assert.deepEqual(e.keywords, []);
  assert.equal(e.story, null);
  assert.match(e.alt, /shelved wall/);

  assert.equal(metadataCoverage(rooms, { '001.jpg': { alt: 'A shelved wall.' } }).matched, 1);
});

test('a keyword with no type still normalises', () => {
  // The generator may not record which category a keyword came from, and losing
  // the keyword because of that would be the wrong trade.
  const e = normaliseEntry({ keywords: [{ text: 'brutalism' }, { text: 'mezzotint' }] });
  assert.deepEqual(e.keywords, [
    { text: 'brutalism', type: null },
    { text: 'mezzotint', type: null },
  ]);
  assert.equal(e.story, null);
});

test('the keyword count is not enforced', () => {
  // "Exactly three" is a fact about generation, not a constraint the map needs.
  assert.equal(normaliseEntry({ keywords: [{ text: 'one' }] }).keywords.length, 1);
  assert.equal(
    normaliseEntry({ keywords: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }] }).keywords
      .length,
    5
  );
});

test('empty and malformed entries come back as null, not as empty records', () => {
  // "Has metadata" has to stay a real question, or every room looks described.
  for (const raw of [null, undefined, 'text', 42, [], {}, { keywords: [] }, { story: '   ' }])
    assert.equal(normaliseEntry(raw), null, JSON.stringify(raw) ?? 'undefined');
});

test('junk inside a keyword list is dropped, and the rest survives', () => {
  // A plain string is junk now too - the generator always writes {text, type}.
  const e = normaliseEntry({
    keywords: ['spalted maple', null, 42, { type: 'movement' }, { text: '' }, { text: '  oak burl  ' }],
  });
  assert.deepEqual(e.keywords, [{ text: 'oak burl', type: null }]);
});

test('the join is by filename and indexed by room id', () => {
  const joined = joinMetadata(rooms, {
    '003.jpg': { keywords: [{ text: 'third' }] },
    '001.jpg': { keywords: [{ text: 'first' }] },
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
