/**
 * `robots.txt` and `sitemap.xml` - pure string builders, unit-testable
 * without an Express request. `app.ts` supplies the origin (via its
 * `requestOrigin` helper) and mounts these at the plain root paths crawlers
 * expect.
 */
import { roomPath } from '../map/slug.ts';

/**
 * @param origin e.g. `https://example.com/` (trailing slash, matching
 *   `requestOrigin`'s own shape) - crawlers resolve `Sitemap:` themselves, so
 *   it has to be absolute.
 */
export function robotsTxt(origin: string): string {
  // /babel-book is infinite, generated text with nothing to index - not
  // worth a crawler's time or an index entry (AGENTS.md, "Shareable
  // permalinks").
  return `User-agent: *\nAllow: /\nDisallow: /babel-book\nSitemap: ${origin}sitemap.xml\n`;
}

/**
 * Every room permalink, every catalog page, and the root - `origin` already
 * carries the base path (see `requestOrigin`), so every `<loc>` here is a
 * plain concatenation.
 *
 * @param roomSlugs each room's canonical slug, from `buildSlugTable`. Only the
 *   canonical form is listed: a room's stem alias redirects to it, and naming
 *   both would offer a crawler two urls for one page.
 */
export function renderSitemap(origin: string, roomSlugs: string[], catalogPageCount: number): string {
  const urls = [
    origin,
    `${origin}catalog`,
    ...Array.from({ length: catalogPageCount - 1 }, (_, i) => `${origin}catalog?page=${i + 2}`),
    ...roomSlugs.map((slug) => `${origin}${roomPath(slug)}`),
  ];
  const entries = urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
