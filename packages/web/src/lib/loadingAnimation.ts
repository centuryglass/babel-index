/**
 * The center-tile loading indicator: a short frame cycle played over the
 * illustrated page of the center room's artist-statement book while a
 * rearrangement preloads (`useRearrangement.ts`). The preload can take up to a
 * couple of seconds now that the whole slide is fetched before the flight, so
 * this is what keeps that pause from reading as a freeze.
 *
 * Three responsibilities live here:
 *
 *  - `loadLoadingAnimation` fetches the manifest `tools/center-animation` wrote
 *    (served at `<sharedBase>/animation/manifest.json`) and decodes each cycle's
 *    sprite sheet. A missing manifest is "no indicator deployed", returned as
 *    null the same way a missing favorite store is - not an error.
 *  - The playback state machine (`advancePlayback`/`frameIndexAt`, pure and
 *    unit-tested) decides which cycle and which frame is showing at a given
 *    time, cycles back-to-back while active, and stops only on a cycle boundary
 *    once at least one full cycle has played - so a rearrangement never cuts a
 *    cycle off mid-motion and always shows at least one.
 *  - `createLoadingAnimation` wraps that in a controller the renderer reads
 *    (`frame()`) and the rearrangement drives (`play`/`finish`/`cancel`), plus a
 *    standalone debug preview loop (`startDebug`/`stopDebug`) that walks the
 *    cycles in order forever - the dev panel's checkbox.
 *
 * The controller owns its own `requestAnimationFrame` loop while active, because
 * the map's render loop is on-demand (`useMapRenderer.ts`'s `draw.current`) and
 * would otherwise not repaint during the preload wait at all. Each tick calls
 * the `requestDraw` it was handed, and the renderer pulls the current frame back
 * out through `frame()`.
 *
 * The crop rectangle is in cell fractions (see `tools/center-animation/lib.ts`),
 * so the renderer places it on the stretched center cell without re-measuring -
 * `x`/`w` against the cell width, `y`/`h` against its height.
 */

/** A crop rectangle in cell fractions, matching the center-tile geometry convention. */
export interface LoadingRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One cycle as written in `manifest.json`. The client re-declares this shape
 * rather than importing it from `tools/center-animation` - the served JSON is
 * the contract between the two, and coupling the browser bundle to a file under
 * `tools/` would drag it into the Docker build context for no runtime gain.
 */
export interface LoadingCycle {
  name: string;
  /** Sheet url relative to the manifest, e.g. `sheets/center_0.png`. */
  sheet: string;
  frames: number;
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
  rect: LoadingRect;
}

export interface LoadingManifest {
  frameDurationMs: number;
  tile: { w: number; h: number };
  cycles: LoadingCycle[];
}

/** A decoded cycle: its manifest entry plus the sprite sheet as a drawable bitmap. */
export interface LoadedCycle {
  def: LoadingCycle;
  image: ImageBitmap;
}

/** What the renderer draws this frame: a sheet sub-rect placed at a cell-fraction rect. */
export interface LoadingFrame {
  image: ImageBitmap;
  /** The frame's pixel sub-rectangle within the sheet. */
  src: { x: number; y: number; w: number; h: number };
  /** Where it belongs on the center cell, in cell fractions. */
  rect: LoadingRect;
}

/** Mutable playback position, advanced by `advancePlayback`. */
export interface PlaybackState {
  /** Index of the cycle currently on screen. */
  index: number;
  /** Timestamp (ms) the current cycle started at. */
  cycleStart: number;
  /** Full cycles completed since `play`/`startDebug`. */
  completed: number;
  /** Whether a stop has been requested (`finish`); honoured only on a boundary. */
  stopRequested: boolean;
  /** `'run'` is the rearrangement indicator; `'debug'` is the dev-panel preview. */
  mode: 'run' | 'debug';
}

/** Cycle timing the state machine needs, without the images. */
export interface CycleTiming {
  frames: number;
}

