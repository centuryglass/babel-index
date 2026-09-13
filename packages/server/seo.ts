/**
 * `robots.txt` and `sitemap.xml` - pure string builders, unit-testable
 * without an Express request. `app.ts` supplies the origin (via its
 * `requestOrigin` helper) and mounts these at the plain root paths crawlers
 * expect.
 */
import type { Room } from '../map/manifest.ts';

/**
 * @param origin e.g. `https://example.com/` (trailing slash, matching
 *   `requestOrigin`'s own shape) - crawlers resolve `Sitemap:` themselves, so
 *   it has to be absolute.
 */
export function robotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\nSitemap: ${origin}sitemap.xml\n`;
}

/**
 * Every room permalink, every catalog page, and the root - `origin` already
 * carries the base path (see `requestOrigin`), so every `<loc>` here is a
 * plain concatenation.
 */
export function renderSitemap(origin: string, rooms: Room[], catalogPageCount: number): string {
  const urls = [
    origin,
    `${origin}catalog`,
    ...Array.from({ length: catalogPageCount - 1 }, (_, i) => `${origin}catalog?page=${i + 2}`),
    ...rooms.map((r) => `${origin}catalog/${encodeURIComponent(r.file)}`),
  ];
  const entries = urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
