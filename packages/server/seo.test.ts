import { test } from 'node:test';
import assert from 'node:assert/strict';
import { robotsTxt, renderSitemap } from './seo.ts';

test('robotsTxt allows everything and points at this origin\'s sitemap', () => {
  const txt = robotsTxt('https://example.com/');
  assert.match(txt, /^User-agent: \*$/m);
  assert.match(txt, /^Allow: \/$/m);
  assert.match(txt, /^Sitemap: https:\/\/example\.com\/sitemap\.xml$/m);
});

test('robotsTxt disallows the generated /babel-book easter egg', () => {
  const txt = robotsTxt('https://example.com/');
  assert.match(txt, /^Disallow: \/babel-book$/m);
});

test('renderSitemap lists the root, every catalog page, and every room permalink', () => {
  const xml = renderSitemap('https://example.com/', ['unparsed-light', 'sunken-tomorrows'], 3);

  assert.match(xml, /<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/catalog<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/catalog\?page=2<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/catalog\?page=3<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/catalog\/unparsed-light<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/catalog\/sunken-tomorrows<\/loc>/);
});

test('renderSitemap escapes a url that would otherwise break the XML', () => {
  // Slugs carry nothing to escape, but the origin is built from a request
  // header - an unescaped `&` anywhere in a <loc> is a malformed document, not
  // a mis-linked room.
  const xml = renderSitemap('https://example.com/?a&b/', ['x'], 1);
  assert.match(xml, /a&amp;b/);
  assert.doesNotMatch(xml, /a&b/);
});

test('renderSitemap omits catalog page links beyond page 1 when there is only one page', () => {
  const xml = renderSitemap('https://example.com/', ['a'], 1);
  assert.doesNotMatch(xml, /catalog\?page=/);
});
