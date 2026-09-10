/**
 * Render-mode parity: drive the SAME corpus, viewport and camera through both
 * the Canvas2D renderer and the experimental WebGL one (`?webgl` -
 * `webglFlag.ts`/`glRenderer.ts`/`glSlideRenderer.ts`), and check the two draw
 * the same map. This is the "manual side-by-side" that
 * `docs/implementation-plan.md`'s Rendering section names as the last thing
 * standing between the GL renderer and flipping `DEFAULT_WEBGL` - the recording
 * fakes in `glRenderer.test.ts`/`glSlideRenderer.test.ts` assert draw-call
 * shape, never pixels or a real GPU.
 *
 * TWO checks per scene, one strict and one loose:
 *   - HUD parity is the strict, deterministic backbone. Both renderers print
 *     their own account of the frame (`support.ts`'s `parseHud`), and every
 *     draw-loop decision that isn't a raw pixel - which pyramid level, how many
 *     cells substituted/blank, the shared tile cache's occupancy - must agree,
 *     because the two loops are supposed to run in lockstep (see AGENTS.md, "The
 *     WebGL renderer").
 *   - A pixel diff is the loose guard. GL's LINEAR sampling and the browser's
 *     2D image smoothing genuinely differ at tile edges and on text, so an
 *     exact match is not the bar; the bar is "these are the same picture, not
 *     two different ones" - it catches a renderer drawing nothing, the wrong
 *     tile, or a missing badge. Every scene writes canvas2d/webgl/diff PNGs to
 *     `packages/web/e2e/artifacts/` so a human can read what the number meant.
 *
 * DELIBERATELY NOT part of `npm test` OR `npm run test:e2e` - the `.parity.ts`
 * suffix matches neither glob. It needs a real GPU and boots two servers and
 * two browsers, so it is a thing you run on purpose:
 *
 *   npx playwright install chromium   # once
 *   npm run test:parity
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  SEARCH_TIMEOUT, artifacts, closeLibrary, hud, landed, openLibrary, recentre, settled,
} from './support.ts';

// `?debug` exposes the scripted-action runner on `window.__babelDebug`
// (main.tsx) - the parity scenes drive deterministic camera/search state
// through it. Typed locally at each call site (not via a `declare global`
// Window augmentation, which would leak this narrow shape across the whole
// project and collide with main.tsx's own, fuller `__babelDebug`).
type BabelDebug = { __babelDebug: { actions: { zoom(f: number): void; search(q: string): void } } };

/**
 * The HUD fields that are a per-frame draw-loop DECISION rather than a raw
 * pixel, so they must match exactly between the two renderers at the same
 * camera: how many cells are in view, how many were drawn vs substituted from a
 * coarser level vs left blank, which pyramid level and tile size that implies,
 * and the search's clustered/blocked counts. `favHit` is camera/DPR geometry,
 * identical by construction, and `x`/`y` are asserted separately (exact).
 *
 * Deliberately NOT here: `cached` and `over`. Both count the shared decoded-tile
 * cache's occupancy (`tiles.ts`), which depends on decode and prefetch TIMING,
 * and each renderer has its own warm path (`gl/warm.ts` vs the Canvas2D loop) -
 * so they drift by a tile or two frame-to-frame without either renderer being
 * wrong. Asserting them made this suite intermittently fail on an off-by-one.
 */
const PARITY_FIELDS = [
  'cells', 'drawn', 'level', 'tilePx', 'substituted', 'blank',
  'zoom', 'clustered', 'blocked',
];

function assertHudParity(c2d, gl, scene) {
  assert.ok(gl.gl, `${scene}: the webgl session's HUD must be the GL renderer's`);
  assert.ok(!c2d.gl, `${scene}: the other session must be the Canvas2D renderer`);
  for (const f of PARITY_FIELDS) {
    assert.equal(
      gl[f], c2d[f],
      `${scene}: HUD field "${f}" diverged - canvas2d=${c2d[f]} webgl=${gl[f]}\n` +
      `  canvas2d: ${JSON.stringify(c2d)}\n  webgl:    ${JSON.stringify(gl)}`
    );
  }
  assert.equal(gl.x, c2d.x, `${scene}: camera x diverged - canvas2d=${c2d.x} webgl=${gl.x}`);
  assert.equal(gl.y, c2d.y, `${scene}: camera y diverged - canvas2d=${c2d.y} webgl=${gl.y}`);
}

