/**
 * The map's search affordance - the one piece of screen chrome the map
 * view carries. Everything else in the interface is an object in the room
 * (the shelf, the in-tile search field); this exists because the diegetic
 * route to search requires already being close enough to the center tile
 * to see it.
 *
 * The badge and its arrow are imported as raw markup (esbuild's `.svg`
 * text loader, `packages/server/index.ts`), so
 * `assets/search_button.svg`/`search_arrow.svg` stay the one copy of that
 * path data; a copy traced into JSX here would drift from them.
 *
 * The two files share one coordinate system: the arrow was drawn to sit
 * flush against the top of the button's circle, so rotating it around the
 * circle's own center (`transform-origin: 50% 50%`) keeps it riding the
 * rim rather than drifting off it. The render loop sets that rotation
 * every frame from the live camera, so the arrow points at wherever the
 * center tile currently is on screen - including off it.
 */
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import buttonSvg from '../../../../assets/search_button.svg';
import arrowSvg from '../../../../assets/search_arrow.svg';

export function SearchGlyph(props: ComponentPropsWithoutRef<'span'>) {
  return <span aria-hidden="true" {...props} dangerouslySetInnerHTML={{ __html: buttonSvg }} />;
}

// `forwardRef` because the render loop writes a per-frame `transform`
// onto the live DOM node - the same imperative arrangement as
// `.center-search` and `.center-books`, for the same reason: it turns with
// the camera, which React re-rendering should not be driving.
export const SearchOrbitArrow = forwardRef<HTMLSpanElement, ComponentPropsWithoutRef<'span'>>(function SearchOrbitArrow(props, ref) {
  return (
    <span
      ref={ref}
      aria-hidden="true"
      {...props}
      dangerouslySetInnerHTML={{ __html: arrowSvg }}
    />
  );
});

/**
 * A ring spinning around the badge, shown while a rearrangement's preload
 * is running - what a reader browsing away from the center tile sees
 * during a preload, since the center-tile indicator only plays when its
 * book is on screen (AGENTS.md, "The loading indicator"). Unlike
 * `SearchOrbitArrow` it carries no per-frame state (`style.css`'s
 * `.search-icon-button.preparing` gates a plain CSS animation), so it
 * needs no ref and is plain markup rather than injected SVG.
 */
export function SearchOrbitSpinner(props: ComponentPropsWithoutRef<'span'>) {
  return <span aria-hidden="true" {...props} />;
}
