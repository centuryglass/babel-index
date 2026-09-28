/**
 * Computed-style snapshot and diff, the guard for a CSS refactor that must
 * change nothing visible (#395).
 *
 *   node --import ./build/register.mjs tools/style-snapshot/index.ts snapshot <out.json>
 *   node --import ./build/register.mjs tools/style-snapshot/index.ts diff <a.json> <b.json>
 *
 * `snapshot` boots the demo server against a scratch copy of the sample corpus
 * (one room gains a `sensitive_content_tags` entry, so the help dialog's
 * content settings render; `--favorites` is on, so every favorite control
 * renders), drives Chromium through the states in `STATES`, and records every
 * standard property `getComputedStyle` enumerates for every element and its
 * `::before`/`::after`.
 * - Each state is recorded at rest, then again under reduced-motion emulation.
 * - Then every focusable element is focused from the keyboard, and the
 *   elements each `:hover` selector names are hovered, up to
 *   `HOVER_PER_SELECTOR` apiece. Each of those records only the target's
 *   subtree and its ancestors, which is everything a `:focus-visible`,
 *   `:focus-within` or `:hover` rule can reach here.
 * - Animations are finished, or paused at their start if infinite, before each
 *   read, so a read never lands mid-frame.
 *
 * `diff` prints every property that differs and exits 1 if any does. Run
 * `snapshot` on the base commit and again on the change: the diff must be
 * empty. `BABEL_E2E_CHROMIUM` picks the browser, as in the e2e suite.
 *
 * This is a scratch tool for the style.css split, removed once it lands.
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { freePort, repoRoot, waitFor } from '../../packages/web/e2e/support.ts';

/** One element's recorded styles: an index into `Snapshot.rows` per key. */
type StateRecord = Record<string, number>;

interface Snapshot {
  props: string[];
  rows: string[][];
  states: Record<string, StateRecord>;
}

const HOVER_PER_SELECTOR = 6;

/** The query every search state runs; a keyword of the sample corpus's first room. */
const QUERY = 'outsider art';

interface State {
  name: string;
  viewport: { width: number; height: number };
  /** Reach the state from a freshly loaded page. */
  setup: (page: Page, origin: string) => Promise<void>;
  javaScript?: boolean;
}

