import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCatalogList, renderRoomPage, escapeHtml } from './catalogPage.ts';
import type { Room } from '../map/manifest.ts';
import type { RoomMeta } from '../map/metadata.ts';
import type { UrlFor } from '../web/src/lib/rooms.ts';

function room(id: number, file: string): Room {
  return { id, file, url: `images/${file}`, bytes: 1, w: 1024, h: 768 };
}

const urlFor: UrlFor = (id, level) => (level === 2 ? `images/256/${id}.jpg` : null);

test('renderCatalogList lists a page of rooms with real links, titles and thumbnails', () => {
  const rooms = [room(0, 'b.jpg'), room(1, 'a.jpg')];
  const metadata: (RoomMeta | null)[] = [
    { title: 'Bravo', keywords: [], story: 'A story about bravo.', alt: null, sensitiveContentTags: [] },
    { title: 'Alpha', keywords: [{ text: 'gothic', type: null }], story: null, alt: null, sensitiveContentTags: [] },
  ];
  const order = [1, 0]; // already-alphabetical order, as alphabeticalOrder would produce

  const { title, description, bodyHtml, pageCount } = renderCatalogList({
    rooms,
    metadata,
    tagLinks: { gothic: 'https://example.com/gothic' },
    order,
    page: 0,
    perPage: 10,
    urlFor,
    base: '/',
  });

  assert.equal(pageCount, 1);
  assert.match(title, /Catalog/);
  assert.match(description, /2 rooms/);
  assert.match(bodyHtml, /Alpha/);
  assert.match(bodyHtml, /Bravo/);
  assert.match(bodyHtml, /href="\/catalog\/a\.jpg"/);
  assert.match(bodyHtml, /href="\/catalog\/b\.jpg"/);
  assert.match(bodyHtml, /src="images\/256\/1\.jpg"/);
  assert.match(bodyHtml, /href="https:\/\/example\.com\/gothic"/);
  assert.match(bodyHtml, /A story about bravo\./);
});

test('renderCatalogList falls back to the room file when a thumbnail level is missing', () => {
  const rooms = [room(0, 'only.jpg')];
  const noLevels: UrlFor = () => null;
  const { bodyHtml } = renderCatalogList({
    rooms,
    metadata: [null],
    tagLinks: null,
    order: [0],
    page: 0,
    perPage: 10,
    urlFor: noLevels,
    base: '/',
  });
  assert.match(bodyHtml, /src="images\/only\.jpg"/);
  // No metadata at all falls back to roomTitle's numeric name.
  assert.match(bodyHtml, /Room 0/);
});

test('renderCatalogList paginates and links prev/next, dropping ?page=1 from the first page url', () => {
  const rooms = Array.from({ length: 25 }, (_, i) => room(i, `${i}.jpg`));
  const metadata: (RoomMeta | null)[] = rooms.map(() => null);
  const order = rooms.map((_, i) => i);

  const page1 = renderCatalogList({ rooms, metadata, tagLinks: null, order, page: 0, perPage: 10, urlFor, base: '/' });
  assert.equal(page1.pageCount, 3);
  assert.doesNotMatch(page1.bodyHtml, /previous/);
  assert.match(page1.bodyHtml, /href="\/catalog\?page=2">next/);

  const page2 = renderCatalogList({ rooms, metadata, tagLinks: null, order, page: 1, perPage: 10, urlFor, base: '/' });
  assert.match(page2.bodyHtml, /href="\/catalog">.*previous/s);
  assert.match(page2.bodyHtml, /href="\/catalog\?page=3">next/);

  const page3 = renderCatalogList({ rooms, metadata, tagLinks: null, order, page: 2, perPage: 10, urlFor, base: '/' });
  assert.doesNotMatch(page3.bodyHtml, /next/);
});

test('renderCatalogList escapes a room title so a stray "<" cannot break the markup', () => {
  const rooms = [room(0, 'x.jpg')];
  const metadata: (RoomMeta | null)[] = [
    { title: '<script>alert(1)</script>', keywords: [], story: null, alt: null, sensitiveContentTags: [] },
  ];
  const { bodyHtml } = renderCatalogList({
    rooms,
    metadata,
    tagLinks: null,
    order: [0],
    page: 0,
    perPage: 10,
    urlFor,
    base: '/',
  });
  assert.doesNotMatch(bodyHtml, /<script>alert/);
  assert.match(bodyHtml, /&lt;script&gt;/);
});

test('renderRoomPage returns null for a filename this corpus does not have', () => {
  const result = renderRoomPage({
    rooms: [room(0, 'a.jpg')],
    metadata: [null],
    tagLinks: null,
    file: 'missing.jpg',
    urlFor,
    base: '/',
  });
  assert.equal(result, null);
});

test('renderRoomPage renders the room title, image, keywords and story, and its own og image', () => {
  const rooms = [room(0, 'a.jpg')];
  const metadata: (RoomMeta | null)[] = [
    {
      title: 'The Reading Room',
      keywords: [{ text: 'gothic', type: null }, { text: 'candlelight', type: null }],
      story: 'A quiet room full of half-remembered books.',
      alt: 'A dim library wall.',
      sensitiveContentTags: [],
    },
  ];
  const result = renderRoomPage({
    rooms,
    metadata,
    tagLinks: { gothic: 'https://example.com/gothic' },
    file: 'a.jpg',
    urlFor,
    base: '/',
  });
  assert.ok(result);
  assert.match(result!.title, /The Reading Room/);
  assert.match(result!.description, /quiet room/);
  assert.equal(result!.ogImagePath, 'images/a.jpg');
  assert.match(result!.bodyHtml, /The Reading Room/);
  assert.match(result!.bodyHtml, /alt="A dim library wall\."/);
  assert.match(result!.bodyHtml, /candlelight/);
  assert.match(result!.bodyHtml, /href="https:\/\/example\.com\/gothic">gothic/);
  assert.match(result!.bodyHtml, /half-remembered books/);
  assert.match(result!.bodyHtml, /href="\/catalog">/);
});

test('escapeHtml escapes every reserved character', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
