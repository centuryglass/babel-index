/**
 * The map's search affordance - not part of the panel and not diegetic
 * either. Everything else earns its place as an object in the room (the
 * shelf, the in-tile field); this is the one exception, a piece of screen
 * chrome the map still needs because the diegetic route to search requires
 * already being close enough to the center tile to see it.
 *
 * The badge and its arrow are imported as raw markup (`loader: { '.svg':
 * 'text' }` in packages/server/index.mjs and bundle.test.mjs) rather than
 * traced into JSX by hand, so `assets/search_button.svg`/`search_arrow.svg`
 * stay the one copy of that path data - editing them in Inkscape is enough,
 * with no second copy here to fall out of step.
 *
 * The two files share one coordinate system on purpose: the arrow was drawn
 * to sit flush against the top of the button's circle, so rotating it around
 * the circle's own center (`transform-origin: 50% 50%`) keeps it riding the
 * rim rather than drifting off it. `useMapRenderer` sets that rotation every
 * frame from the live camera, so the arrow always points at wherever the
 * center tile currently is on screen - including off it.
 */
import { forwardRef } from 'react';
import buttonSvg from '../../../assets/search_button.svg';
import arrowSvg from '../../../assets/search_arrow.svg';

export function SearchGlyph(props) {
  return <span aria-hidden="true" {...props} dangerouslySetInnerHTML={{ __html: buttonSvg }} />;
}

// `forwardRef` because `useMapRenderer` needs the live DOM node to write a
// per-frame `transform` onto - the same imperative arrangement the render
// loop already uses for `.center-search` and `.center-books`, and for the
// same reason: this rotates every frame with the camera, which is not
// something a React re-render should be doing sixty times a second.
export const SearchOrbitArrow = forwardRef(function SearchOrbitArrow(props, ref) {
  return (
    <span
      ref={ref}
      aria-hidden="true"
      {...props}
      dangerouslySetInnerHTML={{ __html: arrowSvg }}
    />
  );
});
