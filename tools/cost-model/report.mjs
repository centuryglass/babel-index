#!/usr/bin/env node
/**
 * What does hosting the library actually cost?
 *
 *   node tools/cost-model/report.mjs
 *
 * Cloudflare R2 bills per GET operation and not per byte, which turns the
 * usual instinct upside down: the resolution pyramid was designed to cut
 * bytes, and bytes are free. So this prints the two columns that matter -
 * operations and dollars - for each way we could serve the corpus, over each
 * kind of visit, at a range of traffic levels.
 *
 * Session request counts come from `sessions.mjs`, which replays camera paths
 * over the real layout and the real level policy. Per-level byte sizes are
 * MEASURED, not assumed: see BYTES below.
 *
 * Prices are constants at the top, with the caveats attached, because they are
 * the one input here that nothing in this repo can verify.
 */
import { runArchetype, createSession, TILE } from './sessions.mjs';
import { createLayout, shuffledOrder } from '../../packages/map/ordering.js';
import { createPyramid } from '../../packages/web/src/pyramid.js';

/**
 * Cloudflare R2, as of August 2026.
 *
 * These could not be fetched from developers.cloudflare.com in the session
 * that wrote this file (egress policy blocked it), so they come from search
 * summaries of the official pricing page and agree with the figures the
 * project owner quoted. Re-check before anyone acts on the total; the rates
 * are stable and long-published, but they are not verified here.
 */
export const R2 = {
  classB: 0.36 / 1e6, // $ per GET
  classBFree: 10e6, // per month
  classA: 4.5 / 1e6, // $ per write
  classAFree: 1e6,
  storage: 0.015, // $ per GB-month
  storageFreeGB: 10,
  egress: 0, // the reason R2 is in the running at all
};

/**
 * Cloudflare Images, for comparison. Note the unit: delivery is $1 per 100,000
 * images delivered, which is $10 per million - about 28x R2's per-GET rate.
 */
export const IMAGES = {
  delivered: 1 / 100e3,
  stored: 5 / 100e3,
};

/**
 * Encoded bytes per room at each level, MEASURED over the 26-image sample
 * corpus cropped to 1024x768 and encoded the way packages/pipeline does
 * (mozjpeg, quality 82). Mean across the sample.
 *
 * Caveat worth carrying: the sample images are already lossy at a lower
 * quality than the pipeline's, so a fresh render re-encoded at q82 would be
 * larger - call it 1.5-3x at level 0. It moves the storage line and the
 * download times; it does not move the operation counts, which is what the
 * bill is made of.
 */
export const BYTES = {
  0: 60_620,
  1: 34_304,
  2: 11_059,
  3: 3_584,
  4: 1_229,
};

/** Sheets are capped at 4096x4096, comfortably inside every browser's decode limit. */
const SHEET_PX = 4096 * 4096;

/** How many rooms of a given level fit in one sheet, and how many sheets the corpus needs. */
export function sheetPlan(level, roomCount = 5000, tile = TILE) {
  const w = Math.round(tile.w / 2 ** level);
  const h = Math.round(tile.h / 2 ** level);
  const perSheet = Math.floor(SHEET_PX / (w * h));
  return { perSheet, sheets: Math.ceil(roomCount / perSheet), w, h };
}

/**
 * The ways we could serve it.
 *
 * `levels` overrides the ladder (one level = no pyramid at all); `atlas` maps
 * a level to how many rooms share a sheet.
 */
export function variants(roomCount = 5000) {
  const l4 = sheetPlan(4, roomCount);
  const l3 = sheetPlan(3, roomCount);
  return {
    flat: {
      label: 'no pyramid - level 0 only',
      opts: { levels: [{ level: 0, divisor: 1, budget: 240 }], warmCoarser: false },
    },
    pyramid: {
      label: 'full pyramid, one file per room per level',
      opts: {},
    },
    'pyramid-nowarm': {
      label: 'full pyramid, no warm-coarser pass',
      opts: { warmCoarser: false },
    },
    'atlas-4': {
      label: `pyramid + L4 as ${l4.sheets} sheet of ${fmtN(l4.perSheet)}`,
      opts: { atlas: new Map([[4, l4.perSheet]]) },
      splits: new Map([[4, l4.perSheet]]),
    },
    // The same bytes in eight pieces: eight operations instead of one, which is
    // nothing, and the first paint no longer waits on the whole corpus.
    'atlas-4x8': {
      label: 'pyramid + L4 as 8 sheets',
      opts: { atlas: new Map([[4, Math.ceil(roomCount / 8)]]) },
      splits: new Map([[4, Math.ceil(roomCount / 8)]]),
    },
    'atlas-34': {
      label: `pyramid + L4/L3 as ${l4.sheets}/${l3.sheets} sheets`,
      opts: { atlas: new Map([[4, l4.perSheet], [3, l3.perSheet]]) },
      splits: new Map([[4, l4.perSheet], [3, l3.perSheet]]),
    },
  };
}

