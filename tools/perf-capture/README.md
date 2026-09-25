# Chrome perf capture

An automated Chrome counterpart to the Firefox `?debug`/`__babelDebug`
console workflow (`packages/web/src/lib/debugActions.ts`). It boots the
server, launches Chromium, runs the same seeded action sequence, and records
memory/perf metrics over the DevTools Protocol for the whole run.

## Run

```sh
npm run profile:chrome                                    # WebGL, default seed, 1 minute
npm run profile:chrome -- --renderer canvas2d             # Canvas2D renderer instead
npm run profile:chrome -- --seed my-seed --duration 120000 # a longer, differently-seeded run
npm run profile:chrome -- --server http://localhost:5173   # profile a server you already started
```

`--server` points this at a demo server you launched yourself, e.g. one
serving a real dataset (`npm run demo -- --images /path/to/your/corpus`).
With `--server` this tool spawns nothing and kills nothing; without it, it
boots and tears down its own server against `--images` (default
`assets/corpus-sample`).

Output lands in `out/<renderer>-<seed>-<timestamp>/`:

- `summary.json` - JS heap start/end/peak, DOM node and listener deltas, one
  line per number so two runs are easy to diff by eye.
- `samples.json` - the full `Performance.getMetrics()` time series, sampled
  every `--sample-interval` (default 1s) for the whole run.
- `final.png` - a screenshot at the moment the sequence finished.
- `console-errors.json` - only written if the page logged an error.
- `trace.json` - only with `--trace`; a full Chrome trace (`{traceEvents}`)
  loadable via `chrome://tracing`'s "Load" button or DevTools Performance
  panel's "Load profile". Includes `performance.mark` calls from
  `debugActions.ts` (the `blink.user_timing` category), so each scripted step
  shows up as a labelled boundary in the timeline.
  Off by default because a full trace grows large over a long run: turn it
  on for a short, targeted run once `summary.json`/`samples.json` point at
  something worth a flame chart.

### Flags

| flag | default | effect |
| --- | --- | --- |
| `--seed <string>` | `babel-perf` | same seed -> same scripted sequence, see `debugActions.ts` |
| `--duration <ms>` | `60000` | how long the scripted session runs |
| `--renderer <canvas2d\|webgl>` | `webgl` | which map renderer to profile - adds `&webgl=1` or `&webgl=0` to the page URL |
| `--images <dir>` | `assets/corpus-sample` | corpus the demo server serves - ignored if `--server` is given |
| `--server <url>` | (none) | profile an already-running demo server instead of spawning one |
| `--sample-interval <ms>` | `1000` | how often `Performance.getMetrics` is sampled |
| `--headed` | off | run with a visible window instead of headless |
| `--trace` | off | also capture a full Chrome trace - see above |
| `--out <dir>` | `tools/perf-capture/out` | where runs are written |

## Reading the numbers

`Performance.getMetrics` (Chrome DevTools Protocol) is the same metric set
DevTools' own Performance panel and tools like Lighthouse read from:

- `JSHeapUsedSize`/`JSHeapTotalSize` - bytes. A `heapUsedEndBytes` well above
  `heapUsedStartBytes` after GC has had a chance to run (the sampling interval
  gives it several) suggests a genuine leak, not just live working-set size.
- `Nodes` - live DOM node count. This map is virtualized canvas (see
  `docs/agents/map.md`'s "The map is virtualized canvas" note), so a large or
  growing number here across a run that never leaves map mode points at
  something mounting where it shouldn't.
- `JSEventListeners` - a count that keeps climbing across `enterCatalog`/
  `exitCatalog` cycles is the classic "listener added on mount, never removed"
  shape.

## Firefox

Firefox has no equivalent tool: Playwright's Firefox build exposes no heap
snapshots or scriptable perf counters. Profile it by hand with the same
seeded session: open the tab with `?debug`, start the Firefox Profiler or
`about:memory`, then run `__babelDebug.run('seed')` in the console.
`debugActions.ts`'s header comment covers that workflow.
