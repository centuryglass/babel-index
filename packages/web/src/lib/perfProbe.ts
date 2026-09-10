/**
 * Rearrangement performance instrumentation - docs/performance-research.md §2,
 * "measure first". Off by default; `?perf` in the url turns it on, the same
 * gating `debug.ts`'s `DEBUG` uses (read once at module scope so a normal
 * session has nothing to check per call beyond one boolean).
 *
 * This is a side channel to the console, not part of the render path: every
 * recorder is a no-op push behind the `PERF` check, and `perfDump()` (called
 * once a rearrangement settles - see `useRearrangement.ts`) is the only place
 * that reduces the raw samples, so nothing here costs anything on a frame
 * that isn't being measured.
 */

export const PERF =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf');

/**
 * §2.6: force the canvas backing store to `dpr = 1` regardless of the
 * display's real ratio, so a run with `?perf&perfDpr1` can be compared
 * against an ordinary run to see whether fill rate is the bottleneck. Only
 * meaningful alongside `?perf` - checked independently in `useMapRenderer.ts`
 * so it isn't silently ignored if someone passes it alone, but there is
 * nothing to compare against without `PERF`'s reports.
 */
export const PERF_FORCE_DPR1 =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('perfDpr1');

/**
 * §2.1: which rearrangement phase a sample belongs to. `'preparing'` is the
 * plan-and-fetch phase before the camera moves at all - see
 * `useRearrangement.ts`'s `prepareRearrangement`.
 */
export type Phase = 'preparing' | 'flight' | 'slide';

interface FrameSample {
  phase: Phase;
  ms: number;
}

interface SheetSample {
  url: string;
  level: number;
  /** §2.3: wall-clock gap between `img.src = url` and `onload`. */
  fetchMs: number;
  /** §2.3: gap between `onload` and the first frame that actually drew from it. */
  toFirstDrawMs: number | null;
}

interface LongtaskSample {
  phase: Phase | 'idle';
  startTime: number;
  duration: number;
  attribution: string;
}

/** §9.11: how long one `prepareRearrangement` call took, and what it waited for. */
interface PrepareSample {
  ms: number;
  requested: number;
  timedOut: number;
}

/**
 * A frame's worth of main-thread budget, ms - the same 50ms the Long Tasks
 * spec itself uses, so the rAF-gap fallback below reports on the same scale
 * as `longtask` and the two can be compared on a browser that has both.
 */
const LONG_FRAME_THRESHOLD_MS = 50;

let currentPhase: Phase | 'idle' = 'idle';
const frames: FrameSample[] = [];
const sheetsInFlight = new Map<string, { level: number; t0: number; loaded: number | null }>();
const sheetSamples: SheetSample[] = [];
const longtasks: LongtaskSample[] = [];
const longFrames: LongtaskSample[] = [];
const prepareSamples: PrepareSample[] = [];
let observer: PerformanceObserver | null = null;
let frameGapLoopStarted = false;

/** §2.2: a `longtask` entry has no script attribution when it comes from decode/upload or GC rather than our own JS. */
function attributionOf(entry: PerformanceEntry): string {
  const scripts = (entry as unknown as { scripts?: { name?: string; sourceURL?: string }[] }).scripts;
  if (!scripts?.length) return 'unattributed';
  const names = scripts.map((s) => s.name || s.sourceURL).filter(Boolean);
  return names.length ? names.join(',') : 'unattributed';
}

function ensureObserver(): void {
  if (!PERF || observer || typeof PerformanceObserver === 'undefined') return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        longtasks.push({
          phase: currentPhase, startTime: entry.startTime, duration: entry.duration,
          attribution: attributionOf(entry),
        });
    });
    // No `buffered: true`, deliberately: it would backfill entries the
    // browser recorded before this observer existed - and since it's created
    // lazily on the first `perfSetPhase` call (typically well into the
    // session, at the first rearrangement), a backfilled entry from ordinary
    // page bootstrap would get tagged with whatever phase is active at
    // delivery time (almost always 'flight', being the first call) rather
    // than the 'idle' it actually happened during. Caught via a suspiciously
    // early `startTime` on an otherwise-unremarkable entry during testing -
    // live-only entries are always correctly phase-tagged, so that is the
    // trade worth taking.
    //
    // Not every browser implements `longtask` - Safari notably doesn't. The
    // `catch` below is what makes that "no observer", not a startup crash.
    observer.observe({ type: 'longtask' });
  } catch {
    // longtask unsupported - §2.2 simply reports nothing.
  }
}

/**
 * Firefox and Safari report zero `longtask` entries, ever - not because
 * nothing stalls, but because neither has implemented the API (Firefox:
 * https://bugzilla.mozilla.org/show_bug.cgi?id=1348405 - blocked on
 * attributing tasks to a document, which its scheduler doesn't currently do).
 * This is the standard fallback predating Long Tasks and still used for
 * exactly the browsers that lack it: the wall-clock gap between consecutive
 * `requestAnimationFrame` callbacks. A task that blocks the main thread for
 * over `LONG_FRAME_THRESHOLD_MS` necessarily delays whenever the next rAF
 * fires by roughly that much, whatever caused it - so the gap is a faithful
 * proxy for "a long task happened here," with the same two limitations as
 * the native API turned out to have for this app anyway: no attribution, and
 * (per `perfSetPhase`'s own doc) the phase read at report time can lag the
 * phase during which the stall actually happened.
 *
 * Runs continuously once started - not gated to a rearrangement - so it also
 * catches stalls during 'idle' periods the native observer would too. The
 * whole loop is gated behind `PERF` (never started otherwise), so an ordinary
 * session pays nothing for it.
 */
