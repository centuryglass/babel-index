/**
 * `?touchdebug` puts the raw pointer stream on screen.
 *
 * Read once at module scope, the same gating `perfProbe.ts`'s `PERF` and
 * `debug.ts`'s `DEBUG` use: with the flag off nothing renders, and
 * `useMapCamera` is handed no callback at all rather than one that discards.
 * Touch is the one layer that cannot be judged from a desktop, and
 * `map-gestures.e2e.ts`'s CDP touch injection bypasses the browser's
 * own gesture arbitration - so a real device reporting for itself is the only
 * way some of these questions get answered.
 *
 * Its own module because both halves need it and they live in different
 * files: `main.tsx` hands `appendTouchLog` to the camera hook, and `MapView`
 * mounts the element it writes into. Importing one from the other would be a
 * cycle.
 */
export const TOUCH_DEBUG =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('touchdebug');

const TOUCH_LOG_LINES = 14;
const touchLog: string[] = [];

export function appendTouchLog(line: string): void {
  touchLog.push(line);
  if (touchLog.length > TOUCH_LOG_LINES) touchLog.shift();
  const el = document.getElementById('touchlog');
  if (el) el.textContent = touchLog.join('\n');
}
