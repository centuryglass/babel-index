/**
 * Render one labelled composite per variant, three zoom levels to a picture.
 *
 * Fidelity comes from using the real pieces: the actual book geometry from
 * tools/center-placement/lib/geometry.js, the actual served center tile as the backdrop,
 * and a compositing routine that mirrors composeSpines in center.js line for line
 * (only the styling is lifted out into the variant). Rendering happens in real
 * Chromium via Playwright, because the browser's small-size text rasterisation -
 * hinting, subpixel placement, antialiasing - is the whole thing under test, and
 * node-canvas would rasterise differently from what a reader actually sees.
 *
 * Each composite shows the shelf at three zooms (small / mid / max), every panel
 * at 1:1 so a 6px title is really 6px, and under each a 4x nearest-neighbour
 * magnifier so pixel-level rendering is legible in the screenshot itself.
 *
 * Output: tools/font-lab/out/<group>/<id>.png, plus an index.html contact sheet.
 *
 *   node tools/font-lab/render.mjs
 */
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { layout } from '../center-placement/lib/geometry.js';
import { FONTS } from './fonts.mjs';
import { VARIANTS, REQUIRED_FACES } from './variants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'out');

// The three zooms (pixels per cell WIDTH), one panel each, at the states a reader
// actually occupies. The wider-book center tile roughly doubled spine width, so
// the old [760, 1280, 2048] - picked to step the font 6/10/13px on the 160-book
// shelf - now lands all three in the 13px clamp and renders identical text. These
// track the tile's native width instead:
//   - 600:  below native, where a spine is still legible but the title has not yet
//           reached its size cap - the hardest-to-read state the map still draws.
//   - 1024: the opening view on a typical display (1x native, the opening zoom cap).
//   - 2048: the app's 2x manual zoom cap, "zoom in to read a spine".
// Panels render at 1:1 from these.
const NATIVE_W = 1024; //     BASE tile native width == the opening zoom cap
const MAX_ZOOM_FACTOR = 2; // app's MAX_ZOOM_FACTOR (manual zoom reaches 2x native)
const ZOOMS = [600, NATIVE_W, NATIVE_W * MAX_ZOOM_FACTOR];

// A fixed, varied set of titles so every screenshot carries identical text and
// the only variable is the rendering. Long entries exercise the ellipsis.
const SAMPLE_TITLES = [
  'art nouveau', 'the garden of forking paths', 'cathedral', 'clockwork',
  'moonlit harbour', 'biology', 'a study in the vermilion hour', 'ornament',
  'the library', 'gears', 'stained glass', 'entropy', 'the map of tender',
  'wren', 'illumination', 'brass', 'the cartographer', 'lichen', 'folio',
  'the untranslatable', 'marginalia', 'aqueduct', 'a treatise on shadows',
  'vellum', 'the orrery', 'moss', 'palimpsest', 'the hexagonal gallery',
  'astrolabe', 'quire', 'the silent index', 'foxfire',
];

/**
 * CLI flags. Each is a GLOBAL override applied on top of every variant, so you
 * run the default sweep once, then re-run with a flag to see the whole set under
 * that condition. Flagged runs land in out/variants/<suffix>/ so they never
 * clobber the baseline sheets.
 *
 *   --dpr <n>              panel device pixel ratio (1 = a 1080p screen, 2 = retina). Default 1.
 *   --caps                force ALL CAPS titles
 *   --backdrop            rounded plate per book instead of the outline halo
 *   --ink <rgba>          title colour, e.g. "rgba(238,230,214,0.92)"
 *   --backdrop-color <rgba>  plate fill (implies --backdrop), e.g. "rgba(0,0,0,0.6)"
 */
function parseCli() {
  const { values } = parseArgs({
    options: {
      dpr: { type: 'string', default: '1' },
      caps: { type: 'boolean', default: false },
      backdrop: { type: 'boolean', default: false },
      ink: { type: 'string' },
      'backdrop-color': { type: 'string' },
    },
  });
  const dpr = Math.max(1, Number(values.dpr) || 1);
  const overrides = {};
  if (values.caps) overrides.caps = true;
  if (values.ink) overrides.ink = values.ink;
  if (values.backdrop || values['backdrop-color']) overrides.backdrop = true;
  if (values['backdrop-color']) overrides.backdropColor = values['backdrop-color'];

  // A directory-safe suffix naming the active conditions, for the output path.
  const parts = [];
  if (dpr !== 1) parts.push(`dpr${dpr}`);
  if (overrides.caps) parts.push('caps');
  if (overrides.backdrop) parts.push('backdrop');
  if (overrides.ink) parts.push('ink');
  if (overrides.backdropColor) parts.push('bg');
  return { dpr, overrides, suffix: parts.join('-') };
}