async function loadMap(page: Page, origin: string) {
  await page.goto(`${origin}/?debug&webgl=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => /[1-9]\d* drawn/.test(document.getElementById('hud')?.textContent ?? ''),
    null,
    { timeout: 30_000 }
  );
  await page.locator('.center-book').waitFor({ state: 'visible', timeout: 10_000 });
  await settle(page);
}

async function settle(page: Page) {
  await waitFor(
    async () => !/^rearranging/.test((await page.locator('#hud').textContent().catch(() => '')) ?? ''),
    30_000,
    'the map never settled'
  );
}

async function openCatalog(page: Page, origin: string, search: boolean) {
  await loadMap(page, origin);
  await page.locator('.panel .mode-toggle').click();
  await page.locator('.catalog-row').first().waitFor({ timeout: 5000 });
  if (search) {
    await page.locator('.catalog-search input').fill(QUERY);
    await page.locator('.catalog-search input').press('Enter');
    await waitFor(
      async () => /ranked for/.test((await page.locator('.catalog-count').textContent()) ?? ''),
      60_000,
      'the catalog search never ranked'
    );
  }
}

async function openRoom(page: Page, origin: string, split: boolean) {
  await openCatalog(page, origin, true);
  await page.locator('.catalog-row:not(.catalog-center) .catalog-tile-button').first().click();
  await page.locator('.overlay-columns').waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
  const isSplit = await page.locator('.overlay-columns.columns').count();
  if (Boolean(isSplit) !== split) throw new Error(`room overlay: wanted ${split ? 'split' : 'stacked'}`);
}

async function openStatement(page: Page, origin: string) {
  await loadMap(page, origin);
  await page.locator('.center-book').focus();
  await page.keyboard.press('Enter');
  await page.locator('.statement-overlay').waitFor({ timeout: 5000 });
}

const STATES: State[] = [
  { name: 'map', viewport: { width: 1280, height: 800 }, setup: loadMap },
  {
    name: 'map-search',
    viewport: { width: 1280, height: 800 },
    setup: async (page, origin) => {
      await loadMap(page, origin);
      await page.locator('.center-search input').focus();
      await page.keyboard.type(QUERY);
      await page.keyboard.press('Enter');
      await page.locator('.results-list .result').first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(500);
      await settle(page);
    },
  },
  { name: 'catalog-wide', viewport: { width: 1280, height: 800 }, setup: (p, o) => openCatalog(p, o, true) },
  { name: 'catalog-rest', viewport: { width: 1280, height: 800 }, setup: (p, o) => openCatalog(p, o, false) },
  { name: 'catalog-narrow', viewport: { width: 500, height: 800 }, setup: (p, o) => openCatalog(p, o, true) },
  { name: 'catalog-ultra', viewport: { width: 380, height: 800 }, setup: (p, o) => openCatalog(p, o, true) },
  { name: 'room-split', viewport: { width: 1280, height: 800 }, setup: (p, o) => openRoom(p, o, true) },
  { name: 'room-stacked', viewport: { width: 700, height: 1600 }, setup: (p, o) => openRoom(p, o, false) },
  {
    name: 'help',
    viewport: { width: 1280, height: 800 },
    setup: async (page, origin) => {
      await openCatalog(page, origin, false);
      await page.locator('.shelf-link', { hasText: 'READ ME' }).click();
      await page.locator('.help-overlay').waitFor({ timeout: 5000 });
      await page.locator('.help-block-panel summary').click();
    },
  },
  {
    name: 'help-portrait',
    viewport: { width: 500, height: 900 },
    setup: async (page, origin) => {
      await openCatalog(page, origin, false);
      await page.locator('.shelf-link', { hasText: 'READ ME' }).click();
      await page.locator('.help-overlay').waitFor({ timeout: 5000 });
      await page.locator('.help-block-panel summary').click();
    },
  },
  { name: 'statement', viewport: { width: 1280, height: 800 }, setup: openStatement },
  { name: 'statement-narrow', viewport: { width: 600, height: 900 }, setup: openStatement },
  {
    name: 'babel',
    viewport: { width: 1280, height: 800 },
    setup: async (page, origin) => {
      await openStatement(page, origin);
      await page.locator('.statement-link').click();
      await page.locator('.overlay-scrim.stacked').waitFor({ timeout: 5000 });
    },
  },
  {
    name: 'ssr-catalog',
    viewport: { width: 1280, height: 800 },
    javaScript: false,
    setup: async (page, origin) => {
      await page.goto(`${origin}/catalog`);
    },
  },
  {
    name: 'ssr-room',
    viewport: { width: 1280, height: 800 },
    javaScript: false,
    setup: async (page, origin) => {
      await page.goto(`${origin}/catalog`);
      const href = await page.locator('.ssr-row a').first().getAttribute('href');
      await page.goto(new URL(href, `${origin}/catalog`).href);
    },
  },
];

/**
 * Runs in the page: freezes animations and returns the computed styles of
 * every element under `rootSel`'s matches (or the whole document), keyed by
 * a tag-and-index path, plus their ancestors when `ancestors` is set.
 */
function collect(args: { root: string | null; ancestors: boolean }) {
  for (const a of document.getAnimations()) {
    const end = a.effect?.getComputedTiming().endTime;
    if (typeof end === 'number' && Number.isFinite(end)) a.finish();
    else {
      a.pause();
      a.currentTime = 0;
    }
  }
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const parent = e.parentElement;
      const i = parent ? Array.prototype.indexOf.call(parent.children, e) : 0;
      parts.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}[${i}]`);
    }
    return parts.reverse().join('>');
  };
  const targets = new Set<Element>();
  const roots = args.root ? [document.querySelector(`[data-style-snapshot="${args.root}"]`)] : [document.documentElement];
  for (const r of roots) {
    if (!r) continue;
    targets.add(r);
    for (const d of r.querySelectorAll('*')) targets.add(d);
    if (args.ancestors) for (let a = r.parentElement; a; a = a.parentElement) targets.add(a);
  }
  const props = Array.from(getComputedStyle(document.documentElement)).filter((p) => !p.startsWith('--'));
  const out: Record<string, string[]> = {};
  for (const el of targets) {
    const path = pathOf(el);
    const cs = getComputedStyle(el);
    out[path] = [
      el.matches(':focus-visible') ? 'focus-visible' : '',
      el.matches(':hover') ? 'hover' : '',
      ...props.map((p) => cs.getPropertyValue(p)),
    ];
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content === 'none' || ps.content === 'normal') continue;
      out[path + pseudo] = ['', '', ...props.map((p) => ps.getPropertyValue(p))];
    }
  }
  return { props: ['(:focus-visible)', '(:hover)', ...props], out };
}

