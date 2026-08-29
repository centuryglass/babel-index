/**
 * The tile cache: which resolution of which room is in memory, and what to draw
 * when the one you asked for is not.
 *
 * Keyed on `(id, level)`, not on url. A room is one thing at five resolutions,
 * and the whole point of the pyramid is that those five are interchangeable in
 * a pinch - so the cache has to be able to answer "what do you have for room
 * 12?" rather than only "do you have this url?".
 *
 * ### Sheet-packed levels share one decoded image across many rooms
 *
 * A level whose `locateTile()` answer carries a `rect` (see rooms.ts) is
 * sheet-packed: many rooms live in one image. Decoded image identity is kept
 * separate from per-room cache-entry identity for exactly this reason - a
 * per-`(id, level)` entry for a sheet-backed room is a lightweight pointer
 * `{ sheetUrl, rect }`, and the actual `Image` is held once, keyed by url, in
 * `sheetImages`. Many rooms therefore cost one fetch and one decode, which is
 * the entire point (see SHEETS's docblock in pyramid.ts for why this exists).
 * A per-file level (no `rect`) is unchanged: the entry owns its own `Image`
 * directly, exactly as before sheets existed.
 *
 * Because a sheet-backed entry does not own the fetch, evicting one never
 * orphans a request the way evicting a loading per-file entry would - the
 * sheet keeps loading independently in `sheetImages`, tracked by its own
 * frame/lastUsed. That is why sheet-backed entries skip the "never evict
 * while loading" guard `evict()` still applies to per-file entries.
 *
 * ### Budgets are per level, and that is load-bearing
 *
 * Each level gets its own LRU with its own budget from `pyramid.ts`. A single
 * global LRU would break rule 1: zooming in floods the cache with level 0,
 * evicts the entire coarse field, and zooming back out flashes blank across the
 * whole screen - which is the failure the pyramid exists to prevent. Levels
 * never evict each other. `sheetImages` is a further LRU of its own, on top of
 * (not instead of) the per-level room-pointer budgets above - see its budget's
 * docblock in pyramid.ts for why "images held" means something different once
 * one image can serve hundreds of rooms.
 *
 * ### Eviction is frame-aware, and that is too
 *
 * The renderer walks cells row by row, so mid-frame the tiles it has ALREADY
 * DRAWN are the least recently used entries in the cache. A plain LRU therefore
 * evicts the top of the screen to make room for the bottom of the same screen,
 * and the pan blanks and refetches tiles that never left the viewport. Entries
 * carry the frame they were last drawn in, and eviction skips anything touched
 * by the current frame or the one before it - the previous frame included
 * because eviction runs at the top of a frame, before the renderer has touched
 * anything, so protecting only the frame in progress would protect nothing.
 * `sheetImages` entries are touched the same way whenever a room backed by
 * them is touched, so a sheet stays resident exactly as long as any room it
 * covers is still on camera.
 *
 * When one screen genuinely exceeds a level's budget the cache holds it anyway
 * and `overBudget()` says by how much. Holding is the lesser evil; picking a
 * coarser level is the actual answer, and that is the renderer's job.
 *
 * The coarsest level (`pyramid.fallbackLevel`) is a further exception, by
 * default: its sheets, once loaded, are never evicted at all (see
 * `neverEvictSheetLevels`). A pan at that zoom crosses the whole map in a
 * couple of gestures - constantly warming and dropping sheets there would
 * mean visibly thrashing rather than caching. The whole level's sheets are
 * few and cheap (see SHEETS's docblock), so holding all of them forever,
 * loaded lazily as each is first asked for, is strictly better than evicting
 * any of them.
 *
 * `createImage` exists so all of this can be tested without a DOM; the browser
 * never passes it.
 */
import { PYRAMID, PREFETCH, SHEETS, type Pyramid } from './pyramid.ts';
import type { Rect, LocateTile } from './rooms.ts';

/**
 * The shared-tile ids. Strings, so they can never collide with a numeric room id.
 *
 * `CENTER` is the blank center tile at cell (0, 0). The wallpaper elsewhere is
 * one of N inpainted generics, addressed by `genericId(i)`; a generic cell with
 * none available (an empty `generic/` dir) falls back to `CENTER`, which is why
 * `genericId(-1)` is `CENTER` rather than an id that resolves to nothing.
 */
export const CENTER = 'center';
export const genericId = (i: number): number | string => (i < 0 ? CENTER : `generic:${i}`);

/** How many prefetches may be waiting at once. See prefetch() for why. */
const QUEUE_LIMIT = 256;