/** Fill every book slot deterministically from the sample pool. */
function buildSlots(count) {
  return Array.from({ length: count }, (_, i) => SAMPLE_TITLES[i % SAMPLE_TITLES.length]);
}

/** family+weight -> the woff2 file we downloaded, via the FONTS slug table. */
function faceFile(face) {
  const font = FONTS.find((f) => f.family === face.family);
  if (!font) throw new Error(`no slug for family ${face.family}`);
  return join(HERE, 'fonts', `${font.slug}-${face.weight}.woff2`);
}

async function dataUri(path, mime) {
  const buf = await readFile(path);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Runs INSIDE the page. Draws the center tile at each zoom, composites the spines
 * with the variant's styling, and stitches a labelled contact strip. Returns a
 * PNG data URL. `env` carries everything precomputed on the Node side.
 */
function renderInPage(variant, env) {
  const { centerW, centerH, books, caseFrame, slots, zooms, dpr } = env;

  // A true 1080p sheet: one PNG pixel is one on-screen pixel, so the panels show
  // the spines at exactly the size a reader sees on a 1920x1080 display. `dpr`
  // supersamples the panel rasterisation to represent a higher-density (retina)
  // screen: same on-sheet SIZE, but the glyphs carry `dpr`x the pixel detail,
  // which the magnifier then reveals. Only the TOP-LEFT PORTION of the shelf is
  // shown - half the opening box each way, the same region at every zoom - which
  // keeps even the 2x-native panel inside its third of the sheet while still
  // showing several books across more than one shelf.
  const OUT_W = 1920;
  const OUT_H = 1080;

  const img = env._img; // preloaded HTMLImageElement, stashed by the caller

  // --- the upper-left case quadrant at a given zoom, spines composited on top ---
  const MARGIN = 14; // px of wall kept around the case's top-left corner
  function renderPanel(zoom) {
    const cellW = zoom;
    const cellH = zoom * (centerH / centerW);
    // The case rect in screen px at this zoom.
    const cf = {
      x: caseFrame.x * cellW,
      y: caseFrame.y * cellH,
      w: caseFrame.w * cellW,
      h: caseFrame.h * cellH,
    };
    // Crop = MARGIN of wall + the top-left quarter of the case. Logical px; the
    // backing canvas is `dpr`x this so the raster carries retina detail.
    const cropW = Math.round(MARGIN + cf.w / 2);
    const cropH = Math.round(MARGIN + cf.h / 2);
    // Cell's screen origin so the case sits MARGIN in from the crop's top-left.
    const cell = { x: -(cf.x - MARGIN), y: -(cf.y - MARGIN), w: cellW, h: cellH };

    const cv = document.createElement('canvas');
    cv.width = cropW * dpr;
    cv.height = cropH * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, centerW, centerH, cell.x, cell.y, cellW, cellH);
    composeSpines(ctx, cell);
    // The top-left book's crop position, so the magnifier lands on spines rather
    // than on the case's wooden frame (which grows in px with zoom).
    const b0 = books[0];
    const anchor = { x: cell.x + b0.x * cellW, y: cell.y + b0.y * cellH };
    return { cv, cropW, cropH, cellW, anchor };
  }

  // --- the compositor: a faithful copy of center.js composeSpines, styled ------
  const MIN_SPINE_PX = 5;
  function composeSpines(ctx, cellRect) {
    const rects = books.map((b) => ({
      x: cellRect.x + b.x * cellRect.w,
      y: cellRect.y + b.y * cellRect.h,
      w: b.w * cellRect.w,
      h: b.h * cellRect.h,
    }));
    if (rects.length === 0 || rects[0].w < MIN_SPINE_PX) return;

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${variant.letterSpacing}px`;
    for (let i = 0; i < rects.length; i++) {
      let text = slots[i];
      if (!text) continue;
      if (variant.caps) text = text.toUpperCase();
      const r = rects[i];
      const fontPx = Math.max(
        variant.minPx,
        Math.min(variant.maxPx, Math.floor(r.w * variant.sizeScale))
      );
      ctx.font = `${variant.style} ${variant.weight} ${fontPx}px ${variant.fontFamily}`;

      ctx.save();
      ctx.translate(r.x + r.w / 2, r.y);
      ctx.rotate(Math.PI / 2);
      const inset = Math.min(4, r.h * 0.1);
      const fitted = fitText(ctx, text, r.h - inset * 2);

      if (variant.backdrop) {
        // A rounded plate sized to the text, running down the spine. In this
        // rotated frame +x is down-spine and the baseline sits at y = 0
        // (textBaseline 'middle'), so the plate straddles y = 0 by ~fontPx.
        const padX = Math.max(1.5, fontPx * 0.14);
        const padY = Math.max(1, fontPx * 0.16);
        const tw = ctx.measureText(fitted).width;
        ctx.fillStyle = variant.backdropColor;
        ctx.beginPath();
        ctx.roundRect(
          inset - padX,
          -fontPx / 2 - padY,
          tw + padX * 2,
          fontPx + padY * 2,
          Math.min(3, fontPx * 0.28)
        );
        ctx.fill();
      } else if (variant.halo) {
        ctx.lineWidth = Math.max(variant.haloFloor ?? 1.5, fontPx * variant.haloScale);
        ctx.strokeStyle = variant.halo;
        ctx.lineJoin = 'round';
        ctx.strokeText(fitted, inset, 0);
      }
      ctx.fillStyle = variant.ink;
      ctx.fillText(fitted, inset, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
    return `${s}…`;
  }

  // --- lay panels + magnifiers + labels into the fixed 1920x1080 frame --------
  const panels = zooms.map(renderPanel);

  const out = document.createElement('canvas');
  out.width = OUT_W;
  out.height = OUT_H;
  const g = out.getContext('2d');

  g.fillStyle = '#14110d';
  g.fillRect(0, 0, OUT_W, OUT_H);

  // Header.
  g.fillStyle = '#f3ead9';
  g.font = '600 34px ui-sans-serif, system-ui, sans-serif';
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillText(variant.label, 40, 52);
  g.fillStyle = '#a99f8c';
  g.font = '400 20px ui-sans-serif, system-ui, sans-serif';
  g.fillText(variant.sub, 40, 84);

  // Three equal columns; the quadrant panel sits at the top of each, the 4x
  // magnifier in a shared band along the bottom so the three line up.
  const COLS = panels.length;
  const colW = OUT_W / COLS;
  const PANEL_TOP = 150;
  const CAPTION_Y = 128;
  const MAG = 4; //     magnifier: nearest-neighbour blow-up factor
  const MAG_TOP = 632; //  top of the magnifier band
  const MAG_OUT_W = 560; // magnifier output size, uniform across columns
  const MAG_OUT_H = 408;

  panels.forEach((p, i) => {
    const cx = colW * i + colW / 2; // column center

    // Panel: the quadrant at its LOGICAL size (the dpr-supersampled canvas
    // scaled back down), centered in its column, top-aligned.
    const px = Math.round(cx - p.cropW / 2);
    g.drawImage(p.cv, px, PANEL_TOP, p.cropW, p.cropH);

    // Caption: zoom, spine width, resulting font size.
    const spinePx = books[0].w * p.cellW;
    const fontPx = Math.max(
      variant.minPx,
      Math.min(variant.maxPx, Math.floor(spinePx * variant.sizeScale))
    );
    g.fillStyle = '#cdbfa6';
    g.font = '500 17px ui-sans-serif, system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(
      `zoom ${zooms[i]}  ·  spine ${spinePx.toFixed(1)}px  ·  font ${fontPx}px`,
      cx,
      CAPTION_Y
    );

    // Magnifier: a nearest-neighbour blow-up of a fixed LOGICAL region of the
    // top-left spines, so the sheet itself shows how the glyphs rasterise. The
    // region is the same physical extent at any dpr; when dpr > 1 the source
    // carries more device pixels, so the plate reveals the extra retina detail.
    const srcW = MAG_OUT_W / MAG; // logical px sampled
    const srcH = MAG_OUT_H / MAG;
    const sx = Math.max(0, Math.min(p.cropW - srcW, p.anchor.x - 3));
    const sy = Math.max(0, Math.min(p.cropH - srcH, p.anchor.y - 3));
    const mx = Math.round(cx - MAG_OUT_W / 2);
    g.imageSmoothingEnabled = false;
    // Source in DEVICE px (the canvas is dpr x logical).
    g.drawImage(p.cv, sx * dpr, sy * dpr, srcW * dpr, srcH * dpr, mx, MAG_TOP, MAG_OUT_W, MAG_OUT_H);
    g.imageSmoothingEnabled = true;
    g.strokeStyle = '#3a342a';
    g.strokeRect(mx + 0.5, MAG_TOP + 0.5, MAG_OUT_W, MAG_OUT_H);
    g.fillStyle = '#8a8071';
    g.font = '400 14px ui-sans-serif, system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText(dpr > 1 ? `${MAG}× · @${dpr}× dpr` : `${MAG}× actual pixels`, mx + 8, MAG_TOP + 22);
  });

  return out.toDataURL('image/png');
}

async function main() {
  const { dpr, overrides, suffix } = parseCli();
  // Flagged runs get their own directory so they never clobber the baseline.
  const runDir = suffix ? join(OUT, 'variants', suffix) : OUT;

  const g1 = layout({ width: 1, height: 1 });
  const books = g1.shelves.flatMap((s) => s.books.map(({ x, y, w, h }) => ({ x, y, w, h })));
  const caseFrame = g1.opening;
  const slots = buildSlots(books.length);

  const centerUri = await dataUri(join(ROOT, 'assets', 'center_tile.png'), 'image/png');
  const faces = [];
  for (const face of REQUIRED_FACES) {
    faces.push({ ...face, uri: await dataUri(faceFile(face), 'font/woff2') });
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Load the webfonts and the center image once, then reuse across variants.
  await page.evaluate(async ({ faces, centerUri }) => {
    for (const f of faces) {
      const ff = new FontFace(f.family, `url(${f.uri})`, {
        weight: String(f.weight),
        style: 'normal',
      });
      await ff.load();
      document.fonts.add(ff);
    }
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = centerUri;
    });
    // `window` here is the Playwright page's DOM, not this process's - tsc only
    // sees it as the ambient lib.dom Window, which has no `__env`, so stash it
    // through an untyped alias rather than fight the ambient type for a bridge
    // variable that only ever exists in the page.
    const win = /** @type {any} */ (window);
    win.__env = { _img: img };
  }, { faces, centerUri });

  const written = [];
  for (const base of VARIANTS) {
    const variant = { ...base, ...overrides }; // CLI flags win over the variant
    const dir = join(runDir, variant.group);
    await mkdir(dir, { recursive: true });
    const url = await page.evaluate(
      ({ variant, shared, renderSrc }) => {
        const win = /** @type {any} */ (window);
        const env = { ...shared, _img: win.__env._img };
        // Re-hydrate the render function from its source (functions don't cross
        // the bridge). It closes over `variant` and `env` as normal args.
        const fn = new Function('return (' + renderSrc + ')')();
        return fn(variant, env);
      },
      {
        variant,
        shared: { centerW: 1024, centerH: 768, books, caseFrame, slots, zooms: ZOOMS, dpr },
        renderSrc: renderInPage.toString(),
      }
    );
    const b64 = url.split(',')[1];
    const file = join(dir, `${variant.id}.png`);
    await writeFile(file, Buffer.from(b64, 'base64'));
    written.push({ variant, rel: join(variant.group, `${variant.id}.png`) });
    console.log(`wrote ${join(variant.group, variant.id)}.png`);
  }

  await browser.close();
  const banner = suffix ? ` [${suffix.replace(/-/g, ', ')}]` : '';
  await writeContactSheet(runDir, written, banner);
  console.log(`\n${written.length} composites in ${runDir}\nopen ${join(runDir, 'index.html')}`);
}

/** A single scrollable page linking every composite, grouped by sweep. */
async function writeContactSheet(runDir, written, banner) {
  const groups = {};
  for (const w of written) (groups[w.variant.group] ??= []).push(w);
  const section = (name, items) => `
    <h2>${name}</h2>
    ${items
      .map(
        (w) => `<figure><img src="${w.rel}" alt="${w.variant.label}"><figcaption>${w.variant.label} — ${w.variant.sub}</figcaption></figure>`
      )
      .join('\n')}`;

  // The settings sweep now runs once per font, each in its own settings/<slug>/
  // group - one section per font, in the same order as the fonts sweep.
  const settingsGroups = Object.keys(groups)
    .filter((g) => g.startsWith('settings/'))
    .sort();
  const settingsSections = settingsGroups
    .map((g) => {
      const items = groups[g];
      const family = items[0]?.variant.label.split(' — ')[0] ?? g;
      return section(`Settings — ${family} (one knob at a time)`, items);
    })
    .join('\n');

  const html = `<!doctype html><meta charset="utf8"><title>Spine font lab</title>
<style>
  body{background:#14110d;color:#f3ead9;font:16px ui-sans-serif,system-ui,sans-serif;margin:0;padding:32px}
  h1{font-weight:600} h2{margin:40px 0 8px;color:#cdbfa6;border-bottom:1px solid #3a342a;padding-bottom:6px}
  figure{margin:0 0 28px} img{max-width:100%;height:auto;display:block;border:1px solid #2a251d}
  figcaption{color:#a99f8c;margin-top:6px}
</style>
<h1>Book-spine title rendering — font &amp; settings sweep${banner}</h1>
${section('Fonts (baseline settings)', groups.fonts ?? [])}
${settingsSections}`;
  await writeFile(join(runDir, 'index.html'), html);
}

main();
