/**
 * The browser smoke test for the WebGL renderer: that a real
 * `WebGL2RenderingContext` accepts the calls `glRenderer.ts` and
 * `glSlideRenderer.ts` make on a live canvas. `glRenderer.test.ts` and
 * `glSlideRenderer.test.ts` cover the same draw loop against a
 * `fakeGLContext()` that records calls rather than running them, so a real
 * driver rejecting one of them surfaces nowhere in `npm test`. AGENTS.md's
 * "The WebGL renderer" carries the standing invariants, and "Testing and CI"
 * explains why every spec here names its renderer rather than inheriting the
 * production default.
 *
 * `openLibrary({ webgl: true })` puts a bare `?webgl` on the url, so
 * `webglFlag.ts`'s `WEBGL` is true before `main.tsx` mounts. Every assertion
 * here reads the HUD, so this file never asks the canvas for the 2D context
 * `support.ts`'s `fingerprint` needs; whether the two renderers draw the same
 * picture is `render-parity.parity.ts`'s question.
 *
 * Not part of `npm test`; how to run the suite is `map-gestures.e2e.ts`'s
 * header.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_TIMEOUT, closeLibrary, hud, landed, openLibrary, settled, waitFor,
} from './support.ts';

describe('the library, in a browser: the WebGL renderer', { concurrency: false }, () => {
  let session;

  before(async () => {
    session = await openLibrary({ webgl: true });
  });

  after(async () => {
    await closeLibrary(session, 'library-webgl.png');
  });

  test('the map draws through the GL renderer, not the Canvas2D one', async () => {
    const { page } = session;
    const stats = await hud(page);
    assert.ok(stats.gl, 'the HUD must be the GL renderer\'s own account of the frame');
    assert.ok(stats.drawn > 0, 'nothing was drawn');
    assert.equal(stats.blank, 0, 'a settled frame should have nothing left blank');
  });

  test('a search completes and its rearrangement settles, same as the Canvas2D path', async () => {
    const { page, flightMs } = session;
    await page.locator('button.search-trigger').click();
    const atField = await landed(page, flightMs);

    await page.locator('input[type=search]').fill('clockwork');
    await page.locator('input[type=search]').press('Enter');

    // A search zooms out in place to give the slide a wall of rooms, then
    // eases back to the x/y/zoom it was called from: the same assertion
    // `map-gestures.e2e.ts`'s `a search reorders the library around wherever
    // the camera already is` makes against Canvas2D. That file waits for the
    // HUD to report `rearranging` before waiting for the return, because until
    // the search response lands the camera is still at `atField` - a position
    // this wait cannot tell from an eased-back one. The same guard is open for
    // this file in `docs/pending_task_list.md`'s "Rearrangement / camera".
    // The waits themselves need no GL-specific handling: `useMapRendererGL.ts`
    // prefixes every HUD line with `[gl] `, and `settled()` and `parseHud`
    // strip it before reading the state underneath.
    await waitFor(
      async () => {
        const c = await settled(page);
        return c.x === atField.x && c.y === atField.y && c.zoom === atField.zoom;
      },
      SEARCH_TIMEOUT,
      'the search never eased the GL camera back to where it was called from'
    );
    const landedStats = await settled(page);
    assert.ok(landedStats.gl, 'still the GL renderer once the rearrangement lands');
    assert.equal(landedStats.blank, 0, 'nothing left blank once the search settled');
  });

  test('nothing was logged to the console', () => {
    assert.deepEqual(session.consoleErrors, []);
  });
});
