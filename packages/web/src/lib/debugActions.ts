/**
 * A seeded, repeatable "aggressive random usage" session for perf/memory
 * profiling - pan, zoom, search, favorite, catalog, shelf, reorder, sort,
 * distill and the overlays, all in one scripted run so two sessions on the
 * same seed are directly comparable. `buildSequence` is pure (no DOM, no app
 * state) so it is unit-testable; `runSequence` dispatches each step against
 * a live `DebugActions` object supplied by `main.tsx`'s `?debug` wiring,
 * which is the only place that knows the current camera/layout/room count.
 *
 * Steps carry only primitives (deltas, factors, ids, terms) rather than
 * resolved coordinates - a room's cell or the map's extent can change
 * mid-session (a reorder, a rescatter), so anything state-dependent is
 * resolved by the executor at call time, not baked in at generation time.
 */
import { prng, seedFrom } from '../../../map/prng.ts';
import { BOOK_COUNT } from './center.ts';

export type SortMode = 'relevance' | 'mine' | 'count';

export type DebugActionName =
  | 'pan'
  | 'zoom'
  | 'search'
  | 'clearSearch'
  | 'favorite'
  | 'enterCatalog'
  | 'exitCatalog'
  | 'book'
  | 'reorder'
  | 'rescatter'
  | 'sort'
  | 'distill'
  | 'recentre'
  | 'openCard'
  | 'closeCard'
  | 'goToSearch';

export interface DebugStep {
  action: DebugActionName;
  /** Meaning depends on `action` - see the switch in `runSequence`. */
  args: Record<string, number | string>;
  /** How long to wait after this step before the next one runs. */
  delayMs: number;
}

/** How often each action is picked - weights, not percentages. */
const WEIGHTS: Record<DebugActionName, number> = {
  pan: 30,
  zoom: 20,
  search: 10,
  clearSearch: 3,
  favorite: 8,
  enterCatalog: 4,
  exitCatalog: 4,
  book: 8,
  reorder: 3,
  rescatter: 3,
  sort: 5,
  distill: 4,
  recentre: 4,
  openCard: 6,
  closeCard: 5,
  goToSearch: 3,
};

const ACTION_TABLE = Object.entries(WEIGHTS) as [DebugActionName, number][];
const TOTAL_WEIGHT = ACTION_TABLE.reduce((sum, [, w]) => sum + w, 0);

/**
 * Actions that need the map canvas on screen - meaningless, or actively
 * confusing to profile, while the catalog is showing instead. Checked at
 * dispatch time in `runSequence`, not here at generation time: the sequence
 * is built once up front, but which steps land in catalog mode depends on
 * where the `enterCatalog`/`exitCatalog` steps earlier in the same run fall.
 */
const MAP_ONLY_ACTIONS: ReadonlySet<DebugActionName> = new Set([
  'pan', 'zoom', 'book', 'recentre', 'goToSearch', 'openCard',
]);

/** One minute of rapid-fire actions is enough to surface a leak or a jank
 * regression - long enough to matter, short enough that the browser's own
 * profiler doesn't buckle under the recording before you get to look at it. */
export const DEFAULT_DURATION_MS = 60 * 1000;

/** A mix of real words and nonsense, so both a match and a no-match path run. */
const SEARCH_TERMS = [
  'library', 'shelf', 'light', 'dust', 'stone', 'quiet corridor', 'brass lamp',
  'forgotten', 'spiral stair', 'red curtain', 'glass', 'ink', 'moth', 'xzqvp',
  'qqrrzz', 'a', 'the book that never was', 'lantern', 'velvet',
];

const MIN_DELAY_MS = 150;
const MAX_DELAY_MS = 900;

function pickAction(rand: ReturnType<typeof prng>): DebugActionName {
  let roll = rand.range(0, TOTAL_WEIGHT);
  for (const [action, weight] of ACTION_TABLE) {
    roll -= weight;
    if (roll <= 0) return action;
  }
  return ACTION_TABLE[ACTION_TABLE.length - 1][0];
}

