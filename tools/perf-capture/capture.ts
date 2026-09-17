/**
 * Fully automated Chrome perf capture: boot the demo server, launch
 * Chromium, run a seeded `debugActions.ts` session against it, and sample
 * memory/perf metrics over the DevTools Protocol the whole time; `--trace`
 * records a full Chrome trace alongside, loadable in DevTools.
 *
 * The Firefox counterpart of this workflow stays a manual console session;
 * README.md explains why the two browsers' tooling diverged, and carries
 * the full flag list and how to read the output.
 *
 *   node --import ./build/register.mjs tools/perf-capture/capture.ts
 *   node --import ./build/register.mjs tools/perf-capture/capture.ts --renderer webgl --seed my-seed
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

const BOOT_TIMEOUT_MS = 90_000;

/** Puppeteer's default trace category set - the categories DevTools'
 * Performance panel reads. `blink.user_timing` is the entry that carries
 * `debugActions.ts`'s `performance.mark` calls into the trace as labelled
 * step boundaries. */
const DEFAULT_TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'v8.execute',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'toplevel',
  'blink.console',
  'blink.user_timing',
  'latencyInfo',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.hires',
].join(',');

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      const port = address && typeof address !== 'string' ? address.port : Number(address);
      s.close(() => res(port));
    });
  });
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string | (() => string)
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(typeof message === 'function' ? message() : message);
}

function slug(text: string): string {
  return text.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'run';
}

interface MetricSample {
  atMs: number;
  metrics: Record<string, number>;
}

function metricsToObject(metrics: { name: string; value: number }[]): Record<string, number> {
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: 'string', default: 'babel-perf' },
      duration: { type: 'string', default: '60000' },
      renderer: { type: 'string', default: 'canvas2d' },
      images: { type: 'string', default: 'assets/corpus-sample' },
      server: { type: 'string' },
      out: { type: 'string', default: join(HERE, 'out') },
      'sample-interval': { type: 'string', default: '1000' },
      headed: { type: 'boolean', default: false },
      trace: { type: 'boolean', default: false },
    },
  });

  const seed = values.seed as string;
  const durationMs = Number(values.duration);
  const renderer = values.renderer as string;
  if (renderer !== 'canvas2d' && renderer !== 'webgl') {
    throw new Error(`--renderer must be "canvas2d" or "webgl", got "${renderer}"`);
  }
  const sampleIntervalMs = Number(values['sample-interval']);
  const outRoot = resolve(values.out as string);
  const runDir = join(outRoot, `${renderer}-${slug(seed)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(runDir, { recursive: true });

  // With `--server`, the capture runs against a demo server this process
  // neither spawned nor may kill: `server` stays null and the teardown in
  // the finally is inert. README.md documents the flag.
  const externalOrigin = values.server ? (values.server as string).replace(/\/+$/, '') : null;
  let origin = externalOrigin;
  let server: ReturnType<typeof spawn> | null = null;
  let serverLog = '';
  if (!externalOrigin) {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      ['--import', './build/register.mjs', 'packages/server/index.ts', '--port', String(port), '--images', values.images as string],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));
  }

  let browser;
  try {
    await waitFor(
      async () => (await fetch(`${origin}/api/manifest`).catch(() => null))?.ok ?? false,
      BOOT_TIMEOUT_MS,
      () =>
        externalOrigin
          ? `no demo server answered ${origin}/api/manifest - is --server pointed at a running one?`
          : `the demo server never came up:\n${serverLog}`
    );

    browser = await chromium.launch({ headless: !values.headed });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    const query = renderer === 'webgl' ? 'debug&webgl' : 'debug';
    await page.goto(`${origin}?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => /[1-9]\d* drawn/.test(document.getElementById('hud')?.textContent ?? ''),
      null,
      { timeout: 30_000 }
    );
    const hasDebugHook = await page.evaluate(() => typeof (window as unknown as { __babelDebug?: unknown }).__babelDebug !== 'undefined');
    if (!hasDebugHook) throw new Error('window.__babelDebug is not present - is ?debug actually wired up in this build?');

    const client = await context.newCDPSession(page);
    await client.send('Performance.enable');

    if (values.trace) {
      await client.send('Tracing.start', {
        categories: DEFAULT_TRACE_CATEGORIES,
        transferMode: 'ReportEvents',
      } as never);
    }
    const traceEvents: unknown[] = [];
    if (values.trace) {
      client.on('Tracing.dataCollected', (event) => {
        traceEvents.push(...(event as { value: unknown[] }).value);
      });
    }

    const samples: MetricSample[] = [];
    const startedAt = Date.now();
    const sample = async () => {
      const { metrics } = (await client.send('Performance.getMetrics')) as {
        metrics: { name: string; value: number }[];
      };
      samples.push({ atMs: Date.now() - startedAt, metrics: metricsToObject(metrics) });
    };
    await sample();
    const timer = setInterval(() => void sample(), sampleIntervalMs);

    console.log(`[perf-capture] running ${durationMs}ms as "${seed}" against the ${renderer} renderer...`);
    await page.evaluate(
      ({ seed, durationMs }) =>
        (window as unknown as { __babelDebug: { run(seed: string, durationMs: number): Promise<void> } }).__babelDebug.run(
          seed,
          durationMs
        ),
      { seed, durationMs }
    );

    clearInterval(timer);
    await sample();

    let tracePath: string | null = null;
    if (values.trace) {
      await client.send('Tracing.end');
      await new Promise<void>((resolveComplete) => client.once('Tracing.tracingComplete', () => resolveComplete()));
      tracePath = join(runDir, 'trace.json');
      await writeFile(tracePath, JSON.stringify({ traceEvents }));
    }

    await page.screenshot({ path: join(runDir, 'final.png') }).catch(() => {});

    const first = samples[0].metrics;
    const last = samples[samples.length - 1].metrics;
    const summary = {
      seed,
      renderer,
      durationMs,
      sampleCount: samples.length,
      consoleErrorCount: consoleErrors.length,
      heapUsedStartBytes: first.JSHeapUsedSize,
      heapUsedEndBytes: last.JSHeapUsedSize,
      heapUsedDeltaBytes: last.JSHeapUsedSize - first.JSHeapUsedSize,
      heapUsedPeakBytes: Math.max(...samples.map((s) => s.metrics.JSHeapUsedSize)),
      domNodesStart: first.Nodes,
      domNodesEnd: last.Nodes,
      domNodesDelta: last.Nodes - first.Nodes,
      listenersStart: first.JSEventListeners,
      listenersEnd: last.JSEventListeners,
      listenersDelta: last.JSEventListeners - first.JSEventListeners,
      trace: tracePath,
    };

    await writeFile(join(runDir, 'samples.json'), JSON.stringify(samples, null, 2));
    await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    if (consoleErrors.length) await writeFile(join(runDir, 'console-errors.json'), JSON.stringify(consoleErrors, null, 2));

    console.log(`[perf-capture] wrote ${runDir}`);
    console.log(
      `[perf-capture] JS heap: ${(summary.heapUsedStartBytes / 1e6).toFixed(1)}MB -> ${(summary.heapUsedEndBytes / 1e6).toFixed(1)}MB ` +
        `(peak ${(summary.heapUsedPeakBytes / 1e6).toFixed(1)}MB), DOM nodes ${summary.domNodesStart} -> ${summary.domNodesEnd}, ` +
        `listeners ${summary.listenersStart} -> ${summary.listenersEnd}`
    );
    if (consoleErrors.length) console.log(`[perf-capture] ${consoleErrors.length} console error(s) - see console-errors.json`);
  } finally {
    await browser?.close().catch(() => {});
    server?.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
