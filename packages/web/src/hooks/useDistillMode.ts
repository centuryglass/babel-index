/**
 * Distill mode: hide every generic room and let the corpus rooms already on
 * the map pack together to fill the space, then reverse it.
 *
 * The heavy lifting - moving rooms without ever looking like a teleport - is
 * the sliding-tile animation `useRearrangement.ts` already drives off a
 * `layout`/`order` change; distill mode is a `contentRatio` flip (1 to pack
 * every corpus room into the smallest area near the origin, back to
 * `defaultRatio` to restore the usual sparseness) asked for through
 * `requestAnimation`, like the reorder button or a favorite sort. The flip
 * animates cleanly even though it changes which physical cells are occupied:
 * the corpus's room-id multiset never changes, only where each id sits, and
 * `buildRearrangement` tolerates that - it is what a favorite sort does on
 * every activation.
 *
 * What this hook owns beyond the flip is the fade: nothing composites a
 * generic tile's disappearance elsewhere, so `genericFade` (0-1, read every
 * frame by `render.ts`/`slide.ts` via `useMapRenderer.ts`) is driven by a
 * small rAF loop here. The scalar crossfades generic tiles to their paired
 * distill alternates - `drawGenericFade` in `render.ts` owns what the faded
 * end actually looks like.
 *
 * The sequence is asymmetric.
 *
 * - Entering: fade the generics out first, then flip the ratio and let the
 *   slide carry the corpus rooms inward - by the time anything moves, every
 *   generic cell is already fully faded, so nothing flashes its art mid-ride.
 * - Leaving: flip the ratio and let the slide bring the sparser arrangement
 *   back first (generic cells reappear on camera as any other value would -
 *   a swap or a shift, same as always - but held fully faded throughout),
 *   then fade them in once `requestAnimation`'s `onSettled` reports the
 *   slide has landed. Fading them in ahead of the slide would need the
 *   illusion planner to stage moves it does not make today.
 */
import { useCallback, useRef, useState } from 'react';
import { prefersReducedMotion } from './useMapCamera.ts';

export interface UseDistillModeOpts {
  /** the ratio to restore when leaving distill mode - `config.map.contentRatio` */
  defaultRatio: number;
  /** how long the crossfade takes, each direction - `config.map.distillFadeMs` */
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
  // Read every frame by `useMapRenderer.ts`. A ref, not React state, for the
  // same reason the camera is: it changes every rAF tick, and a frame's worth
  // of re-renders is not the architecture here.
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
