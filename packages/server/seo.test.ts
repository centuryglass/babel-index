import { test } from 'node:test';
import assert from 'node:assert/strict';
import { robotsTxt, renderSitemap } from './seo.ts';
import type { Room } from '../map/manifest.ts';

function room(id: number, file: string): Room {
  return { id, file, url: `images/${file}`, bytes: 1 };
}

test('robotsTxt allows everything and points at this origin\'s sitemap', () => {
  const txt = robotsTxt('https://example.com/');
  assert.match(txt, /^User-agent: \*$/m);
  assert.match(txt, /^Allow: \/$/m);
  assert.match(txt, /^Sitemap: https:\/\/example\.com\/sitemap\.xml$/m);
});

test('renderSitemap lists the root, every catalog page, and every room permalink', () => {
  const rooms = [room(0, 'a.jpg'), room(1, 'b&c.jpg')];
  const xml = renderSitemap('https://example.com/', rooms, 3);

  assert.match(xml, /<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/catalog<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/catalog\?page=2<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/catalog\?page=3<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/catalog\/a\.jpg<\/loc>/);
  // A filename needing escaping in a url (encodeURIComponent) and in XML text
  // (& -> &amp;) both happen, and in the right order.
  assert.match(xml, /<loc>https:\/\/example\.com\/catalog\/b%26c\.jpg<\/loc>/);
});

test('renderSitemap omits catalog page links beyond page 1 when there is only one page', () => {
  const xml = renderSitemap('https://example.com/', [room(0, 'a.jpg')], 1);
  assert.doesNotMatch(xml, /catalog\?page=/);
});
