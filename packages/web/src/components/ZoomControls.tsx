/**
 * Zoom in / reset / zoom out for a `useContentZoom` scope - the non-pinch
 * path a mouse-and-keyboard reader still needs, since native browser zoom
 * is deliberately not offered as a fallback (see `useContentZoom.ts`).
 * Shared by every dialog and the catalog rather than four copies of the
 * same three buttons.
 */
export function ZoomControls({
  zoomIn,
  zoomOut,
  resetZoom,
  canZoomIn,
  canZoomOut,
}: {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
}) {
  return (
    <div className="zoom-controls" role="group" aria-label="zoom">
      <button type="button" onClick={zoomOut} disabled={!canZoomOut} aria-label="zoom out">
        −
      </button>
      <button type="button" onClick={resetZoom} disabled={!canZoomOut} aria-label="reset zoom">
        reset
      </button>
      <button type="button" onClick={zoomIn} disabled={!canZoomIn} aria-label="zoom in">
        +
      </button>
    </div>
  );
}