/**
 * A PNG of just the map canvas, base64, captured only once the canvas has
 * stopped changing. `landed`/`settled` wait out the CAMERA and any
 * rearrangement, but neither waits for tiles to finish decoding and (under GL)
 * uploading - so a screenshot taken the instant the camera rests can catch one
 * renderer a frame or two ahead of the other as tiles sharpen, and the two
 * differ for a reason that has nothing to do with a real parity break. Polling
 * the screenshot to a fixed point (two byte-identical captures in a row -
 * Chromium encodes identical pixels deterministically) is the renderer-agnostic
 * way to know the frame is done; `fingerprint()` can't help here because it
 * reads a 2D context the GL canvas doesn't have.
 */
async function stableCanvasPng(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let prev = await page.locator('canvas').screenshot();
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const cur = await page.locator('canvas').screenshot();
    if (cur.equals(prev)) return cur.toString('base64');
    prev = cur;
  }
  // Never settled - hand back the last frame anyway so the diff still runs and
  // the artifacts still land; a genuinely never-settling canvas is itself a
  // finding the pixel bound will surface rather than hide behind a timeout.
  return prev.toString('base64');
}

/**
 * Decode two canvas PNGs in a real browser and diff them. Runs entirely
 * in-page (OffscreenCanvas + createImageBitmap) so no image-decode dependency
 * has to enter the repo, and returns scalar metrics plus a diff PNG whose
 * red pixels are the strongly-different ones. `page` can be either session's -
 * the decode is renderer-agnostic.
 *
 *   - meanAbs: mean per-channel absolute difference over every pixel (0-255).
 *     Stable across machines; a correct render pair sits in the low single
 *     digits (AA/filtering), a broken one is far higher.
 *   - strongFraction: fraction of pixels whose worst channel differs by more
 *     than 32 - the "these disagree about what is here" pixels.
 */
async function diffCanvasPng(page, aB64, bB64) {
  return page.evaluate(async ([a64, b64]) => {
    const toBitmap = async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    };
    const a = await toBitmap(a64);
    const b = await toBitmap(b64);
    const w = Math.min(a.width, b.width);
    const h = Math.min(a.height, b.height);
    const ctxOf = (bmp) => {
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext('2d');
      x.drawImage(bmp, 0, 0);
      return x.getImageData(0, 0, w, h).data;
    };
    const da = ctxOf(a);
    const db = ctxOf(b);
    const out = new OffscreenCanvas(w, h);
    const xo = out.getContext('2d');
    const img = xo.createImageData(w, h);
    const od = img.data;
    let sum = 0;
    let strong = 0;
    const n = w * h;
    for (let i = 0; i < da.length; i += 4) {
      const dr = Math.abs(da[i] - db[i]);
      const dg = Math.abs(da[i + 1] - db[i + 1]);
      const dbl = Math.abs(da[i + 2] - db[i + 2]);
      sum += (dr + dg + dbl) / 3;
      const m = Math.max(dr, dg, dbl);
      if (m > 32) {
        strong++;
        od[i] = 255; od[i + 1] = 0; od[i + 2] = 0; od[i + 3] = 255;
      } else {
        od[i] = od[i + 1] = od[i + 2] = m; od[i + 3] = 255;
      }
    }
    xo.putImageData(img, 0, 0);
    const blob = await out.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (const byte of buf) bin += String.fromCharCode(byte);
    return {
      w, h, sameSize: a.width === b.width && a.height === b.height,
      meanAbs: sum / n, strongFraction: strong / n, diffB64: btoa(bin),
    };
  }, [aB64, bB64]);
}

const b64ToBuf = (b64) => Buffer.from(b64, 'base64');