function ensureFrameGapLoop(): void {
  if (!PERF || frameGapLoopStarted || typeof requestAnimationFrame === 'undefined') return;
  frameGapLoopStarted = true;
  let last = performance.now();
  const tick = (now: number) => {
    const gap = now - last;
    if (gap > LONG_FRAME_THRESHOLD_MS)
      longFrames.push({ phase: currentPhase, startTime: last, duration: gap, attribution: 'rAF gap' });
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Which phase is running right now, for tagging frame samples and longtasks alike. */
export function perfSetPhase(phase: Phase | 'idle'): void {
  if (!PERF) return;
  currentPhase = phase;
  ensureObserver();
  ensureFrameGapLoop();
}

/** §2.1: one draw call's wall time, tagged with the phase it ran in. */
export function perfRecordFrame(phase: Phase, ms: number): void {
  if (!PERF) return;
  frames.push({ phase, ms });
}

/** §2.3: a sheet fetch just started (`requestSheet` minting a fresh entry in `tiles.ts`). */
export function perfRecordSheetStart(url: string, level: number): void {
  if (!PERF) return;
  sheetsInFlight.set(url, { level, t0: performance.now(), loaded: null });
}

/** §2.3: the sheet's `onload` fired. */
export function perfRecordSheetLoaded(url: string): void {
  if (!PERF) return;
  const s = sheetsInFlight.get(url);
  if (s) s.loaded = performance.now();
}

/**
 * §2.3: the first frame that actually drew from this sheet. One sample per
 * sheet is the point - once cached, later draws say nothing new about the
 * fetch/decode/upload path, so the entry is retired here rather than kept
 * around to be overwritten every frame the sheet stays on screen.
 */
export function perfRecordSheetFirstDraw(url: string): void {
  if (!PERF) return;
  const s = sheetsInFlight.get(url);
  if (!s || s.loaded == null) return;
  sheetSamples.push({ url, level: s.level, fetchMs: s.loaded - s.t0, toFirstDrawMs: performance.now() - s.loaded });
  sheetsInFlight.delete(url);
}

/**
 * §9.11: `prepareRearrangement`'s own wall-clock cost - the plan/build/sim
 * work plus however long it waited on `cache.isReady` for the tiles it
 * fetched, up to `config.slide.prepareTimeoutMs`. This is the number the
 * "prepare fully before animating" tradeoff lives or dies on: a large value
 * here is the delay a reader sees before the zoom-out even starts, traded
 * against the mid-animation stalls §9.10 exists to remove.
 */
export function perfRecordPrepare(ms: number, requested: number, timedOut: number): void {
  if (!PERF) return;
  prepareSamples.push({ ms, requested, timedOut });
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Dump every ring buffer to the console as percentiles, then clear them for the next run. */
export function perfDump(): void {
  if (!PERF) return;
  const byPhase = (phase: Phase) => frames.filter((f) => f.phase === phase).map((f) => f.ms);
  const report = (label: string, values: number[]) => {
    if (!values.length) {
      console.info(`[perf] ${label}: no samples`);
      return;
    }
    console.info(
      `[perf] ${label}: n=${values.length} p50=${percentile(values, 50).toFixed(2)}ms ` +
      `p90=${percentile(values, 90).toFixed(2)}ms p99=${percentile(values, 99).toFixed(2)}ms ` +
      `max=${Math.max(...values).toFixed(2)}ms`
    );
  };

  console.group('[perf] rearrangement report');
  if (prepareSamples.length) {
    for (const p of prepareSamples)
      console.info(
        `[perf] prepare: ${p.ms.toFixed(1)}ms (${p.requested} tiles requested, ` +
        `${p.timedOut} not ready when it gave up)`
      );
  } else {
    console.info('[perf] prepare: no samples');
  }
  report('flight frame', byPhase('flight'));
  report('slide frame', byPhase('slide'));

  if (sheetSamples.length) {
    console.info(`[perf] sheets drawn: ${sheetSamples.length}`);
    for (const s of sheetSamples)
      console.info(
        `  level ${s.level} ${s.url}: fetch+decode ${s.fetchMs.toFixed(1)}ms, ` +
        `to first draw ${s.toFirstDrawMs?.toFixed(1)}ms`
      );
  } else {
    console.info('[perf] sheets drawn: none (desktop rearrangements may never leave level 0/1 - see §3.1)');
  }

  if (longtasks.length) {
    console.info(`[perf] longtasks (native): ${longtasks.length}`);
    for (const t of longtasks)
      console.info(`  [${t.phase}] ${t.duration.toFixed(1)}ms at ${t.startTime.toFixed(1)} (${t.attribution})`);
  } else {
    console.info('[perf] longtasks (native): none - unsupported on this browser, or truly none');
  }

  // The rAF-gap fallback (see `ensureFrameGapLoop`'s doc) - the only signal
  // at all on Firefox/Safari, and a cross-check against the native list
  // above wherever both exist.
  if (longFrames.length) {
    console.info(`[perf] long frames (rAF gap): ${longFrames.length}`);
    for (const t of longFrames)
      console.info(`  [${t.phase}] ${t.duration.toFixed(1)}ms at ${t.startTime.toFixed(1)}`);
  } else {
    console.info('[perf] long frames (rAF gap): none');
  }
  console.groupEnd();

  frames.length = 0;
  sheetSamples.length = 0;
  longtasks.length = 0;
  longFrames.length = 0;
  prepareSamples.length = 0;
}