const fmtN = (n) => n.toLocaleString('en-US');

/** Bytes a session downloads, from its distinct urls. */
function sessionBytes(urls, roomCount, splits = new Map()) {
  let bytes = 0;
  for (const u of urls) {
    if (u.startsWith('sheet:')) {
      const [, lvl, idx] = u.split(':');
      const level = Number(lvl);
      const perSheet = splits.get(level) ?? sheetPlan(level, roomCount).perSheet;
      // The last sheet is partial; charging a full one overstates it by up to 9%.
      const rooms = Math.min(perSheet, roomCount - Number(idx) * perSheet);
      bytes += rooms * BYTES[level];
    } else {
      bytes += BYTES[Number(u.split('@')[1])];
    }
  }
  return bytes;
}

const ARCHETYPES = ['glance', 'browse', 'survey', 'scholar'];

/**
 * The traffic mix a project like this actually sees: most arrivals bounce,
 * a few look around, very few tour the whole thing. Stated explicitly so it
 * can be argued with - it is the softest number in the model.
 */
export const MIX = { glance: 0.75, browse: 0.2, survey: 0.03, scholar: 0.02 };

const fmt = (n) => n.toLocaleString('en-US');
const mb = (b) => (b / 1e6).toFixed(1) + ' MB';
const money = (d) => (d === 0 ? '$0' : d < 0.01 ? '<$0.01' : '$' + d.toFixed(2));

const roomCount = 5000;
const results = new Map();

console.log(`\n  ${TILE.w}x${TILE.h} tile, ${fmt(roomCount)} rooms, 20% content slots`);
console.log('  viewport 1440x900 at dpr 2, prefetch ring of 2 cells\n');

// --- per-session operation counts ------------------------------------------
console.log('  OPERATIONS PER SESSION (distinct GETs; repeats hit the browser cache)\n');
console.log(
  '  ' + 'variant'.padEnd(44) + ARCHETYPES.map((a) => a.padStart(9)).join('') + '     mixed'
);
for (const [key, v] of Object.entries(variants(roomCount))) {
  const row = [];
  for (const a of ARCHETYPES) {
    const r = runArchetype(a, { ...v.opts, roomCount });
    results.set(`${key}:${a}`, {
      ops: r.ops,
      bytes: sessionBytes(r.urls, roomCount, v.splits),
    });
    row.push(r.ops);
  }
  const mixed = ARCHETYPES.reduce((s, a, i) => s + row[i] * MIX[a], 0);
  results.set(`${key}:mixed`, {
    ops: mixed,
    bytes: ARCHETYPES.reduce((s, a) => s + results.get(`${key}:${a}`).bytes * MIX[a], 0),
  });
  console.log(
    '  ' + v.label.padEnd(44) + row.map((n) => fmt(n).padStart(9)).join('') + fmt(Math.round(mixed)).padStart(10)
  );
}

// --- per-session bytes ------------------------------------------------------
console.log('\n  BYTES PER SESSION (what the visitor downloads; egress is free on R2)\n');
console.log(
  '  ' + 'variant'.padEnd(44) + ARCHETYPES.map((a) => a.padStart(9)).join('') + '     mixed'
);
for (const [key, v] of Object.entries(variants(roomCount))) {
  const row = ARCHETYPES.map((a) => mb(results.get(`${key}:${a}`).bytes).padStart(9)).join('');
  console.log('  ' + v.label.padEnd(44) + row + mb(results.get(`${key}:mixed`).bytes).padStart(10));
}

// --- storage ----------------------------------------------------------------
console.log('\n  STORAGE\n');
for (const [key, v] of Object.entries(variants(roomCount))) {
  const isFlat = key === 'flat';
  const levels = isFlat ? [0] : [0, 1, 2, 3, 4];
  const bytes = levels.reduce((s, l) => s + BYTES[l] * roomCount, 0);
  const objects = levels.length * roomCount;
  const gb = bytes / 1e9;
  const cost = Math.max(0, gb - R2.storageFreeGB) * R2.storage;
  console.log(
    '  ' + v.label.padEnd(44) + `${gb.toFixed(2)} GB`.padStart(9) +
    `${fmt(objects)} objects`.padStart(18) + money(cost).padStart(10) + ' / month'
  );
}

