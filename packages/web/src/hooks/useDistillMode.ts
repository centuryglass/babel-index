/**
 * Distill mode: hide every generic room and let the corpus rooms already on
 * the map pack together to fill the space, then reverse it.
 *
 * The heavy lifting - moving rooms without ever looking like a teleport - is
 * the sliding-tile animation `useRearrangement.ts` already drives off a
 * `layout`/`order` change; distill mode is nothing more than a `contentRatio`
 * flip (1 to pack every corpus room into the smallest area near the origin,
 * back to `defaultRatio` to restore the usual sparseness) asked for through
 * `requestAnimation`, the same way the reorder button or a favorite sort
 * already are. See the plan's Context section for why that flip animates
 * cleanly even though it changes which physical cells are occupied: the
 * corpus's room-id multiset never changes, only where each id sits, and
 * `buildRearrangement` already tolerates that (it's what a favorite sort
 * does on every activation).
 *
 * What this hook owns beyond the flip is the fade: no compositing exists
 * elsewhere for a generic tile to visibly disappear rather than just stop
 * being drawn, so `genericFade` (0-1, read every frame by `render.ts`/
 * `slide.ts` via `useMapRenderer.ts`) is driven by a small rAF loop here,
 * pattern-matched on `useRearrangement.ts`'s own `tick()`.
 *
 * Sequencing is deliberately asymmetric. Entering: fade the generics to
 * black first, THEN flip the ratio and let the slide carry the corpus rooms
 * inward - by the time anything moves, every generic cell is already fully
 * hidden, so nothing flashes its art mid-ride. Leaving: flip the ratio and
 * let the slide bring the sparser arrangement back first (generic cells
 * reappear on camera exactly as any other value would - a swap or a shift,
 * same as always - but held fully black throughout), THEN fade them in once
 * `requestAnimation`'s `onSettled` reports the slide has landed. The
 * alternative - fading generics in while still at the boundary, ahead of the
 * slide - would need the illusion planner to stage moves in a way it does
 * not today; holding the fade through the slide gets the same "nothing
 * teleports, nothing flashes" guarantee without touching `packages/map`.
 */
import { useCallback, useRef, useState } from 'react';
import { prefersReducedMotion } from './useMapCamera.ts';

export interface UseDistillModeOpts {
  /** the ratio to restore when leaving distill mode - `config.map.contentRatio` */
  defaultRatio: number;
  /** how long the black fade takes, each direction - `config.map.distillFadeMs` */
  fadeMs: number;
  setContentRatio: (ratio: number) => void;
  /** from `useRearrangement.ts` */
  requestAnimation: (note: string, opts?: { onSettled?: () => void }) => void;
  requestDraw: () => void;
}

export function useDistillMode({
  defaultRatio,
  fadeMs,
  setContentRatio,
  requestAnimation,
  requestDraw,
}: UseDistillModeOpts) {
  const [distillMode, setDistillMode] = useState(false);
  // Read every frame by `useMapRenderer.ts` - not React state, since it
  // changes every rAF tick and a frame's worth of re-renders is not the
  // architecture here (same reasoning as the camera ref).
  const genericFade = useRef(0);
  // Guards against a second toggle landing mid-fade, before the ratio flip
  // and slide it is building up to have even happened.
  const fading = useRef(false);

  const runFade = useCallback(
    (from: number, to: number, onDone: () => void) => {
      if (prefersReducedMotion()) {
        genericFade.current = to;
        requestDraw();
        onDone();
        return;
      }
      fading.current = true;
      const t0 = performance.now();
      const tick = () => {
        const t = fadeMs <= 0 ? 1 : Math.min(1, (performance.now() - t0) / fadeMs);
        genericFade.current = from + (to - from) * t;
        requestDraw();
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          fading.current = false;
          onDone();
        }
      };
      requestAnimationFrame(tick);
    },
    [fadeMs, requestDraw]
  );

  const toggleDistill = useCallback(() => {
    if (fading.current) return;
    if (!distillMode) {
      runFade(genericFade.current, 1, () => {
        setDistillMode(true);
        requestAnimation('generic rooms hidden');
        setContentRatio(1);
      });
    } else {
      setDistillMode(false);
      requestAnimation('generic rooms restored', {
        onSettled: () => runFade(genericFade.current, 0, () => {}),
      });
      setContentRatio(defaultRatio);
    }
  }, [distillMode, runFade, requestAnimation, setContentRatio, defaultRatio]);

  return { distillMode, toggleDistill, genericFade };
}
