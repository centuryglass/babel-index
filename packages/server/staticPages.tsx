/**
 * SSR bodies for the two static, content-free routes `/help` and `/about` -
 * rendered inside `index.html`'s `<div id="root">` (see `app.ts`'s
 * `renderPage`) until `bundle.js` boots the interactive `HelpDialog`/
 * `ArtistStatementOverlay` over them.
 *
 * The prose lives only in `HelpBody.tsx` and `ArtistStatementPages.tsx`,
 * rendered here with `react-dom/server`'s `renderToStaticMarkup` into the
 * same markup the live dialogs use. Hazard: those components must stay pure
 * (no hooks, no browser calls) or this render breaks. The one element that
 * differs between the two contexts is `runBookLink` (see
 * `ArtistStatementPages.tsx`).
 *
 * The only `.tsx` file in `packages/server`, since it renders React
 * elements.
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