/**
 * Advance `state` up to `now`, crossing as many cycle boundaries as the elapsed
 * time covers (a backgrounded tab can skip several). At each boundary a full
 * cycle is counted; a `'run'` cycle with a pending stop ends there once at least
 * one cycle has played, reported as `{ stopped: true }` with `state` left on the
 * boundary. Otherwise the next cycle is chosen with `pickNext` and playback
 * continues. Mutates `state` in place.
 */
export function advancePlayback(
  state: PlaybackState,
  now: number,
  cycles: CycleTiming[],
  durationMs: number,
  pickNext: (current: number) => number
): { stopped: boolean } {
  for (;;) {
    const cycleMs = cycles[state.index].frames * durationMs;
    // A zero-length cycle would spin forever; treat it as never crossing.
    if (cycleMs <= 0 || now - state.cycleStart < cycleMs) return { stopped: false };
    state.completed++;
    if (state.mode === 'run' && state.stopRequested && state.completed >= 1) {
      return { stopped: true };
    }
    state.cycleStart += cycleMs;
    state.index = pickNext(state.index);
  }
}

/**
 * The frame index showing at `now`, clamped into the cycle. The clamp covers the
 * sliver where the renderer reads a hair past a boundary the loop has not
 * advanced yet - one held last frame rather than an out-of-range read.
 */
export function frameIndexAt(
  state: PlaybackState,
  now: number,
  cycles: CycleTiming[],
  durationMs: number
): number {
  const frames = cycles[state.index].frames;
  const idx = Math.floor((now - state.cycleStart) / durationMs);
  if (idx < 0) return 0;
  if (idx >= frames) return frames - 1;
  return idx;
}

/**
 * Pick a cycle index other than `current`, uniformly. With a single cycle there
 * is no other, so it returns `current` - a lone cycle simply repeats.
 */
export function pickRandomOther(count: number, current: number, random: () => number): number {
  if (count <= 1) return current;
  const offset = 1 + Math.floor(random() * (count - 1));
  return (current + offset) % count;
}

export interface LoadingAnimation {
  /** The cycle names, in manifest order - for the debug readout and reference. */
  readonly names: string[];
  /** Whether a cycle is playing right now (either mode). */
  isActive(): boolean;
  /** The playing cycle's name, or null when idle - the dev-panel HUD reads this. */
  activeName(): string | null;
  /** The frame to draw on the center cell right now, or null when idle. */
  frame(now?: number): LoadingFrame | null;
  /**
   * Start the rearrangement indicator: a random cycle, looping until
   * `finish`/`cancel`. Returns false without starting when the debug preview
   * owns the screen, so the caller knows not to `finish`/`cancel` a loop it
   * does not own.
   */
  play(requestDraw: () => void): boolean;
  /**
   * Ask the running indicator to stop at the next cycle boundary, guaranteeing
   * at least one full cycle. Resolves once it has actually stopped (or at once
   * if nothing is running / the debug loop owns the screen).
   */
  finish(): Promise<void>;
  /** Stop immediately, whatever mode - the map-interrupt path. */
  cancel(): void;
  /** Start the dev-panel preview: every cycle in order, forever, until `stopDebug`. */
  startDebug(requestDraw: () => void): void;
  /** Stop the dev-panel preview (no effect on a running indicator). */
  stopDebug(): void;
}

/**
 * Build the controller from decoded cycles. `random` is injectable so the state
 * machine's cycle choices are testable; it defaults to `Math.random`.
 */
