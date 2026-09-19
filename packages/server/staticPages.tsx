/**
 * SSR bodies for the two static, content-free routes `/help` and `/about` -
 * rendered inside `index.html`'s `<div id="root">` (see `app.ts`'s
 * `renderPage`) until `bundle.js` boots the interactive `HelpDialog`/
 * `ArtistStatementOverlay` over them.
 *
 * The prose itself is not restated here: `HelpBody.tsx` and
 * `ArtistStatementPages.tsx` are pure, stateless components with no hooks or
 * browser calls, so `react-dom/server`'s `renderToStaticMarkup` can render
 * the exact same markup the live dialogs use. That's what makes JSX the one
 * source of truth for these two texts rather than a second copy kept in
 * step by hand, or a markup format (Markdown, a CMS doc) neither side reads
 * natively - the artist's statement in particular has a real outbound link,
 * a `<pre><code>` block, and a button/link that has to differ between the
 * two contexts (see `ArtistStatementPages.tsx`'s own comment on
 * `runBookLink`).
 *
 * `.tsx` rather than `.ts`, unlike the rest of `packages/server`: this is
 * the one file there that renders React elements rather than building HTML
 * strings by hand, and JSX is how the components it renders are written.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { HelpBody } from '../web/src/components/HelpBody.tsx';
import { ArtistStatementPages } from '../web/src/components/ArtistStatementPages.tsx';

export interface StaticPageResult {
  title: string;
  description: string;
  bodyHtml: string;
}

const SITE_TITLE = 'The Index of Babel';

export function renderHelpPage(base: string): StaticPageResult {
  const bodyHtml = renderToStaticMarkup(
    <div className="ssr-page">
      <h1>Help</h1>
      <HelpBody />
      <p>
        A <a href={`${base}catalog`}>plain list view</a> of the same collection is
        also available, better suited to reading result by result than scanning a map.
      </p>
    </div>
  );
  return {
    title: `Help · ${SITE_TITLE}`,
    description: 'How to use the Index of Babel: panning, searching, and viewing rooms.',
    bodyHtml,
  };
}

export function renderAboutPage(base: string): StaticPageResult {
  const bodyHtml = renderToStaticMarkup(
    <div className="ssr-page">
      <h1>Artist&rsquo;s Statement</h1>
      <ArtistStatementPages
        runBookLink={<a className="statement-link" href={`${base}babel-book`}>Run the same thing here</a>}
      />
    </div>
  );
  return {
    title: `Artist's Statement · ${SITE_TITLE}`,
    description: "The Index of Babel's artist's statement.",
    bodyHtml,
  };
}