/**
 * Minimal shape of a loadable image - just enough to test without a DOM.
 * `HTMLImageElement`'s real `onload`/`onerror` take an `Event` nobody here
 * reads, so this narrows them to zero-arg callbacks rather than widening
 * every caller to accept one it would ignore.
 */
export interface LoadableImage {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

type RoomId = number | string;
type ImageState = 'loading' | 'ready' | 'error';

interface PerFileEntry {
  img: LoadableImage;
  rect: null;
  state: ImageState;
  lastUsed: number;
  frame: number | null;
}

interface SheetBackedEntry {
  sheetUrl: string;
  rect: Rect;
  lastUsed: number;
  frame: number | null;
}

type Entry = PerFileEntry | SheetBackedEntry;

/** A type guard, not just a truthiness check - `rect: Rect | null` alone isn't enough for TS to narrow the union. */
const isSheetBacked = (e: Entry): e is SheetBackedEntry => e.rect != null;

interface SheetImage {
  img: LoadableImage;
  level: number;
  state: ImageState;
  lastUsed: number;
  frame: number | null;
}

/** What `get()` reports for a room: the image to draw from, its sub-rect if sheet-backed, and which level it actually is. */
export interface TileHit {
  img: LoadableImage;
  rect: Rect | null;
  level: number;
}

export interface CreateTileCacheOpts {
  /** Where a level of a room lives, and its rect within a shared sheet image if it is packed into one; null if that level does not exist. */
  locateTile: LocateTile;
  /** The ladder and its budgets. */
  pyramid?: Pyramid;
  /** Decoded sheet images held at once, across every sheet-packed level. */
  sheetBudget?: number;
  /** Sheet-packed levels whose sheets, once loaded, are never evicted regardless of `sheetBudget` - defaults to just the coarsest level. */
  neverEvictSheetLevels?: number[];
  /** Ask for a redraw. */
  onLoad?: () => void;
  /** In-flight prefetches allowed. */
  concurrency?: number;
  createImage?: () => LoadableImage;
}

export interface TileCache {
  beginFrame: () => void;
  request: (id: RoomId, level: number) => { img: LoadableImage; rect: Rect | null } | null;
  get: (id: RoomId, want: number) => TileHit | null;
  prefetch: (id: RoomId, level: number) => void;
  pin: (id: RoomId) => void;
  size: () => number;
  sizeOf: (level: number) => number;
  sheetCount: () => number;
  /** How far past their budgets the visible working set is forcing the levels. */
  overBudget: () => number;
  pendingPrefetch: () => number;
  clear: () => void;
}

export function createTileCache({
  locateTile,
  pyramid = PYRAMID,
  sheetBudget = SHEETS.cacheBudget,
  neverEvictSheetLevels = [pyramid.fallbackLevel],
  onLoad,
  concurrency = PREFETCH.concurrency,
  createImage = () => new Image() as unknown as LoadableImage,
}: CreateTileCacheOpts): TileCache {
  // level -> (id -> entry). A per-file entry is { img, rect: null, state, lastUsed, frame };
  // a sheet-backed entry is { sheetUrl, rect, lastUsed, frame } - its readiness
  // and image come from `sheetImages`, not from a state field of its own.
  const levels = new Map<number, Map<RoomId, Entry>>(pyramid.levels.map((l) => [l.level, new Map()]));
  // url -> { img, level, state, lastUsed, frame }, shared across every entry backed by that sheet.
  const sheetImages = new Map<string, SheetImage>();
  const neverEvict = new Set(neverEvictSheetLevels);
  const pinned = new Set<RoomId>();
  const queue: [RoomId, number][] = [];
  // Urls with a fetch genuinely in flight right now, so many queued rooms that
  // resolve to the same sheet spend one concurrency slot, not one each.
  const inFlightUrls = new Set<string>();
  let clock = 0;
  // null until the caller opts in: without beginFrame() there is no such thing
  // as "the current frame", so nothing is protected and this is a plain LRU.
  let frame: number | null = null;

  const bucket = (level: number) => levels.get(level);
  const entry = (id: RoomId, level: number) => bucket(level)?.get(id);

  const sheetReady = (url: string) => sheetImages.get(url)?.state === 'ready';
  const entryReady = (e: Entry) => (isSheetBacked(e) ? sheetReady(e.sheetUrl) : e.state === 'ready');
  const entryImg = (e: Entry): LoadableImage | undefined =>
    isSheetBacked(e) ? sheetImages.get(e.sheetUrl)?.img : e.img;
  const isReady = (id: RoomId, level: number) => {
    const e = entry(id, level);
    return e != null && entryReady(e);
  };

  /**
   * Open a new frame. Tiles drawn from here on, and those drawn in the frame
   * before, are off-limits to eviction. Also drops any prefetch still queued
   * from the last frame: it was queued for a viewport that has since moved.
   */
  function beginFrame(): void {
    frame = (frame ?? 0) + 1;
    queue.length = 0;
    for (const { level } of pyramid.levels) evict(level);
    evictSheets();
  }

  /** Keep every level of this room forever. The base tiles are the floor rule 1 lands on. */
  function pin(id: RoomId): void {
    pinned.add(id);
  }

  /** Register (or find) the shared decoded image for a sheet url. */
  function requestSheet(url: string, level: number): SheetImage {
    const found = sheetImages.get(url);
    if (found) {
      found.lastUsed = ++clock;
      found.frame = frame;
      return found;
    }
    const img = createImage();
    const fresh: SheetImage = { img, level, state: 'loading', lastUsed: ++clock, frame };
    sheetImages.set(url, fresh);
    img.onload = () => {
      fresh.state = 'ready';
      onLoad?.();
    };
    img.onerror = () => {
      fresh.state = 'error';
    };
    img.src = url;
    evictSheets();
    return fresh;
  }

  /**
   * Start the load for one level of one room, if it is not already here or on
   * its way. Returns `{img, rect}` if it happens to be ready.
   */
  function request(id: RoomId, level: number): { img: LoadableImage; rect: Rect | null } | null {
    const found = entry(id, level);
    if (found) {
      found.lastUsed = ++clock;
      found.frame = frame;
      if (isSheetBacked(found)) requestSheet(found.sheetUrl, level); // touches the sheet's own lastUsed/frame too
      return entryReady(found) ? { img: entryImg(found)!, rect: found.rect } : null;
    }

    const loc = locateTile(id, level);
    // No location means this level was never generated for this corpus. Recording
    // a miss would be recording a fact about the corpus in a per-tile cache.
    if (loc == null) return null;

    const store = bucket(level);
    if (!store) return null;

    if (loc.rect) {
      const sheet = requestSheet(loc.url, level);
      const fresh: SheetBackedEntry = { sheetUrl: loc.url, rect: loc.rect, lastUsed: ++clock, frame };
      store.set(id, fresh);
      evict(level);
      return sheet.state === 'ready' ? { img: sheet.img, rect: loc.rect } : null;
    }

    const img = createImage();
    const fresh: PerFileEntry = { img, rect: null, state: 'loading', lastUsed: ++clock, frame };
    store.set(id, fresh);

    img.onload = () => {
      fresh.state = 'ready';
      onLoad?.();
    };
    // A 404 is remembered rather than retried: the entry stays, permanently
    // demoting this cell to whatever level does work.
    img.onerror = () => {
      fresh.state = 'error';
    };
    img.src = loc.url;

    evict(level);
    return null;
  }

  /**
   * The nearest level this room has art for at all, which is not always the one
   * asked for: a corpus that has never been through the pipeline has only level
   * 0, so every request for a coarser tile has to resolve to it or the cell
   * would wait forever for a file that does not exist.
   *
   * Same preference as `bestAvailable` - coarser first, then finer - so what
   * gets fetched and what gets drawn agree about which substitute is best.
   */
  function servableLevel(id: RoomId, want: number): number | null {
    if (locateTile(id, want) != null) return want;
    for (const { level } of pyramid.levels)
      if (level > want && locateTile(id, level) != null) return level;
    for (let i = pyramid.levels.length - 1; i >= 0; i--) {
      const { level } = pyramid.levels[i];
      if (level < want && locateTile(id, level) != null) return level;
    }
    return null;
  }

  /**
   * Rule 1: the best thing available to draw for this room right now.
   *
   * Always starts the nearest servable level loading, then answers with
   * whatever is actually here - coarser first, since a coarse tile is cheap,
   * usually already resident from the zoomed-out view, and upscales to
   * something soft but correct. The level comes back with the image so the
   * renderer can tell a hit from a substitute.
   *
   * Returns null only when the room has nothing at all.
   */
  function get(id: RoomId, want: number): TileHit | null {
    const servable = servableLevel(id, want);
    if (servable !== null) request(id, servable);
    const level = pyramid.bestAvailable((l) => isReady(id, l), want);
    if (level === null) return null;
    const e = entry(id, level)!;
    return { img: entryImg(e)!, rect: e.rect, level };
  }

  /**
   * Rule 2: load this, but only behind everything visible.
   *
   * Queued rather than issued, and capped, because a prefetch that queues ahead
   * of a visible tile has made rule 1 worse in order to serve rule 2. The queue
   * is cleared every frame, so a fast pan never works through a backlog aimed
   * at where the camera used to be.
   */
  function prefetch(id: RoomId, level: number): void {
    // The queue is emptied every frame, so anything past what `concurrency`
    // could plausibly start before the next one is stale before it is reached.
    // A zoomed-out frame offers thousands of candidates; taking them all would
    // be a large allocation per frame to throw away.
    if (queue.length >= QUEUE_LIMIT) return;
    if (entry(id, level) || locateTile(id, level) == null) return;
    queue.push([id, level]);
    pump();
  }

  function pump(): void {
    while (inFlightUrls.size < concurrency && queue.length) {
      const [id, level] = queue.shift()!;
      if (entry(id, level)) continue; // arrived by another route since queueing
      const loc = locateTile(id, level);
      if (loc == null) continue;

      if (inFlightUrls.has(loc.url)) {
        // Another queued room already has this exact url in flight - a file,
        // or (the common case with sheets) many rooms sharing one sheet.
        // Materialize this room's own pointer entry without spending a
        // second concurrency slot or a second completion hook; the fetch
        // already in flight calls onLoad/pump once for everyone waiting on it.
        request(id, level);
        continue;
      }

      request(id, level);
      const e = entry(id, level);
      const state = e && (isSheetBacked(e) ? sheetImages.get(e.sheetUrl)?.state : e.state);
      if (!e || state !== 'loading') continue; // resolved instantly - cached, pinned, or errored

      const img = isSheetBacked(e) ? sheetImages.get(e.sheetUrl)!.img : e.img;
      inFlightUrls.add(loc.url);
      const done = () => {
        inFlightUrls.delete(loc.url);
        pump();
      };
      const { onload, onerror } = img;
      img.onload = () => {
        onload?.();
        done();
      };
      img.onerror = () => {
        onerror?.();
        done();
      };
    }
  }

  /** Is this entry (or sheet) one the current draw still depends on? */
  const inUse = (e: Entry | SheetImage) => frame !== null && e.frame != null && e.frame >= frame - 1;

  function evict(level: number): void {
    const store = bucket(level);
    const budget = pyramid.budgetOf(level);
    if (!store || store.size <= budget) return;

    const spare = [...store.entries()]
      // A per-file entry mid-load owns its request; dropping it orphans the
      // image (it completes into an entry no longer in the map, and the url
      // is fetched again next time it's drawn). A sheet-backed entry owns
      // nothing - its sheet keeps loading in `sheetImages` regardless - so it
      // is always evictable, cheaply rebuilt from `locateTile` if needed again.
      .filter(([id, e]) => (isSheetBacked(e) || e.state !== 'loading') && !pinned.has(id) && !inUse(e))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    for (const [id] of spare.slice(0, store.size - budget)) store.delete(id);
  }

  /**
   * A capacity-gated LRU, exactly like `evict()` for per-file entries: nothing
   * is dropped just because it is off screen this frame - only once the total
   * held exceeds `sheetBudget`, and then only the least-recently-used sheets
   * among those not currently in use, oldest first, until back at budget.
   * A level in `neverEvictSheetLevels` (the coarsest by default - see its
   * docblock) is exempt entirely: once loaded, its sheets stay for the life
   * of the cache, which is what makes zooming all the way out and panning
   * freely there cost nothing after the first full pass.
   */
  function evictSheets(): void {
    const budget = Math.max(1, Math.round(sheetBudget));
    if (sheetImages.size <= budget) return;

    const spare = [...sheetImages.entries()]
      .filter(([, s]) => !neverEvict.has(s.level) && s.state !== 'loading' && !inUse(s))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    for (const [url] of spare.slice(0, sheetImages.size - budget)) sheetImages.delete(url);
  }

  const size = () => [...levels.values()].reduce((n, store) => n + store.size, 0) + sheetImages.size;

  return {
    beginFrame,
    request,
    get,
    prefetch,
    pin,
    size,
    sizeOf: (level: number) => bucket(level)?.size ?? 0,
    sheetCount: () => sheetImages.size,
    /** How far past their budgets the visible working set is forcing the levels. */
    overBudget: () =>
      pyramid.levels.reduce(
        (n, l) => n + Math.max(0, (bucket(l.level)?.size ?? 0) - pyramid.budgetOf(l.level)),
        0
      ),
    pendingPrefetch: () => queue.length,
    clear: () => {
      for (const store of levels.values()) store.clear();
      sheetImages.clear();
      pinned.clear();
      queue.length = 0;
      inFlightUrls.clear();
    },
  };
}