describe('render-mode parity: Canvas2D vs WebGL draw the same map', { concurrency: false }, () => {
  let c2d;
  let gl;

  before(async () => {
    // Favorites on both so the on-map favorite badge (and, under GL, its glow
    // texture path) is actually drawn on every real room in the zoomed scene.
    // Both sessions get the identical viewport and corpus openLibrary fixes, so
    // the only variable between them is the renderer.
    [c2d, gl] = await Promise.all([
      openLibrary({ favorites: true, webgl: false }),
      openLibrary({ favorites: true, webgl: true }),
    ]);
    await mkdir(artifacts, { recursive: true });
  });

  after(async () => {
    await Promise.all([
      closeLibrary(c2d, 'parity-canvas2d.png'),
      closeLibrary(gl, 'parity-webgl.png'),
    ]);
  });

  /**
   * Bring both renderers to the same camera, let each canvas settle to a fixed
   * frame, THEN read each HUD (so `substituted`/`drawn`/`blank` reflect the
   * converged frame on both, not a moment mid-warm), assert the strict parity,
   * and capture + diff + save artifacts. Returns the diff so the caller can
   * assert the loose pixel bound with a scene-appropriate threshold.
   */
  async function compareScene(scene, drive) {
    await Promise.all([drive(c2d), drive(gl)]);
    // Settle the pixels before reading anything - the HUD parity and the pixel
    // diff must both describe the same, finished frame (see `stableCanvasPng`).
    const [pngC2d, pngGl] = await Promise.all([
      stableCanvasPng(c2d.page), stableCanvasPng(gl.page),
    ]);
    const [statsC2d, statsGl] = await Promise.all([hud(c2d.page), hud(gl.page)]);
    assertHudParity(statsC2d, statsGl, scene);

    const diff = await diffCanvasPng(c2d.page, pngC2d, pngGl);
    await Promise.all([
      writeFile(resolve(artifacts, `parity-${scene}-canvas2d.png`), b64ToBuf(pngC2d)),
      writeFile(resolve(artifacts, `parity-${scene}-webgl.png`), b64ToBuf(pngGl)),
      writeFile(resolve(artifacts, `parity-${scene}-diff.png`), b64ToBuf(diff.diffB64)),
    ]);
    assert.ok(
      diff.sameSize,
      `${scene}: the two canvases screenshotted at different sizes (${diff.w}x${diff.h})`
    );
    // eslint-disable-next-line no-console
    console.log(
      `[parity] ${scene}: meanAbs=${diff.meanAbs.toFixed(2)} ` +
      `strongFraction=${(diff.strongFraction * 100).toFixed(2)}%`
    );
    return diff;
  }

  // No far-zoom "overview" scene, on purpose. At the return-to-center view the
  // whole map's room tiles exceed the decoded-tile cache budget, so each of the
  // two independently-warmed sessions settles with a DIFFERENT subset of tiles
  // at a different pyramid level (the aggregate `substituted` count can
  // coincide while *which* cells are coarse does not). The pixel diff there
  // swings run to run for a reason that is not a renderer parity break - the
  // artifact's differences land squarely on the detailed room tiles and never
  // the flat generics. The scenes below are zoomed in far enough that every
  // visible tile resolves to its target level, which is what makes them
  // deterministic (identical meanAbs across runs) and the diff meaningful.
  // Steady-state diffs sit near meanAbs 1 / strongFraction <1% on this GPU; the
  // sabotage check (a renderer drawing no tiles) hit ~37 / ~50%, so the bounds
  // below clear the good case with cross-GPU AA/filtering headroom while
  // staying an order of magnitude under broken.

  test('center-zoom: the center tile large - spines, books, favorite badges', async () => {
    // Deterministic because both sessions start from the identical recentre and
    // `actions.zoom(f)` multiplies the current zoom while holding x/y, so both
    // land at the same camera centred on cell (0, 0).
    const diff = await compareScene('center-zoom', async (s) => {
      await recentre(s.page, s.flightMs);
      await s.page.evaluate(() => (window as unknown as BabelDebug).__babelDebug.actions.zoom(4));
      return landed(s.page, s.flightMs);
    });
    // Spine text and badge edges push this scene's diff up (meanAbs ~1.2,
    // strongFraction ~1% observed) - the highest of the three, so a touch more
    // headroom than the flatter overview/searched scenes.
    assert.ok(diff.meanAbs < 10, `center-zoom meanAbs too high: ${diff.meanAbs}`);
    assert.ok(diff.strongFraction < 0.12, `center-zoom strongFraction too high: ${diff.strongFraction}`);
  });

  test('searched: a search rearranges both to the same clustered layout', async () => {
    const diff = await compareScene('searched', async (s) => {
      await recentre(s.page, s.flightMs);
      await s.page.evaluate(
        () => (window as unknown as BabelDebug).__babelDebug.actions.search('hexagonal galleries')
      );
      // The first search on a cold machine downloads the CLIP text tower; the
      // rearrangement can lag well past a normal request, so settle generously.
      const deadline = Date.now() + SEARCH_TIMEOUT;
      for (;;) {
        const c = await settled(s.page);
        if (c.clustered > 0 && c.x === 0.5 && c.y === 0.5) return c;
        assert.ok(Date.now() < deadline, 'the search never settled back at centre');
      }
    });
    assert.ok(diff.meanAbs < 8, `searched meanAbs too high: ${diff.meanAbs}`);
    assert.ok(diff.strongFraction < 0.1, `searched strongFraction too high: ${diff.strongFraction}`);
  });

  test('nothing was logged to either console', () => {
    assert.deepEqual(c2d.consoleErrors, [], 'canvas2d console errors');
    assert.deepEqual(gl.consoleErrors, [], 'webgl console errors');
  });
});