function buildArgs(
  action: DebugActionName,
  rand: ReturnType<typeof prng>,
  roomCount: number
): Record<string, number | string> {
  switch (action) {
    case 'pan':
      return { dx: rand.int(-10, 10), dy: rand.int(-10, 10) };
    case 'zoom':
      return { factor: rand.range(0.4, 2.2) };
    case 'search':
      return { term: rand.pick(SEARCH_TERMS) };
    case 'favorite':
    case 'openCard':
      return { id: rand.int(0, Math.max(0, roomCount - 1)) };
    case 'book':
      return { index: rand.int(0, Math.max(0, BOOK_COUNT - 1)) };
    case 'sort':
      return { mode: rand.pick<SortMode>(['relevance', 'mine', 'count']) };
    default:
      return {};
  }
}

/**
 * Build a deterministic sequence of steps covering roughly `durationMs` of
 * scripted delays. Same seed and duration always produce the same sequence -
 * the wall-clock time an actual run takes will vary slightly (network, real
 * animation settling), but the actions requested and their requested spacing
 * do not.
 */
export function buildSequence(seed: number | string, durationMs: number, roomCount: number): DebugStep[] {
  const rand = prng(typeof seed === 'string' ? seedFrom(seed) : seed);
  const steps: DebugStep[] = [];
  let elapsed = 0;
  while (elapsed < durationMs) {
    const action = pickAction(rand);
    const delayMs = rand.int(MIN_DELAY_MS, MAX_DELAY_MS);
    steps.push({ action, args: buildArgs(action, rand, roomCount), delayMs });
    elapsed += delayMs;
  }
  return steps;
}

/** The live callbacks a scripted step is dispatched against - see `main.tsx`. */
export interface DebugActions {
  pan(dx: number, dy: number): unknown;
  zoom(factor: number): unknown;
  search(term: string): unknown;
  favorite(id: number): unknown;
  enterCatalog(): unknown;
  exitCatalog(): unknown;
  book(index: number): unknown;
  reorder(): unknown;
  rescatter(): unknown;
  sort(mode: SortMode): unknown;
  distill(): unknown;
  recentre(): unknown;
  openCard(id: number): unknown;
  closeCard(): unknown;
  goToSearch(): unknown;
}

function dispatch(actions: DebugActions, step: DebugStep): unknown {
  switch (step.action) {
    case 'pan':
      return actions.pan(step.args.dx as number, step.args.dy as number);
    case 'zoom':
      return actions.zoom(step.args.factor as number);
    case 'search':
      return actions.search(step.args.term as string);
    case 'clearSearch':
      return actions.search('');
    case 'favorite':
      return actions.favorite(step.args.id as number);
    case 'enterCatalog':
      return actions.enterCatalog();
    case 'exitCatalog':
      return actions.exitCatalog();
    case 'book':
      return actions.book(step.args.index as number);
    case 'reorder':
      return actions.reorder();
    case 'rescatter':
      return actions.rescatter();
    case 'sort':
      return actions.sort(step.args.mode as SortMode);
    case 'distill':
      return actions.distill();
    case 'recentre':
      return actions.recentre();
    case 'openCard':
      return actions.openCard(step.args.id as number);
    case 'closeCard':
      return actions.closeCard();
    case 'goToSearch':
      return actions.goToSearch();
  }
}

const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run a built sequence against live actions, in real time. Marks each step
 * with `performance.mark` so a Firefox Profiler or Chrome Performance
 * capture running alongside shows labelled sections instead of an
 * undifferentiated trace.
 *
 * `opts.mode`, if given, is read before every step - a map-only step
 * (`MAP_ONLY_ACTIONS`) is skipped rather than dispatched while it reports
 * anything other than `'map'`. The scripted delay still runs either way, so
 * a run's total wall-clock length doesn't depend on how much of it landed in
 * catalog mode.
 */
export async function runSequence(
  actions: DebugActions,
  steps: DebugStep[],
  opts?: {
    wait?: (ms: number) => Promise<void>;
    mode?: () => 'map' | 'catalog';
    onStep?: (step: DebugStep, index: number, skipped: boolean) => void;
  }
): Promise<void> {
  const wait = opts?.wait ?? realWait;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const skipped = MAP_ONLY_ACTIONS.has(step.action) && opts?.mode?.() === 'catalog';
    opts?.onStep?.(step, i, skipped);
    performance.mark(`babel-debug:${i}:${step.action}${skipped ? ':skipped' : ''}`);
    if (!skipped) await dispatch(actions, step);
    await wait(step.delayMs);
  }
}