class Recorder {
  snapshot: Snapshot = { props: [], rows: [], states: {} };
  private rowIndex = new Map<string, number>();

  add(state: string, result: { props: string[]; out: Record<string, string[]> }) {
    if (!this.snapshot.props.length) this.snapshot.props = result.props;
    else if (this.snapshot.props.join() !== result.props.join()) throw new Error('property list changed mid-run');
    const record = (this.snapshot.states[state] ??= {});
    for (const [path, values] of Object.entries(result.out)) {
      const key = values.join('\u0000');
      let i = this.rowIndex.get(key);
      if (i === undefined) {
        i = this.snapshot.rows.push(values) - 1;
        this.rowIndex.set(key, i);
      }
      record[path] = i;
    }
  }
}

/** The selectors in the page's sheets that name a `:hover` target, each cut at `:hover`. */
async function hoverTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found = new Set<string>();
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          for (const sel of rule.selectorText.split(',')) {
            const at = sel.indexOf(':hover');
            if (at > 0) found.add(sel.slice(0, at).trim());
          }
        } else if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules);
    return [...found].sort();
  });
}

async function record(page: Page, state: string, rec: Recorder) {
  rec.add(state, await page.evaluate(collect, { root: null, ancestors: false }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  rec.add(`${state} (reduced motion)`, await page.evaluate(collect, { root: null, ancestors: false }));
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Keyboard focus: one Tab puts Chromium in keyboard modality, so each
  // scripted `focus()` after it matches `:focus-visible`.
  await page.keyboard.press('Tab');
  const focusable = await page.evaluate(() => {
    const sel = 'a[href], button, input, select, textarea, summary, [tabindex]';
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      if ((el as HTMLElement).closest('[inert]')) continue;
      el.setAttribute('data-style-snapshot', `f${n++}`);
    }
    return n;
  });
  for (let i = 0; i < focusable; i++) {
    const ok = await page.evaluate((id) => {
      const el = document.querySelector(`[data-style-snapshot="${id}"]`) as HTMLElement;
      el.focus({ preventScroll: true });
      return document.activeElement === el;
    }, `f${i}`);
    if (!ok) continue;
    rec.add(`${state} focus f${i}`, await page.evaluate(collect, { root: `f${i}`, ancestors: true }));
  }
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());

  // Each element once, however many selectors name it, and at most
  // `HOVER_PER_SELECTOR` per selector: the rest of a list of chips or rows
  // repeats the first ones.
  const hoverable = await page.evaluate(
    ({ sels, cap }) => {
      let n = 0;
      for (const sel of sels) {
        let taken = 0;
        for (const el of document.querySelectorAll(sel)) {
          if (taken >= cap) break;
          if (el.hasAttribute('data-style-snapshot-hover')) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          el.setAttribute('data-style-snapshot-hover', `h${n++}`);
          taken++;
        }
      }
      return n;
    },
    { sels: await hoverTargets(page), cap: HOVER_PER_SELECTOR }
  );
  for (let i = 0; i < hoverable; i++) {
    const h = page.locator(`[data-style-snapshot-hover="h${i}"]`);
    await h.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const box = await h.boundingBox();
    if (!box) continue;
    const vp = page.viewportSize();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (x < 0 || y < 0 || x >= vp.width || y >= vp.height) continue;
    await h.evaluate((el, id) => el.setAttribute('data-style-snapshot', id), `h${i}`);
    const label = await h.evaluate((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
    await page.mouse.move(x, y);
    rec.add(`${state} hover h${i} ${label}`, await page.evaluate(collect, { root: `h${i}`, ancestors: true }));
  }
  await page.mouse.move(0, 0);
}

async function snapshot(outPath: string) {
  const scratch = await mkdtemp(join(tmpdir(), 'babel-style-snapshot-'));
  const images = join(scratch, 'corpus');
  await cp(join(repoRoot, 'assets/corpus-sample'), images, { recursive: true });
  const metaPath = join(images, 'metadata.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  const last = Object.keys(meta).sort().at(-1);
  meta[last].sensitive_content_tags = ['snapshot-test'];
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(
    process.execPath,
    [
      '--import', './build/register.mjs', 'packages/server/index.ts',
      '--port', String(port), '--images', images,
      '--shared-dir', join(repoRoot, 'assets'),
      '--favorites', join(scratch, 'favorites.json'),
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  let browser: Browser;
  try {
    await waitFor(
      async () => (await fetch(`${origin}/api/manifest`).catch(() => null))?.ok,
      90_000,
      () => `the demo server never came up:\n${log}`
    );
    browser = await chromium.launch({ executablePath: process.env.BABEL_E2E_CHROMIUM || undefined });
    const rec = new Recorder();
    for (const state of STATES) {
      const context = await browser.newContext({
        viewport: state.viewport,
        javaScriptEnabled: state.javaScript ?? true,
      });
      const page = await context.newPage();
      await state.setup(page, origin);
      await record(page, state.name, rec);
      await context.close();
      console.log(`${state.name}: ${Object.keys(rec.snapshot.states).filter((s) => s.startsWith(state.name)).length} records`);
    }
    await writeFile(outPath, JSON.stringify(rec.snapshot));
  } finally {
    await browser?.close();
    server.kill();
    await rm(scratch, { recursive: true, force: true });
  }
}

async function diff(aPath: string, bPath: string) {
  const a: Snapshot = JSON.parse(await readFile(aPath, 'utf8'));
  const b: Snapshot = JSON.parse(await readFile(bPath, 'utf8'));
  const lines: string[] = [];
  const bProp = new Map(b.props.map((p, i) => [p, i]));
  for (const p of a.props) if (!bProp.has(p)) lines.push(`property ${p} only in ${aPath}`);
  for (const p of b.props) if (!a.props.includes(p)) lines.push(`property ${p} only in ${bPath}`);
  const states = new Set([...Object.keys(a.states), ...Object.keys(b.states)]);
  for (const state of states) {
    const sa = a.states[state];
    const sb = b.states[state];
    if (!sa || !sb) {
      lines.push(`state "${state}" only in ${sa ? aPath : bPath}`);
      continue;
    }
    for (const path of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      if (!(path in sa) || !(path in sb)) {
        lines.push(`${state}: ${path} only in ${path in sa ? aPath : bPath}`);
        continue;
      }
      const ra = a.rows[sa[path]];
      const rb = b.rows[sb[path]];
      a.props.forEach((p, i) => {
        const j = bProp.get(p);
        if (j !== undefined && ra[i] !== rb[j]) lines.push(`${state}: ${path} ${p}: ${ra[i]} -> ${rb[j]}`);
      });
    }
  }
  for (const line of lines.slice(0, 400)) console.log(line);
  if (lines.length > 400) console.log(`... and ${lines.length - 400} more`);
  console.log(lines.length ? `${lines.length} differences` : 'no differences');
  process.exitCode = lines.length ? 1 : 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'snapshot' && rest.length === 1) await snapshot(rest[0]);
else if (cmd === 'diff' && rest.length === 2) await diff(rest[0], rest[1]);
else {
  console.error('usage: index.ts snapshot <out.json> | diff <a.json> <b.json>');
  process.exitCode = 2;
}
