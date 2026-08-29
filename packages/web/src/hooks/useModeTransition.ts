/**
 * Switching between the map and catalog readings - which one is mounted, and
 * the FLIP animation that folds the center tile into the catalog's first row
 * (or back out) rather than cutting between them.
 *
 * Split out of `main.jsx` per `docs/state-architecture-plan.md` §3 step 3.
 * The most self-contained block in that file: `flipFrom`, `centreRectNow`,
 * `animatedSwitch` and the FLIP `useLayoutEffect` are read nowhere else.
 *
 * The map itself stays mounted and hidden throughout - this hook only ever
 * says which mode is current, never whether `MapView` is in the tree.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { flipTransform, flipCss, rectOf, type Rect } from '../lib/catalog.ts';
import { centerCellRect, overlapsViewport } from '../lib/center.ts';
import { prefersReducedMotion } from './useMapCamera.ts';
import type { Config } from '../../../config/config.ts';

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export type Mode = 'map' | 'catalog';

interface UseModeTransitionOpts {
  canvasRef: { current: HTMLCanvasElement | null };
  cam: { current: Camera };
  /** config.catalog - transitionMs and friends */
  catalogConfig: Config['catalog'];
  /** called before a mode switch commits (e.g. to close an open room card) -
   * fired synchronously from `enterCatalog`/`exitCatalog`, before
   * `setMode`/`setLeaving`. */
  onModeChange?: () => void;
  /** which reading the page opens on - `main.jsx`'s `INITIAL_MODE`, read once
   * from the url. */
  initialMode?: Mode;
}

export function useModeTransition({
  canvasRef, cam, catalogConfig, onModeChange, initialMode = 'map',
}: UseModeTransitionOpts) {
  const [mode, setMode] = useState<Mode>(initialMode);
  // Mounted through the exit animation, so the catalog can fold back into the
  // center tile rather than vanishing. Cleared when the animation lands.
  const [leaving, setLeaving] = useState(false);

  const firstTileRef = useRef<HTMLElement | null>(null);
  // Where the center tile was on the map when the switch began, or null if it
  // was off screen - a reader who panned away has nothing to fold from, and
  // the transition degrades to a cross-fade rather than flying in from a
  // corner.
  const flipFrom = useRef<Rect | null>(null);

  /** The center cell's screen rect, or null if none of it is in view. */
  const centreRectNow = useCallback((): Rect | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const rect = centerCellRect(cam.current, { width: w, height: h });
    return overlapsViewport(rect, w, h) ? rect : null;
  }, [canvasRef, cam]);

  const animatedSwitch = () => !prefersReducedMotion() && catalogConfig.transitionMs > 0;

  const enterCatalog = useCallback(() => {
    flipFrom.current = animatedSwitch() ? centreRectNow() : null;
    onModeChange?.();
    setMode('catalog');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreRectNow, catalogConfig, onModeChange]);

  const exitCatalog = useCallback(() => {
    if (!animatedSwitch()) {
      onModeChange?.();
      setMode('map');
      return;
    }
    // The map is already at the camera it will land on, so the tile's
    // destination is knowable before anything moves.
    flipFrom.current = centreRectNow();
    onModeChange?.();
    setLeaving(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centreRectNow, catalogConfig, onModeChange]);

  /**
   * Run the FLIP, in whichever direction the mode just moved.
   *
   * `useLayoutEffect` because the invert transform has to be applied before
   * the browser paints the catalog in its resting position - one frame of the
   * list at full size, then a jump onto the tile, is exactly the flash this
   * is meant to replace.
   */
  useLayoutEffect(() => {
    const entering = mode === 'catalog' && !leaving;
    if (!entering && !leaving) return;

    const tile = firstTileRef.current;
    const anchor = flipFrom.current;
    const ms = catalogConfig.transitionMs;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Nothing to fold from or to: cross-fade, which the stylesheet does on
    // its own, and just land.
    if (!tile || !anchor || !animatedSwitch()) {
      if (leaving) timer = setTimeout(() => { setMode('map'); setLeaving(false); }, 0);
      return () => clearTimeout(timer);
    }

    // `rectOf`, not the DOMRect itself - see its comment. Passing the DOMRect
    // straight in does not throw; it silently drops the scale.
    const rest = rectOf(tile.getBoundingClientRect());
    const onto = flipCss(flipTransform(anchor, rest));

    if (entering) {
      // Start on the tile, then release to nothing.
      tile.style.transition = 'none';
      tile.style.transform = onto;
      // Read back, so the two writes cannot be coalesced into no animation.
      void tile.offsetWidth;
      tile.style.transition = `transform ${ms}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
      tile.style.transform = '';
      timer = setTimeout(() => {
        tile.style.transition = '';
      }, ms);
    } else {
      // Leaving: from nothing back onto the tile, and land when it arrives.
      tile.style.transition = `transform ${ms}ms cubic-bezier(0.55, 0.06, 0.68, 0.19)`;
      tile.style.transform = onto;
      timer = setTimeout(() => {
        tile.style.transition = '';
        tile.style.transform = '';
        setMode('map');
        setLeaving(false);
      }, ms);
    }

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, leaving, catalogConfig]);

  return { mode, leaving, enterCatalog, exitCatalog, firstTileRef };
}
