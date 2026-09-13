/**
 * The SSR catalog/room page bodies: plain HTML fragments meant to sit inside
 * `index.html`'s `<div id="root">` (see `app.ts`'s `renderPage`) until
 * `bundle.js` boots the real interactive app over them.
 *
 * Pure string builders, no Express types, no DOM - the same "assertable
 * without a browser" split `packages/web/src/lib/catalog.ts` itself is built
 * on, and this module leans on that file's `alphabeticalOrder`/`pageOf`/
 * `pageCount` directly rather than re-deriving the catalog's own idle order
 * and paging arithmetic.
 */
import { roomTitle } from '../map/metadata.ts';
import { pageOf, pageCount } from '../web/src/lib/catalog.ts';
import type { Room } from '../map/manifest.ts';
import type { RoomMeta } from '../map/metadata.ts';
import type { UrlFor } from '../web/src/lib/rooms.ts';

/** The pyramid level a catalog row's thumbnail asks for - see pyramid.ts's LEVELS. */
const THUMB_LEVEL = 2;

/** How much of a room's story shows in a list row before it's cut with an ellipsis. */
const SNIPPET_CHARS = 220;

export interface CatalogListResult {
  title: string;
  description: string;
  bodyHtml: string;
  pageCount: number;
}

export interface RoomPageResult {
  title: string;
  description: string;
  bodyHtml: string;
  /** The room's own image, for `app.ts` to use as this page's og:image. */
  ogImagePath: string;
}

/** Escapes text for use inside HTML content or a double-quoted attribute. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A room's own image, falling back to level 0 when the preferred level isn't on disk. */
function thumbUrl(room: Room, urlFor: UrlFor): string {
  return urlFor(room.id, THUMB_LEVEL) ?? room.url;
}

/** The story, cut to one sentence-ish snippet for a list row. */
function snippet(story: string | null): string {
  if (!story) return '';
  if (story.length <= SNIPPET_CHARS) return story;
  return `${story.slice(0, SNIPPET_CHARS).trimEnd()}…`;
}

function keywordChips(meta: RoomMeta | null, tagLinks: Record<string, string> | null): string {
  if (!meta?.keywords.length) return '';
  const chips = meta.keywords.map((k) => {
    const text = escapeHtml(k.text);
    const link = tagLinks?.[k.text];
    return link ? `<a class="ssr-chip" href="${escapeHtml(link)}">${text}</a>` : `<span class="ssr-chip">${text}</span>`;
  });
  return `<p class="ssr-chips">${chips.join(' ')}</p>`;
}

/**
 * The catalog list page: a plain `<ul>` of rooms in `order`'s slice for
 * `page`, plus prev/next pagination links. `page` is 0-based, matching
 * `pageOf`'s own contract - `app.ts` converts the public 1-based `?page=`
 * query param before calling this.
 */
export function renderCatalogList({
  rooms,
  metadata,
  tagLinks,
  order,
  page,
  perPage,
  urlFor,
  base,
}: {
  rooms: Room[];
  metadata: (RoomMeta | null)[];
  tagLinks: Record<string, string> | null;
  order: number[];
  page: number;
  perPage: number;
  urlFor: UrlFor;
  base: string;
}): CatalogListResult {
  const total = order.length;
  const pages = pageCount(total, perPage);
  const ranked = pageOf(order, page, perPage);

  const rowsHtml = ranked
    .map(({ id }) => {
      const room = rooms[id];
      const meta = metadata[id] ?? null;
      const title = escapeHtml(roomTitle(meta, id));
      const href = `${base}catalog/${encodeURIComponent(room.file)}`;
      const alt = escapeHtml(meta?.alt ?? title);
      return `<li class="ssr-row">
        <a class="ssr-thumb" href="${href}"><img src="${escapeHtml(thumbUrl(room, urlFor))}" alt="${alt}" loading="lazy" width="256" /></a>
        <div class="ssr-row-body">
          <h2><a href="${href}">${title}</a></h2>
          ${keywordChips(meta, tagLinks)}
          ${meta?.story ? `<p class="ssr-snippet">${escapeHtml(snippet(meta.story))}</p>` : ''}
        </div>
      </li>`;
    })
    .join('\n');

  const pageNum = page + 1;
  const prevHref = pageNum > 1 ? `${base}catalog${pageNum - 1 > 1 ? `?page=${pageNum - 1}` : ''}` : null;
  const nextHref = pageNum < pages ? `${base}catalog?page=${pageNum + 1}` : null;
  const nav = `<nav class="ssr-pagination">
    ${prevHref ? `<a href="${prevHref}">&larr; previous</a>` : '<span></span>'}
    <span>page ${pageNum} of ${pages}</span>
    ${nextHref ? `<a href="${nextHref}">next &rarr;</a>` : '<span></span>'}
  </nav>`;

  const bodyHtml = `<div class="ssr-page ssr-catalog">
    <h1>The Index of Babel &middot; Catalog</h1>
    <p class="ssr-lede">Browsing all ${total} rooms of the library, alphabetically. <a href="${base}">Open the interactive library</a> to search, favorite, and wander instead.</p>
    ${nav}
    <ul class="ssr-list">${rowsHtml}</ul>
    ${nav}
  </div>`;

  return {
    title: pageNum > 1 ? `Catalog — page ${pageNum} of ${pages} · The Index of Babel` : 'Catalog · The Index of Babel',
    description: `Browse all ${total} rooms of the Library of Babel, alphabetically by title.`,
    bodyHtml,
    pageCount: pages,
  };
}

/**
 * One room's permalink page: title, full image, keywords, story. Returns
 * null when `file` doesn't name a room in this corpus, so `app.ts` can 404.
 */
export function renderRoomPage({
  rooms,
  metadata,
  tagLinks,
  file,
  urlFor,
  base,
}: {
  rooms: Room[];
  metadata: (RoomMeta | null)[];
  tagLinks: Record<string, string> | null;
  file: string;
  urlFor: UrlFor;
  base: string;
}): RoomPageResult | null {
  const room = rooms.find((r) => r.file === file);
  if (!room) return null;

  const meta = metadata[room.id] ?? null;
  const title = roomTitle(meta, room.id);
  const alt = meta?.alt ?? title;
  const description = meta?.story ? snippet(meta.story) : `A room of the Library of Babel.`;

  const bodyHtml = `<div class="ssr-page ssr-room">
    <p class="ssr-breadcrumb"><a href="${base}catalog">&larr; back to the catalog</a></p>
    <h1>${escapeHtml(title)}</h1>
    <img class="ssr-room-image" src="${escapeHtml(room.url)}" alt="${escapeHtml(alt)}" />
    ${keywordChips(meta, tagLinks)}
    ${meta?.story ? `<p class="ssr-story">${escapeHtml(meta.story)}</p>` : ''}
    <p class="ssr-lede"><a href="${base}">Open in the interactive library</a></p>
  </div>`;

  return { title: `${title} · The Index of Babel`, description, bodyHtml, ogImagePath: room.url };
}
