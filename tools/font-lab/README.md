# Spine-title font lab

An offline sweep for choosing the typeface and rendering settings of the center
room's book-spine titles (`composeSpines` in `packages/web/src/center.js`). It
renders one labelled composite per option so the choice can be made by eye rather
than by argument.

Spine titles land at roughly **11–20px** on screen (the size clamps in
`composeSpines`), so this is really a small-size legibility test: what matters is
how a face rasterises at text size, not how it looks on a specimen poster. The
wider-book center tile (see the plan's §phase 5 update) doubled the spine width
and lifted the size crisis the earlier 6–13px sweep chased — so the size cap is
now itself one of the things under test (the `set-1x-cap-*` variants).

## Run

```sh
node tools/font-lab/download-fonts.mjs   # once: pull the OFL woff2s into fonts/
node tools/font-lab/render.mjs           # write out/**.png + out/index.html
```

Both are dependency-light: `download-fonts.mjs` uses `fetch`, `render.mjs` uses
the `playwright` chromium already installed for the e2e tests. Open
`tools/font-lab/out/index.html` for the contact sheet.

### Flags

Each flag is a **global override** applied on top of every variant, so you run
the default sweep once, then re-run under a condition to see the whole set that
way. Flagged runs land in `out/variants/<suffix>/` and never clobber the
baseline sheets.

```sh
node tools/font-lab/render.mjs --dpr 2              # panels as a retina screen sees them
node tools/font-lab/render.mjs --caps              # ALL CAPS titles
node tools/font-lab/render.mjs --backdrop          # rounded plate per book, no outline
node tools/font-lab/render.mjs --ink "rgba(255,240,200,1)"
node tools/font-lab/render.mjs --backdrop-color "rgba(10,10,20,0.7)"   # implies --backdrop
node tools/font-lab/render.mjs --dpr 2 --caps --backdrop               # combine freely
```

| flag | effect |
| --- | --- |
| `--dpr <n>` | panel device pixel ratio: 1 = a 1080p screen (default), 2 = retina. Same on-sheet size, `n`× the glyph detail — visible in the magnifier, whose label then reads `4× · @n× dpr`. |
| `--caps` | uppercase every title |
| `--backdrop` | draw a rounded plate behind each title (sized to the text) instead of the outline halo |
| `--ink <rgba>` | title colour (any CSS rgba string) |
| `--backdrop-color <rgba>` | plate fill; implies `--backdrop` |

The `--dpr` panels stay the same on-sheet *size* (a 1080p sheet can't show more
than 1080p); the retina difference shows in the magnifier, which reveals the
denser rasterisation. Two settings variants — `set-08-caps` and
`set-09-backdrop` — also carry these into the default sweep for reference.

## What each composite shows

Every sheet is exactly **1920×1080**, rendered at DPR 1 so one PNG pixel is one
on-screen pixel — the panels show the spines at the size a reader actually sees
on a 1080p display. To fit, each panel is the **top-left portion** of the shelf
(half the opening box each way — the same region at every zoom), enough to keep
even the 2×-native panel inside its third of the sheet.

Top row: that region at three zoom levels — **600** (below native, the hardest
legible state the map still draws), **1024** (the opening on a typical display,
1× native) and **2048** (the app's 2× manual zoom cap) — over the real
`assets/center_tile.png` with the actual book geometry. Bottom row: a **4×
nearest-neighbour magnifier** of the top-left spines at each size, so the glyph
rasterisation is visible in the sheet itself. The header names the variant;
captions give the zoom, spine width and font size.

## The two sweeps

- **Fonts** (`out/fonts/`): every candidate face at the settings the app ships
  today, so the only variable is the typeface. Includes the current system-sans
  baseline for reference.
- **Settings** (`out/settings/<slug>/`): for EVERY candidate face (plus the
  system-sans baseline), one face held fixed while a single knob moves —
  weight, halo, tracking, size, **size cap**, ink — each variant a controlled
  A/B off that face's own baseline. Each font gets its own subdirectory (e.g.
  `out/settings/literata/`, `out/settings/eb-garamond/`) so the composites never
  clobber one another. The `set-1x-cap-*` variants raise `maxPx` so the title
  fills the wider spine and keeps growing toward the 2× zoom, instead of
  clamping at 13px the way the shipping default still does. The "weight" variants
  (`set-01`, `set-07`) use each face's heaviest downloaded non-400 weight — 600
  for most faces, 700 for the few (Libre Baskerville, PT Serif, Domine) that only
  ship 400/700.

## Fidelity notes

`render.mjs`'s in-page compositor is a line-for-line copy of `composeSpines`,
with the styling lifted into the variant. If `composeSpines` changes, update the
copy. Rendering is real Chromium because browser small-size text rasterisation is
the thing under test.

## Candidates

Serifs: Literata, Libre Baskerville, Vollkorn, PT Serif, Alegreya, Source Serif
4, plus Bitter, Spectral and (as a delicate counter-example) EB Garamond.
Sans-serifs: Inter, IBM Plex Sans, Source Sans 3, Public Sans, Work Sans — all
chosen for strong hinting and open apertures at text size. The current
system-sans baseline is included for reference.

## Extending

- Add a face: append to `FONTS` in `fonts.mjs`, re-run the downloader.
- Add a rendering variant: append to `settingsSweep` in `variants.mjs`; each entry
  overrides one field of `BASE` (which now also carries `caps`, `backdrop` and
  `backdropColor`).
- The candidate faces and generated `out/` are experiment scratch, not shipped
  assets — nothing in the app imports from here.