export function createLoadingAnimation(
  cycles: LoadedCycle[],
  frameDurationMs: number,
  random: () => number = Math.random
): LoadingAnimation {
  const timings: CycleTiming[] = cycles.map((c) => ({ frames: c.def.frames }));
  let state: PlaybackState | null = null;
  let requestDraw: () => void = () => {};
  let rafId: number | null = null;
  let stopResolve: (() => void) | null = null;

  const pickNext = (mode: 'run' | 'debug') =>
    mode === 'debug'
      ? (current: number) => (current + 1) % cycles.length
      : (current: number) => pickRandomOther(cycles.length, current, random);

  function resolveStop() {
    const r = stopResolve;
    stopResolve = null;
    r?.();
  }

  function stopLoop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function loop() {
    rafId = null;
    if (!state) return;
    const { stopped } = advancePlayback(state, performance.now(), timings, frameDurationMs, pickNext(state.mode));
    if (stopped) {
      state = null;
      requestDraw(); // one more paint to clear the overlay
      resolveStop();
      return;
    }
    requestDraw();
    rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (rafId == null) rafId = requestAnimationFrame(loop);
  }

  function begin(mode: 'run' | 'debug', rd: () => void) {
    requestDraw = rd;
    state = {
      index: mode === 'debug' ? 0 : Math.floor(random() * cycles.length),
      cycleStart: performance.now(),
      completed: 0,
      stopRequested: false,
      mode,
    };
    startLoop();
  }

  return {
    names: cycles.map((c) => c.def.name),

    isActive: () => state != null,

    activeName: () => (state ? cycles[state.index].def.name : null),

    frame(now = performance.now()): LoadingFrame | null {
      if (!state) return null;
      const cyc = cycles[state.index];
      const idx = frameIndexAt(state, now, timings, frameDurationMs);
      const col = idx % cyc.def.columns;
      const row = Math.floor(idx / cyc.def.columns);
      return {
        image: cyc.image,
        src: {
          x: col * cyc.def.frameWidth,
          y: row * cyc.def.frameHeight,
          w: cyc.def.frameWidth,
          h: cyc.def.frameHeight,
        },
        rect: cyc.def.rect,
      };
    },

    play(rd) {
      // The dev-panel preview owns the screen while it runs; a stray
      // rearrangement must not fight it or steal its requestDraw.
      if (state?.mode === 'debug') return false;
      begin('run', rd);
      return true;
    },

    finish() {
      if (state?.mode !== 'run') return Promise.resolve();
      state.stopRequested = true;
      return new Promise<void>((resolve) => {
        stopResolve = resolve;
      });
    },

    cancel() {
      if (!state) {
        resolveStop();
        return;
      }
      state = null;
      stopLoop();
      requestDraw();
      resolveStop();
    },

    startDebug(rd) {
      begin('debug', rd);
    },

    stopDebug() {
      if (state?.mode !== 'debug') return;
      state = null;
      stopLoop();
      requestDraw();
    },
  };
}

/**
 * Fetch and decode the loading-animation manifest and its sheets from
 * `<sharedBase>/animation/`. Returns null when there is no manifest to load (a
 * corpus deployed without the indicator), when it is malformed, or when no sheet
 * decodes - every one of which means "play no indicator", never a thrown error
 * on the corpus-load path. `sharedBase` is relative (see `scan.ts`), so the urls
 * built here inherit the subpath deployment's `<base href>`.
 */
export async function loadLoadingAnimation(
  sharedBase: string,
  random: () => number = Math.random
): Promise<LoadingAnimation | null> {
  const base = `${sharedBase}/animation/`;
  let manifest: LoadingManifest;
  try {
    const res = await fetch(`${base}manifest.json`);
    if (!res.ok) return null;
    manifest = await res.json();
  } catch {
    return null;
  }

  if (!manifest || !Array.isArray(manifest.cycles) || manifest.cycles.length === 0) return null;
  const durationMs = manifest.frameDurationMs > 0 ? manifest.frameDurationMs : 100;

  const loaded: LoadedCycle[] = [];
  for (const def of manifest.cycles) {
    try {
      const res = await fetch(`${base}${def.sheet}`);
      if (!res.ok) continue;
      const image = await createImageBitmap(await res.blob(), {
        // Match the GL upload's straight-alpha unpack (see gl/context.ts) so the
        // transparent page composites the same way in both renderers.
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      loaded.push({ def, image });
    } catch {
      // A single unreadable sheet drops that cycle, not the whole indicator.
    }
  }

  if (loaded.length === 0) return null;
  return createLoadingAnimation(loaded, durationMs, random);
}
