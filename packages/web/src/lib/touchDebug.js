/**
 * `?touchdebug` puts the raw pointer stream on screen.
 *
 * Read at module scope so the whole feature compiles out of a normal session:
 * nothing renders, and `useMapCamera` is handed no callback at all rather than
 * one that discards. Touch is the one layer that cannot be judged from a
 * desktop, and the CDP touch injection the e2e test uses bypasses the browser's
 * own gesture arbitration - so a real device reporting for itself is the only
 * way some of these questions get answered.
 *
 * Its own module because both halves need it and they now live in different
 * files: `main.jsx` hands `appendTouchLog` to the camera hook, and `MapView`
 * mounts the element it writes into. Importing one from the other would be a
 * cycle.
 */
export const TOUCH_DEBUG =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('touchdebug');

const TOUCH_LOG_LINES = 14;
const touchLog = [];

export function appendTouchLog(line) {
  touchLog.push(line);
  if (touchLog.length > TOUCH_LOG_LINES) touchLog.shift();
  const el = document.getElementById('touchlog');
  if (el) el.textContent = touchLog.join('\n');
}
