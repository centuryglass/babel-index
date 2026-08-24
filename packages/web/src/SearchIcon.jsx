/**
 * The map's search affordance - not part of the panel and not diegetic
 * either. Everything else earns its place as an object in the room (the
 * shelf, the in-tile field); this is the one exception, a piece of screen
 * chrome the map still needs because the diegetic route to search requires
 * already being close enough to the center tile to see it. Traced from
 * `assets/search_button.svg`/`assets/search_arrow.svg`, which share one
 * coordinate system on purpose: the arrow was drawn to sit flush against the
 * top of the button's circle, so rotating it around the circle's own center
 * (`transform-origin: 50% 50%`) keeps it riding the rim rather than drifting
 * off it. `useMapRenderer` sets that rotation every frame from the live
 * camera, so the arrow always points at wherever the center tile currently
 * is on screen - including off it - not just in some default orientation.
 */
import { forwardRef } from 'react';

const VIEW_BOX = '0 0 170.56484 170.56484';
// Both source SVGs draw against this offset group; keeping it here means the
// path data below is a straight copy of the traced files, not a hand-edited one.
const GROUP_TRANSFORM = 'translate(-28.488451,-42.473573)';

export function SearchGlyph(props) {
  return (
    <svg viewBox={VIEW_BOX} aria-hidden="true" {...props}>
      <g transform={GROUP_TRANSFORM}>
        <circle
          style={{ opacity: 0.47, fill: '#1a1a1a' }}
          cx="113.77087"
          cy="127.75599"
          r="85.282417"
        />
        <path
          style={{ fill: '#ffcc00', stroke: '#1a1a1a', strokeWidth: 0.7 }}
          d="m 113.77061,42.823573 a 84.932378,84.932378 0 0 0 -84.932159,84.932157 84.932378,84.932378 0 0 0 84.932159,84.93268 84.932378,84.932378 0 0 0 84.93268,-84.93268 84.932378,84.932378 0 0 0 -84.93268,-84.932157 z m 0,5.390994 a 79.541188,79.541188 0 0 1 79.54116,79.541163 79.541188,79.541188 0 0 1 -79.54116,79.54116 79.541188,79.541188 0 0 1 -79.541165,-79.54116 79.541188,79.541188 0 0 1 79.541165,-79.541163 z"
        />
        <path
          style={{ opacity: 0.6, fill: '#666666', stroke: '#1a1a1a', strokeWidth: 0.776903 }}
          d="m 113.77074,79.966436 c -26.393347,6.5e-5 -47.789359,21.396074 -47.789424,47.789424 -8.9e-5,26.39344 21.395968,47.78962 47.789424,47.78968 26.39354,9e-5 47.78978,-21.39614 47.78969,-47.78968 -7e-5,-26.39346 -21.39625,-47.789512 -47.78969,-47.789424 z"
        />
        <path
          style={{ fill: '#ffcc00', stroke: '#1a1a1a', strokeWidth: 1.00903 }}
          d="m 127.30268,91.020177 a 23.21134,22.484542 0 0 0 -23.21106,22.484703 23.21134,22.484542 0 0 0 3.12339,11.26451 23.21134,22.484542 0 0 0 1.61957,2.3428 23.21134,22.484542 0 0 1 -1.61957,-2.3428 l -23.872226,23.87222 c -2.641131,2.64113 -2.641131,6.89379 0,9.53492 2.64113,2.64113 6.893265,2.64113 9.534395,0 L 117.2724,133.7813 a 23.21134,22.484542 0 0 1 -0.8614,-0.46355 23.21134,22.484542 0 0 0 10.89168,2.67129 23.21134,22.484542 0 0 0 23.21157,-22.48418 23.21134,22.484542 0 0 0 -23.21157,-22.484683 z m 0,7.381918 a 15.102301,15.102301 0 0 1 15.10225,15.102785 15.102301,15.102301 0 0 1 -15.10225,15.10225 15.102301,15.102301 0 0 1 -15.10226,-15.10225 15.102301,15.102301 0 0 1 15.10226,-15.102785 z m -17.83665,29.429665 a 23.21134,22.484542 0 0 0 1.27751,1.40838 23.21134,22.484542 0 0 1 -1.27751,-1.40838 z m 2.13058,2.1728 a 23.21134,22.484542 0 0 0 1.3187,1.11848 23.21134,22.484542 0 0 1 -1.3187,-1.11848 z m 2.31099,1.81406 a 23.21134,22.484542 0 0 0 1.40892,0.91095 23.21134,22.484542 0 0 1 -1.40892,-0.91095 z"
        />
      </g>
    </svg>
  );
}

// `forwardRef` because `useMapRenderer` needs the live DOM node to write a
// per-frame `transform` onto - the same imperative arrangement the render
// loop already uses for `.center-search` and `.center-books`, and for the
// same reason: this rotates every frame with the camera, which is not
// something a React re-render should be doing sixty times a second.
export const SearchOrbitArrow = forwardRef(function SearchOrbitArrow(props, ref) {
  return (
    <svg ref={ref} viewBox={VIEW_BOX} aria-hidden="true" {...props}>
      <g transform={GROUP_TRANSFORM}>
        <path
          style={{ fill: '#ffcc00', stroke: '#1a1a1a', strokeWidth: 1.12146 }}
          d="m 113.77053,50.411078 -12.05766,17.914309 h 8.57512 c -0.0835,0.472044 -0.12807,0.969641 -0.12807,1.483709 v 4.105688 c 0,0.118224 0.002,0.233643 0.007,0.345902 h 7.20652 c 0.006,-0.112189 0.007,-0.227694 0.007,-0.345902 v -4.105688 c 0,-0.514068 -0.0445,-1.011665 -0.12807,-1.483709 h 8.57594 z"
        />
      </g>
    </svg>
  );
});