// --- the bill ---------------------------------------------------------------
const VOLUMES = [1e3, 1e4, 1e5, 1e6, 1e7];
console.log('\n  MONTHLY R2 OPERATION COST, mixed traffic, no CDN cache in front');
console.log('  (10M Class B free per month; the free tier is the whole story)\n');
console.log('  ' + 'variant'.padEnd(44) + VOLUMES.map((v) => fmt(v).padStart(12)).join(''));
console.log('  ' + ' '.repeat(44) + VOLUMES.map(() => 'visits/mo'.padStart(12)).join(''));
for (const [key, v] of Object.entries(variants(roomCount))) {
  const per = results.get(`${key}:mixed`).ops;
  const row = VOLUMES.map((vol) => {
    const ops = per * vol;
    const billable = Math.max(0, ops - R2.classBFree);
    return money(billable * R2.classB).padStart(12);
  }).join('');
  console.log('  ' + v.label.padEnd(44) + row);
}

// --- free-tier headroom ------------------------------------------------------
console.log('\n  FREE-TIER HEADROOM (visits per month before the first cent)\n');
for (const [key, v] of Object.entries(variants(roomCount))) {
  const per = results.get(`${key}:mixed`).ops;
  console.log(
    '  ' + v.label.padEnd(44) + fmt(Math.floor(R2.classBFree / per)).padStart(12) + ' visits/mo'
  );
}

// --- cache ------------------------------------------------------------------
console.log('\n  EFFECT OF A CDN CACHE IN FRONT (full pyramid, 100k visits/mo)');
console.log('  A cache hit is documented not to reach R2 - but see the caveat in the doc.\n');
const perMixed = results.get('pyramid:mixed').ops;
for (const hit of [0, 0.5, 0.9, 0.99]) {
  const ops = perMixed * 1e5 * (1 - hit);
  const billable = Math.max(0, ops - R2.classBFree);
  console.log(
    `  ${(hit * 100).toFixed(0).padStart(3)}% hit ratio` .padEnd(44) +
    fmt(Math.round(ops)).padStart(12) + ' ops' + money(billable * R2.classB).padStart(10)
  );
}

// --- images -----------------------------------------------------------------
console.log('\n  CLOUDFLARE IMAGES, same traffic, for comparison\n');
for (const vol of VOLUMES) {
  const delivered = perMixed * vol;
  const cost = delivered * IMAGES.delivered + 5 * roomCount * IMAGES.stored;
  console.log(
    `  ${fmt(vol).padStart(9)} visits/mo`.padEnd(44) +
    fmt(Math.round(delivered)).padStart(12) + ' delivered' + money(cost).padStart(12)
  );
}

// --- the re-rank ------------------------------------------------------------
//
// The interaction the whole project is built around, and the one the mutable
// arrangement makes expensive: every cell now holds a different room, so the
// screen refetches. Sheets keyed by room ID are immune to it by construction.
console.log('\n  WHAT A SEARCH RE-RANK COSTS (one settled screen, then a new order)\n');
console.log('  ' + 'serving'.padEnd(16) + 'camera'.padEnd(24) + 'first view'.padStart(11) + 'after re-rank'.padStart(15));
{
  const pyramid = createPyramid({ base: TILE });
  const layout = createLayout({
    roomCount,
    contentRatio: 0.2,
    seed: 1,
    aspect: TILE.h / TILE.w,
  });
  const perSheet = Math.ceil(roomCount / 8);
  for (const [name, atlas] of [
    ['per room', new Map()],
    ['L4 as 8 sheets', new Map([[4, perSheet]])],
  ]) {
    for (const [zname, zoom] of [
      ['zoomed out, L4', 26],
      ['mid, L3', 60],
      ['default, L1', 220],
    ]) {
      const s = createSession({
        layout,
        order: shuffledOrder(roomCount, 1),
        pyramid,
        atlas,
      });
      const cam = { x: 0.5, y: 0.5, zoom };
      s.visit(cam);
      const before = s.ops();
      s.rerank(cam, shuffledOrder(roomCount, 99));
      const added = s.ops() - before;
      console.log(
        '  ' + name.padEnd(16) + zname.padEnd(24) + fmt(before).padStart(11) +
        `${fmt(added)} new`.padStart(15)
      );
    }
  }
}

// --- ceiling ----------------------------------------------------------------
console.log('\n  THE CEILING: one visitor cannot cost more than the corpus\n');
const objects = 5 * roomCount + 5;
console.log(`  every room at every level        ${fmt(objects).padStart(12)} ops`);
console.log(`  cost of one such visit           ${money(objects * R2.classB).padStart(12)}`);
console.log(`  visits/mo before the free tier   ${fmt(Math.floor(R2.classBFree / objects)).padStart(12)}\n`);
