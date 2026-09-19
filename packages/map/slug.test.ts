import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlugTable, fileStem, roomPath, slugify } from './slug.ts';
import type { Room } from './manifest.ts';
import type { RoomMeta } from './metadata.ts';

function room(id: number, file: string): Room {
  return { id, file, url: `images/${file}`, bytes: 1 };
}

function meta(title: string | null): RoomMeta {
  return { title, keywords: [], story: null, alt: null, sensitiveContentTags: [] };
}

test('slugify folds a title to one lowercase, hyphenated path segment', () => {
  assert.equal(slugify('Unparsed Light'), 'unparsed-light');
  assert.equal(slugify('The Canonized Jest'), 'the-canonized-jest');
  // The same fold search matches on, so an accented title and a query for it
  // agree on its letters.
  assert.equal(slugify('Café Noir'), 'cafe-noir');
  assert.equal(slugify('Zdzisław'), 'zdzislaw');
  // Punctuation collapses rather than accumulating hyphens, and never leaves
  // one hanging off either end.
  assert.equal(slugify('  A Room -- of One\'s Own!  '), 'a-room-of-one-s-own');
  assert.equal(slugify('日本'), 'riben');
  assert.equal(slugify('!!!'), '');
});

test('fileStem drops the final extension and leaves a dotfile alone', () => {
  assert.equal(fileStem('00121.webp'), '00121');
  assert.equal(fileStem('a.b.jpg'), 'a.b');
  assert.equal(fileStem('noext'), 'noext');
  assert.equal(fileStem('.webp'), '.webp');
});

test('a titled room is addressed by its title, and its stem still resolves', () => {
  const rooms = [room(0, '00121.webp'), room(1, '00122.webp')];
  const { slugs, lookup, collisions } = buildSlugTable(rooms, [meta('Unparsed Light'), meta('Sunken Tomorrows')]);

  assert.deepEqual(slugs, ['unparsed-light', 'sunken-tomorrows']);
  assert.deepEqual(collisions, []);
  assert.equal(lookup.get('unparsed-light'), 0);
  assert.equal(lookup.get('00121'), 0, 'the filename stem stays a permanent alias');
  assert.equal(lookup.get('00122'), 1);
  assert.equal(lookup.get('00121.webp'), undefined, 'the extension is not part of any path');
});

test('an untitled room is addressed by its stem, with no id anywhere in the path', () => {
  // Ids are positional, so a path derived from one repoints at a different
  // room as soon as the corpus grows - `roomTitle`'s "Room {id}" fallback must
  // not reach a url.
  const rooms = [room(0, '00121.webp'), room(1, '00122.webp')];
  const { slugs } = buildSlugTable(rooms, [null, meta(null)]);

  assert.deepEqual(slugs, ['00121', '00122']);
  assert.equal(buildSlugTable(rooms, null).slugs[0], '00121', 'no sidecar at all is the same answer');
});

test('two rooms sharing a title keep both permalinks, and the collision is reported', () => {
  const rooms = [room(0, '00121.webp'), room(1, '00122.webp')];
  const table = buildSlugTable(rooms, [meta('Unparsed Light'), meta('Unparsed Light')]);

  assert.deepEqual(table.slugs, ['unparsed-light-00121', 'unparsed-light-00122']);
  assert.equal(table.lookup.get('unparsed-light-00121'), 0);
  assert.equal(table.lookup.get('unparsed-light-00122'), 1);
  assert.equal(table.lookup.get('unparsed-light'), undefined, 'the bare path belongs to neither');
  assert.deepEqual(table.collisions, [
    {
      wanted: 'unparsed-light',
      rooms: [
        { file: '00121.webp', slug: 'unparsed-light-00121' },
        { file: '00122.webp', slug: 'unparsed-light-00122' },
      ],
    },
  ]);
});

test('a title colliding with another room\'s stem is a collision too', () => {
  const rooms = [room(0, '00121.webp'), room(1, 'unparsed-light.webp')];
  const table = buildSlugTable(rooms, [meta('Unparsed Light'), null]);

  assert.equal(table.slugs[0], 'unparsed-light-00121');
  assert.equal(table.slugs[1], 'unparsed-light');
  assert.equal(table.collisions.length, 1);
  assert.equal(table.collisions[0].wanted, 'unparsed-light');
});

test('a canonical slug is never shadowed by another room\'s stem alias', () => {
  // Room 1's title folds to room 0's stem. Room 0 owns `00121` outright, so
  // the alias pass must not hand that path to room 1.
  const rooms = [room(0, '00121.webp'), room(1, 'other.webp')];
  const table = buildSlugTable(rooms, [null, meta('other')]);

  assert.equal(table.slugs[0], '00121');
  assert.equal(table.lookup.get('00121'), 0);
  assert.equal(table.lookup.get('other'), 1);
});

test('untitled rooms that share a stem resolve to one room, and say so', () => {
  // Nothing can tell `001.webp` from `001.png` by stem alone. The first in
  // filename order takes the path; the point of the report is that this is
  // visible rather than silent.
  const rooms = [room(0, '001.png'), room(1, '001.webp')];
  const table = buildSlugTable(rooms, [null, null]);

  assert.deepEqual(table.slugs, ['001', '001']);
  assert.equal(table.lookup.get('001'), 0);
  assert.equal(table.collisions.length, 1);
  assert.deepEqual(table.collisions[0].rooms.map((r) => r.file), ['001.png', '001.webp']);
});

test('a filename with nothing to fold still gets a unique path', () => {
  const rooms = [room(0, '!!!.webp'), room(1, '???.webp')];
  const { slugs, lookup } = buildSlugTable(rooms, [null, null]);

  assert.notEqual(slugs[0], slugs[1]);
  assert.equal(lookup.get(slugs[0]), 0);
  assert.equal(lookup.get(slugs[1]), 1);
  assert.equal(slugs.filter((s) => s === '').length, 0, 'an empty slug would resolve the base catalog url');
});

test('roomPath states the permalink shape once', () => {
  assert.equal(roomPath('unparsed-light'), 'catalog/unparsed-light');
  assert.equal(roomPath('unparsed-light', 'catalog'), 'catalog/unparsed-light');
  assert.equal(roomPath('unparsed-light', 'map'), 'map/unparsed-light');
});
