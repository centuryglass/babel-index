/**
 * The browser smoke test for the WebGL map renderer
 * (`?webgl` - see `webglFlag.ts`/`glRenderer.ts`/`glSlideRenderer.ts`/
 * `useMapRendererGL.ts` and `AGENTS.md`'s "The WebGL renderer"
 * section). `glRenderer.test.ts`/`glSlideRenderer.test.ts` already cover the
 * draw loop's own decisions against a recording `GLContext` fake - this file
 * is the one thing those cannot see: that a real `WebGL2RenderingContext`
 * actually accepts the calls this renderer makes, on a real GPU, in a real
 * browser.
 *
 * `openLibrary({ webgl: true })` boots the same corpus every other file in this
 * suite uses, with `?webgl` pinned on the query string so `webglFlag.ts`'s
 * `WEBGL` is true before `main.tsx` ever mounts. The rest of the suite pins
 * `webgl=0` (Canvas2D) for its 2D-canvas readbacks; this file is the GL smoke.
 *
 * None of the files in this directory are part of `npm test`; run them on
 * purpose:
 *
 *   npx playwright install chromium   # once
 *   npm run test:e2e
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

    await page.locator('input[type=search]').fill('hexagonal galleries');
    await page.locator('input[type=search]').press('Enter');

    // A search zooms out in place to show the rearrangement, then eases back
    // to the same x/y/zoom it was called from - see `map-gestures.e2e.ts`'s
    // identical assertion against the Canvas2D renderer. `settled()` already
    // waits out `[gl] rearranging …` the same way it waits out the plain
    // Canvas2D text (`support.ts`'s `parseHud`/`settled` both strip the `[gl] `
    // prefix before reading the state underneath).
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
