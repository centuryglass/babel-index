/**
 * SSR bodies for the two static, content-free routes `/help` and `/about` -
 * plain HTML fragments meant to sit inside `index.html`'s `<div id="root">`
 * (see `app.ts`'s `renderPage`) until `bundle.js` boots the interactive
 * `HelpDialog`/`ArtistStatementOverlay` over them. Unlike `catalogPage.ts`
 * these carry no per-corpus data, so they need no manifest/metadata and are
 * just enough for a no-JS visitor or a crawler - not a second copy of either
 * dialog's full content.
 */
export interface StaticPageResult {
  title: string;
  description: string;
  bodyHtml: string;
}

const SITE_TITLE = 'The Index of Babel';

export function renderHelpPage(base: string): StaticPageResult {
  const bodyHtml = `<div class="ssr-page">
<h1>Help</h1>
<p>The Index of Babel is a zoomable, pannable map of library rooms, each paired
with keywords and a short story. Drag to pan, scroll or pinch to zoom, and
click a room to see its full image and story.</p>
<p>Type a word or phrase into the search box at the center of the map to
rearrange it: closer matches sit nearer the center, and an unrelated search
leaves rooms mixed evenly with generic ones.</p>
<p>A <a href="${base}catalog">plain list view</a> of the same collection is
also available, better suited to reading result by result than scanning a map.</p>
</div>`;
  return {
    title: `Help · ${SITE_TITLE}`,
    description: 'How to use the Index of Babel: panning, searching, and viewing rooms.',
    bodyHtml,
  };
}

export function renderAboutPage(base: string): StaticPageResult {
  const bodyHtml = `<div class="ssr-page">
<h1>Artist&rsquo;s Statement</h1>
<p>The <a href="https://en.wikipedia.org/wiki/The_Library_of_Babel" target="_blank" rel="noopener noreferrer">Library of Babel</a>
is real. Not as a physical place, but as a mathematical truth.</p>
<p>AI's most interesting artistic role is in accelerating the search. Curating
randomness to find accidental meaning is a real art form, generative AI tools
serve to tether that randomness, linking it to patterns found in existing art
just tightly enough to exclude most of the meaningless noise. It's a rough
index into the Library, letting us limit the search to a much more rewarding
subset of the near-infinite space.</p>
<p>Curious what an unindexed corner of the library looks like? <a href="${base}babel-book">Read a random book</a>
straight from it.</p>
</div>`;
  return {
    title: `Artist's Statement · ${SITE_TITLE}`,
    description: "The Index of Babel's artist's statement.",
    bodyHtml,
  };
}
