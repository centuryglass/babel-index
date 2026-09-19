import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createLayout, shuffledOrder } from '../../map/ordering.ts';
import { favoriteOrder, favoriteSort, favoriteCount, type SortMode } from '../../map/favorites.ts';
import { availableSensitiveTags, countBlocked, filterBlockedIds } from '../../map/metadata.ts';
import { buildSlugTable } from '../../map/slug.ts';
import type { ManifestResponse } from '../../map/manifest.ts';
import type { Config } from '../../config/config.ts';
import { MapView } from './components/MapView.tsx';
import { CatalogView } from './components/CatalogView.tsx';
import { RoomOverlay } from './components/RoomOverlay.tsx';
import { HelpDialog } from './components/HelpDialog.tsx';
import { alphabeticalOrder } from './lib/catalog.ts';
import { load, save, clear, KEYS } from './lib/persist.ts';
import { TOUCH_DEBUG, appendTouchLog } from './lib/touchDebug.ts';
import { roomAtPoint, type RoomPick } from './lib/picking.ts';
import { describeCell, describeRoom, describeCatalog, describeSort } from '../../map/describe.ts';
import {
  bookAtPoint,
  centerCellRect,
  searchBoxScreenRect,
  isSearchBoxUsable,
  searchBoxAtPoint,
  centerBookAtPoint,
  areSpinesLegible,
  overlapsViewport,
  fullyInViewport,
  HISTORY_SLOT_COUNT,
  CENTER_OPENING_RECT,
  openingZoom,
  shuffleButtonAtPoint,
  mineToggleAtPoint,
  countToggleAtPoint,
} from './lib/center.ts';
import { ArtistStatementOverlay } from './components/ArtistStatementOverlay.tsx';
import {
  CELL_ASPECT, fitZoom, overviewZoom, pxPerCell, worldToScreen, clampZoom, ZOOM_LIMITS, type Camera,
} from './lib/camera.ts';
import {
  createTileCache, CENTER, FAV_ON, FAV_OFF, FAV_CENTER_SWITCH_BASE, FAV_MINE_ON, FAV_COUNT_ON,
  DISTILL_OFF, DISTILL_ON, genericId, genericDistillId,
} from './lib/tiles.ts';
import { favoriteHitRect, pointInRect } from './lib/favoriteBadge.ts';
import { distillToggleAtPoint } from './lib/distillToggle.ts';
import { createUrlFor, createTileLocator } from './lib/rooms.ts';
import { createRenderer } from './lib/render.ts';
import { loadSpineFont } from './lib/spineFont.ts';
import { createSlideRenderer } from './lib/slide.ts';
import { WEBGL } from './lib/webglFlag.ts';
import { loadLoadingAnimation, type LoadingAnimation } from './lib/loadingAnimation.ts';
import { useMapCamera } from './hooks/useMapCamera.ts';
import { useMapRenderer } from './hooks/useMapRenderer.ts';
import { useMapRendererGL } from './hooks/useMapRendererGL.ts';
import { useMapCursor } from './hooks/useMapCursor.ts';
import { useCenterShelf } from './hooks/useCenterShelf.ts';
import { useModeTransition } from './hooks/useModeTransition.ts';
import { useCorpus } from './hooks/useCorpus.ts';
import { useRearrangement } from './hooks/useRearrangement.ts';
import { useDistillMode } from './hooks/useDistillMode.ts';
import { useSearch, describeSignals } from './hooks/useSearch.ts';
import { useFavorites } from './hooks/useFavorites.ts';
import { DEBUG } from './lib/debug.ts';
import { buildSequence, runSequence, DEFAULT_DURATION_MS, type DebugActions } from './lib/debugActions.ts';

function App() {
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('api/manifest')
      .then((r) => r.json())
      .then(setManifest)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="panel">Could not load the corpus: {error}</div>;
  if (!manifest) return <div className="panel">Opening the library…</div>;
  return <Library manifest={manifest} />;
}

/** The card's open picking result - which room or generic cell it names. */
type CardState = RoomPick;

function Library({ manifest }: { manifest: ManifestResponse }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // A canvas commits to one context type, permanently, at the first
  // `getContext` call - so exactly one renderer may touch it. `WEBGL` is
  // decided at page load, and the inactive hook gets this permanently-null
  // ref: its effect bails before ever calling `getContext`.
  const inertCanvasRef = useRef<HTMLCanvasElement>(null);
  // The refs below are DOM elements positioned imperatively from the render
  // loop, not from React state: the camera moves every frame, and
  // re-rendering the tree that often would cost far more than the style
  // writes the loop makes alongside each canvas repaint.

  // The live search field, on the center tile rather than in the side panel.
  const searchFormRef = useRef<HTMLFormElement>(null);
  // The shelf's book buttons: one box matching the center cell, its buttons
  // laid out in percentages inside it - so panning costs one style write,
  // not one per book.
  const booksRef = useRef<HTMLDivElement>(null);
  // The search badge's orbiting arrow: it points at wherever the center
  // tile currently is on screen.
  const searchArrowRef = useRef<HTMLSpanElement>(null);
  // The artist's-statement hotspot, sized over the whole cell. The traced
  // `CENTER_BOOK_PATH` SVG inside is the visual shape; taps reach it through
  // the canvas (`centerBookAtPoint`), so the button itself stays
  // `pointer-events: none` (see style.css).
  const centerBookRef = useRef<HTMLButtonElement>(null);
  // The reorder button and favorites-sort switch, laid out in percentages
  // the same way `booksRef`'s buttons are.
  const controlsRef = useRef<HTMLDivElement>(null);
  // The favorite badge's tooltip. Badges are painted onto every tile and
  // have no DOM of their own, so one floating element serves the whole map.
  const favTooltipRef = useRef<HTMLDivElement>(null);
  // The distill toggle's tooltip, for the same reason.
  const distillTooltipRef = useRef<HTMLDivElement>(null);
  const total = manifest.count;

  // Config (packages/config) supplies every by-feel number, including where
  // the sliders start; nothing here restates those values as literals.
  const config = manifest.config as unknown as Config;

  // How the catalog advances. Persisted: the reader's stored choice beats
  // config's default, which only decides where a first visit starts.
  const [paging, setPaging] = useState(() =>
    load(KEYS.paging, config.catalog.paging, {
      validate: (v) => v === 'scroll' || v === 'pages',
    })
  );
  useEffect(() => {
    save(KEYS.paging, paging);
  }, [paging]);

  const [roomCount, setRoomCount] = useState(total);
  const [contentRatio, setContentRatio] = useState(config.map.contentRatio);
  const [seed, setSeed] = useState(config.map.slotSeed);
  const [orderSeed, setOrderSeed] = useState(() => Date.now());
  // Which of the four readings of the same ranking is in force. Session-only,
  // unlike favorites: a favorite list is a standing choice about the library;
  // "sorted by favorites right now" is not.
  const [sortMode, setSortMode] = useState<SortMode>('relevance');
  // The permutation `'random'` sorts by (see `favorites.ts`). Rerolled only
  // when `changeSort` switches into it, so ordinary re-renders - a favorite
  // toggle, a map/catalog switch - never reshuffle an order on screen.
  const [randomSortSeed, setRandomSortSeed] = useState(() => Date.now());

  const [status, setStatus] = useState('');
  // Search history, newest first, one book per entry. Persisted because it
  // titles the center shelf: the wall reads as a record of what this reader
  // has asked the library, not keyword tags that reset each session.
  //
  // Read once at mount through a validator - storage is hand-editable and
  // outlives any version of this code, so "it parsed" is not "it is a list
  // of search terms". Capped at the wall's size; the wall is the only place
  // it is shown.
  const [history, setHistory] = useState(() =>
    load<string[]>(KEYS.history, [], {
      validate: (v) => Array.isArray(v) && v.every((term) => typeof term === 'string'),
    }).slice(0, HISTORY_SLOT_COUNT)
  );
  const pushHistory = useCallback((term: string) => {
    setHistory((prev) => [term, ...prev.filter((t) => t !== term)].slice(0, HISTORY_SLOT_COUNT));
  }, []);
  // An emptied history removes the storage key rather than saving [].
  useEffect(() => {
    if (history.length) save(KEYS.history, history);
    else clear(KEYS.history);
  }, [history]);

  // Sensitive-content tags the reader has blocked, from HelpDialog's panel.
  // Persisted like `history` - a standing choice, not session state.
  // `?blockTags` seeds this only when nothing is stored yet: after the
  // reader's first manual choice, the link parameter is inert.
  const [blockedTags, setBlockedTags] = useState(() =>
    load<string[]>(KEYS.blockedTags, URL_BLOCKED_TAGS, {
      validate: (v) => Array.isArray(v) && v.every((t) => typeof t === 'string'),
    })
  );
  const toggleBlockedTag = useCallback((tag: string) => {
    setBlockedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }, []);
  useEffect(() => {
    if (blockedTags.length) save(KEYS.blockedTags, blockedTags);
    else clear(KEYS.blockedTags);
  }, [blockedTags]);
  const blockedTagSet = useMemo(() => new Set(blockedTags), [blockedTags]);

  // The corpus itself: metadata sidecar, embedding blob, and the search
  // index built over both - see useCorpus.ts.
  const { metadata, embeddings, searchIndex, described, tagLinks } = useCorpus(manifest);

  // availableTags: only the sensitive tags this corpus actually has, so a
  // corpus with none renders no blocking panel at all. blockedCount: rooms
  // the current choice removes (panel text and debug HUD).
  const availableTags = useMemo(() => availableSensitiveTags(metadata), [metadata]);
  const blockedCount = useMemo(() => countBlocked(metadata, blockedTagSet), [metadata, blockedTagSet]);

  // Room permalinks, for the overlay's copy-link button. Rebuilt when the
  // sidecar lands: until then every room's slug is its filename stem, which
  // resolves and redirects to the title url (`app.ts`'s `/catalog/:slug`), so
  // a link copied in that window is never wrong - only not yet the pretty
  // form.
  const roomSlugs = useMemo(() => buildSlugTable(manifest.rooms, metadata).slugs, [manifest, metadata]);

  // useSearch and useRearrangement need each other: a search asks for the
  // rearrangement, and the rearrangement's announcement needs the search's
  // `result`. The cycle can't be reordered away, so useSearch takes this
  // ref and it is filled in below once useRearrangement has returned.
  // See useSearch.ts's file comment.
  const requestAnimationRef = useRef<(note: string) => void>(() => {});
  const { query, setQuery, result, search, runSearch, clearSearch, highlight } = useSearch({
    total,
    searchConfig: config.search,
    searchIndex,
    embeddings,
    requestAnimationRef,
    pushHistory,
    setStatus,
  });

  // The reader's own favorites and the library's global counts
  // (useFavorites). With no favorite store deployed, `enabled` is false and
  // no favorite control renders anywhere.
  const favorites = useFavorites({ manifest, setStatus });

  // How many generic tiles the corpus shipped, and the seed that scatters
  // them. Which face a generic cell shows depends on the cell alone, never
  // on order or search - which is why the rearrangement can treat every
  // generic cell as one interchangeable value.
  const genericCount = manifest.shared?.generic?.length ?? 0;
  const genericSeed = config.map.genericSeed;

  // A running search wins over 'random': a reshuffle would bury the ranking
  // the reader just asked for, so 'random' reads as 'relevance' while a
  // search is active. `changeSort` clears the search when entering 'random',
  // but a new search can start while 'random' is already chosen.
  const effectiveSortMode: SortMode = sortMode === 'random' && result ? 'relevance' : sortMode;

  // The map's order and its density profile, from one sort: a favorite sort
  // is a placement input exactly as a search is, so `favoriteSort` composes
  // the two - a search's own certainty, boosted to 1 for whatever the sort
  // lifted to the front - and `layout` reads one number per room instead of
  // two that could disagree.
  //
  // Rooms are blocked before sorting, not after: filtering last would let a
  // favorite bring a blocked room back onto the map.
  const sortResult = useMemo(() => {
    const base = result ? result.order : shuffledOrder(total, orderSeed);
    return favoriteSort(
      filterBlockedIds(base, metadata, blockedTagSet),
      { mode: effectiveSortMode, randomSeed: randomSortSeed, ...favorites.sortInput },
      result?.certainty ? { order: result.order, certainty: result.certainty } : null
    );
  }, [total, orderSeed, result, metadata, blockedTagSet, effectiveSortMode, randomSortSeed, favorites.sortInput]);

  const order = sortResult.order;

  // The map's placement. Every argument is a runtime parameter: re-deriving
  // touches no downloaded image bytes. `aspect` makes the library round on
  // screen rather than in the index - cells are not square, so those differ,
  // and the edge should be equally far whichever way you drag. `density`
  // carries the search's certainty profile, which is what clusters matches
  // toward the center; no search means no profile means the uniform map, so
  // clearing the box restores the baseline layout without a second code path.
  const layout = useMemo(
    () =>
      createLayout({
        roomCount: Math.min(roomCount, total),
        contentRatio,
        seed,
        aspect: CELL_ASPECT,
        genericCount,
        genericSeed,
        density: sortResult.certainty
          ? { ...config.search.density, certainty: sortResult.certainty }
          : null,
      }),
    [roomCount, contentRatio, seed, total, sortResult, config, genericCount, genericSeed]
  );

  // The catalog's order: alphabetical at rest, since a shuffle is not an
  // order anyone can read by eye. Map and catalog agree only while a search
  // runs - `result.order` is the one array both views rank on - so a search
  // and a clear are the only things that move a catalog row.
  //
  // Kept separate from `catalogOrder` so a favorite toggle never changes
  // this array's identity: `favoriteOrder` returns this array unchanged for
  // 'relevance', and CatalogView resets scroll whenever `order`'s identity
  // changes - merging the two memos would scroll a favoriting reader to the
  // top of the list.
  const catalogBase = useMemo(() => {
    const base = result ? result.order : alphabeticalOrder(manifest.rooms, metadata);
    return filterBlockedIds(base, metadata, blockedTagSet);
  }, [manifest, result, metadata, blockedTagSet]);

  const catalogOrder = useMemo(
    () =>
      favoriteOrder(catalogBase, {
        mode: effectiveSortMode,
        randomSeed: randomSortSeed,
        ...favorites.sortInput,
      }),
    [catalogBase, effectiveSortMode, randomSortSeed, favorites.sortInput]
  );

  // Which cell a room id sits in on the map right now. Keyed by id, not
  // rank: map rank and catalog rank coincide only while a search is active,
  // so "show on the map" looks rooms up by what they are.
  const cellById = useMemo(() => {
    const cells = new Map<number, { x: number; y: number }>();
    order.forEach((id, rank) => {
      const cell = layout.cellOfRank(rank);
      if (cell) cells.set(id, cell);
    });
    return cells;
  }, [order, layout]);

  const draw = useRef(() => {});
  const requestDraw = useCallback(() => {
    draw.current();
  }, []);

  // The WebGL renderer's GPU-texture warmer, filled in by `useMapRendererGL`
  // once its GL runtime exists (same ref pattern as `draw`). `onPreparingGL`
  // is a stable wrapper so useRearrangement's callback chain does not
  // rebuild every render.
  const warmTexturesRef = useRef((_ids: ReadonlySet<number>, _level: number) => {});
  const onPreparingGL = useCallback((ids: ReadonlySet<number>, level: number) => {
    warmTexturesRef.current(ids, level);
  }, []);

  // Until the center shelf's webfont loads, `composeSpines` falls back to
  // Georgia - legible but not final. This redraws once the real face is
  // registered. See spineFont.ts for why loading lives outside `center.ts`.
  useEffect(() => {
    let cancelled = false;
    loadSpineFont().then(() => {
      if (!cancelled) draw.current();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Where a room's tile lives at each level. `locateTile` is the full
  // answer - url plus a source rect when the level is packed into a shared
  // sheet - for the canvas cache. `urlFor` is the same lookup as a bare url
  // for the catalog and overlay `<img>`s (null when sheet-packed, which an
  // `<img src>` cannot address). Both read the manifest, the record of
  // which levels the corpus actually has.
  const locateTile = useMemo(() => createTileLocator(manifest), [manifest]);
  const urlFor = useMemo(() => createUrlFor(manifest), [manifest]);

  const cache = useMemo(() => {
    const tiles = createTileCache({
      locateTile,
      onLoad: () => requestDraw(),
    });
    // The shared tiles are pinned and preloaded so every cell can draw
    // something before any room image has arrived: the blank center, one
    // face per generic tile, and distill mode's alternates where they exist
    // on disk (see `genericDistillId`'s doc). The set is small enough that
    // pinning all of it fits the cache budget, and pinning the distill
    // alternates up front keeps the first-ever toggle from falling to flat
    // black while they load.
    //
    // The center is requested at level 0: it is on screen from the first
    // frame (the opening view is capped at 1x, see `center.ts`'s
    // `openingZoom`), so nothing is gained by starting coarse. The generic
    // tiles are requested at the coarsest rung `manifest.shared.levels`
    // actually has instead - a screen at opening zoom shows only a handful
    // of them, and preloading every one at full resolution paid for
    // thousands of cells' worth of art before a single frame draws (AGENTS.md,
    // "The shared tiles are served flat" - resolved once `shared.levels` has
    // more than level 0). Never hardcode the coarsest rung as
    // `pyramid.fallbackLevel`: an older corpus with no shared pyramid
    // generated has no tile there. Distill's alternates have no pyramid of
    // their own (`rooms.ts`'s header), so they stay at level 0 like the center.
    const sharedLevelNumbers = (manifest.shared?.levels ?? []).filter((l) => l.dir).map((l) => l.level);
    const coarsestSharedLevel = sharedLevelNumbers.length ? Math.max(...sharedLevelNumbers) : 0;
    const genericDistillIds = (manifest.shared?.genericDistill ?? [])
      .map((v, i) => (v ? genericDistillId(i) : null))
      .filter((id): id is number | string => id != null);
    tiles.pin(CENTER);
    tiles.request(CENTER, 0);
    for (const id of (manifest.shared?.generic ?? []).map((_, i) => genericId(i))) {
      tiles.pin(id);
      tiles.request(id, coarsestSharedLevel);
    }
    for (const id of genericDistillIds) {
      tiles.pin(id);
      tiles.request(id, 0);
    }
    // The favorite badge's two faces and the center tile's sort-switch art,
    // pinned the same way - tiny images, gated on the store existing.
    if (favorites.enabled) {
      for (const id of [FAV_ON, FAV_OFF, FAV_CENTER_SWITCH_BASE, FAV_MINE_ON, FAV_COUNT_ON]) {
        tiles.pin(id);
        tiles.request(id, 0);
      }
    }
    // The distill toggle's two faces - pinned unconditionally, unlike the
    // favorite art above, since distill mode needs no favorite store.
    for (const id of [DISTILL_OFF, DISTILL_ON]) {
      tiles.pin(id);
      tiles.request(id, 0);
    }
    return tiles;
  }, [manifest, requestDraw, locateTile, favorites.enabled]);

  const renderer = useMemo(() => createRenderer({ cache }), [cache]);
  const slideRenderer = useMemo(() => createSlideRenderer({ cache }), [cache]);

  // The rearrangement in progress, or null. A ref, not state: it changes
  // every frame, and state would tear down the render effect sixty times a
  // second. It holds the animation's board, its progress, and the camera it
  // was planned for - frames draw at that camera, not the live one.
  const anim = useRef(null);

  // The center-tile loading indicator (loadingAnimation.ts), loaded once
  // from the shared assets; a ref for the same reason as `anim`. Null until
  // the manifest loads, and forever on a corpus deployed without sheets -
  // read as "no indicator". `hasLoadingAnim` mirrors it for the dev panel's
  // preview checkbox.
  const loadingAnim = useRef<LoadingAnimation | null>(null);
  const [hasLoadingAnim, setHasLoadingAnim] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadLoadingAnimation(manifest.sharedBase).then((anim) => {
      if (cancelled || !anim) return;
      loadingAnim.current = anim;
      setHasLoadingAnim(true);
    });
    return () => {
      cancelled = true;
    };
  }, [manifest.sharedBase]);

  // The dev panel's "loop loading animations" checkbox: a standalone
  // preview that walks every cycle in order, toggled straight on the
  // controller. The current cycle name shows in the HUD.
  const setAnimationPreview = useCallback(
    (on: boolean) => {
      if (on) loadingAnim.current?.startDebug(requestDraw);
      else loadingAnim.current?.stopDebug();
    },
    [requestDraw]
  );

  // The search badge's spinner: the same preload window as the center-tile
  // indicator, visible anywhere on screen - this is what a reader browsing
  // far from the center sees during a preload. Driven by
  // useRearrangement's `onPreparingChange`.
  const [preparingRearrangement, setPreparingRearrangement] = useState(false);

  const resistanceAt = useCallback((x: number, y: number) => layout.resistanceAt(x, y), [layout]);

  // The catalog's expanded room: tile at full size and the whole story -
  // how a reader sees either without leaving the fixed-height rows (see
  // `RoomOverlay`). Seeded once at mount from `INITIAL_ROUTE.room`, so a
  // `/catalog/<slug>` permalink opens that room's overlay directly, and
  // `order` is already final here, so the rank it opens with is the row's
  // real position.
  const [overlay, setOverlay] = useState<{ id: number; rank: number } | null>(() => {
    if (!INITIAL_ROUTE?.room) return null;
    const room = manifest.rooms.find((r) => r.file === INITIAL_ROUTE.room);
    if (!room) return null;
    const rank = order.indexOf(room.id);
    return { id: room.id, rank: rank === -1 ? 0 : rank };
  });
  const expandRoom = useCallback((id: number, rank: number) => setOverlay({ id, rank }), []);

  // "Show in the catalog", the card's reciprocal of a row's "show on the
  // map": a one-shot instruction for CatalogView to scroll to and mark this
  // room, cleared once done. Names a row to jump to - `overlay` names a room
  // to open full-size.
  const [catalogSpotlightId, setCatalogSpotlightId] = useState<number | null>(null);
  const clearCatalogSpotlight = useCallback(() => setCatalogSpotlightId(null), []);

  // A reserved book on the center shelf opens this instead of running a
  // search - see useCenterShelf.ts's CENTER_OVERRIDES and onOverride.
  const [helpOpen, setHelpOpen] = useState(false);

  // A one-time visual nudge toward the "READ ME" book, for a reader who has
  // never opened it. The stored flag is written on this same mount, so a
  // reload never re-nudges - opened or not. Opening help clears the nudge
  // right away (`onOverride` in useCenterShelf.ts).
  const [showHelpHint, setShowHelpHint] = useState(() => !load(KEYS.seenHelpHint, false));
  useEffect(() => {
    if (showHelpHint) save(KEYS.seenHelpHint, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The open book painted into a shelf gap - a distinct hotspot from the
  // lettered books: a tap routed through `centerBookAtPoint` on the map, an
  // ordinary click in the catalog.
  const [artistStatementOpen, setArtistStatementOpen] = useState(false);
  const openArtistStatement = useCallback(() => setArtistStatementOpen(true), []);

  // The open room card, from right-click or long press. A modal dialog, so
  // the state is only which room or generic cell it names - there is no
  // anchor point, and a pan underneath the open card is harmless.
  const [card, setCard] = useState<CardState | null>(null);
  const onPick = useCallback(
    (px: number, py: number, camera: Camera) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = { width: canvas.clientWidth, height: canvas.clientHeight };
      setCard(roomAtPoint(px, py, camera, rect, layout, order));
    },
    [layout, order]
  );

  // The card's accessible name and story, from `describeCell` - the same
  // function that names listbox options. Computed here because `layout`,
  // `order`, and `metadata` are in scope here; the pick knows only its cell.
  const cardDescription = useMemo(
    () => (card ? describeCell(card.x, card.y, { layout, order, metadata }) : null),
    [card, layout, order, metadata]
  );

  // The catalog overlay's tile size in real pixels, read at scan time - see
  // `cardNaturalSize` below and RoomOverlay's `naturalSize` doc.
  const overlayNaturalSize = useMemo(() => {
    if (!overlay) return null;
    const room = manifest.rooms[overlay.id];
    return room?.w && room?.h ? { w: room.w, h: room.h } : null;
  }, [overlay, manifest]);

  // The card's tile image: a real room by id, a generic cell by the same
  // positional face `render.ts` draws for its cell (`layout.genericIndexAt`
  // must not depend on rank - see AGENTS.md). Level 0, the only level
  // `urlFor` can give an `<img src>`.
  const cardSrc = useMemo(() => {
    if (!card) return null;
    return urlFor('id' in card ? card.id : genericId(layout.genericIndexAt(card.x, card.y)), 0);
  }, [card, layout, urlFor]);

  // The same tile's real pixel size, resolved the two ways `cardSrc` is.
  // See RoomOverlay's `naturalSize` doc for why the pre-load placeholder
  // uses this rather than a shared aspect ratio.
  const cardNaturalSize = useMemo(() => {
    if (!card) return null;
    const asset = 'id' in card ? manifest.rooms[card.id] : manifest.shared?.generic?.[layout.genericIndexAt(card.x, card.y)];
    return asset?.w && asset?.h ? { w: asset.w, h: asset.h } : null;
  }, [card, layout, manifest]);

  // The ranked listbox: the `gradedCount` ranks the search's gradient
  // lifted above baseline - the cluster's size, and 0 for a uniform map.
  // This is the lossless channel: map position encodes rank and certainty
  // but not adjacency; the ranking encodes everything.
  //
  // Bounded twice: by `RESULTS_WINDOW` (a DOM budget) and by `cellOfRank` -
  // a rank that never landed a cell has nowhere to fly to, and with the
  // "rooms on the map" slider down that bound is the tighter one. `total`
  // still reports the real match count via `aria-setsize`.
  //
  // At `contentRatio: 1` this list is always empty, and that is the ratio
  // slider's own logic, not a bug here: the gradient has nothing left to
  // lift above the baseline, so a search cannot cluster anything.
  const searchResults = useMemo(() => {
    if (!result) return null;
    const total = Math.min(layout.gradedCount, RESULTS_WINDOW);
    const rooms = [];
    for (let rank = 0; rank < total; rank++) {
      const cell = layout.cellOfRank(rank);
      if (!cell) continue;
      // A rank past the end of the filtered `order` holds no room at all -
      // skipped rather than listed with no id.
      if (order[rank] === undefined) continue;
      rooms.push({
        id: order[rank], rank, x: cell.x, y: cell.y,
        name: describeCell(cell.x, cell.y, { layout, order, metadata }).name,
      });
    }
    return { rooms, total: layout.gradedCount };
  }, [result, layout, order, metadata]);

  // The tap handlers live behind refs: ref identity is stable, so the
  // camera's pointer listeners bind once, while the bodies assigned further
  // down are reassigned every render and close over `search`, `centreSlots`,
  // and `flyTo` - none of which exist yet at this line.
  const tapRef = useRef((_px: number, _py: number, _camera: Camera) => {});
  const onTap = useCallback((px: number, py: number, camera: Camera) => tapRef.current(px, py, camera), []);

  // A double tap zooms to fit the tapped room; a second on the same room
  // returns the camera from before it - the map's version of a photo
  // viewer's double-tap zoom. Same ref indirection as `tapRef` above.
  const doubleTapRef = useRef((_px: number, _py: number, _camera: Camera) => {});
  const onDoubleTap = useCallback(
    (px: number, py: number, camera: Camera) => doubleTapRef.current(px, py, camera),
    []
  );
  // The camera to return to on the next double tap of the same room, and
  // which room that is; null when no zoom is pending.
  const zoomToggle = useRef<{ cellKey: string; from: Camera } | null>(null);

  // `?touchdebug` puts the raw pointer stream on screen: gestures can only
  // be judged on a device, and a phone has no readable console.
  const onDebug = useMemo(() => (TOUCH_DEBUG ? appendTouchLog : undefined), []);

  // The page-load view: the center room's bookshelf framed to the display -
  // a fixed zoom would be too far out on a phone and too far in on a wide
  // monitor. Capped at the tile's native width so the page never loads
  // already upscaled (a reader can still zoom by hand to the 2x ceiling,
  // and the cap rises if the center tile ever earns a finer pyramid rung).
  // Computed once at mount; a later resize is the reader's camera to move,
  // not ours.
  const opening = useMemo(() => {
    const rect = CENTER_OPENING_RECT;
    const zoom = openingZoom(
      { width: window.innerWidth, height: window.innerHeight },
      { min: config.camera.minZoom, max: config.camera.maxZoom }
    );
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, zoom };
    // Intentionally empty deps: the opening view is a one-time mount decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { cam, flyTo, nudgeBy, flightTarget, isFlying } = useMapCamera({
    canvasRef,
    resistanceAt,
    onChange: requestDraw,
    camera: config.camera,
    opening,
    onPick,
    onTap,
    onDoubleTap,
    onDebug,
  });

  // Where the center tile is on screen, and what its overlays accept:
  // `usable` (partly on screen - what the render loop draws), `fullyUsable`
  // (entirely on screen - what `goToSearch` focuses rather than flying),
  // and `books` (on screen with legible spines - the book buttons are
  // tabbable only while a reader can see what they are named). Computed
  // once so the loop and the trigger share a definition of "usable". All
  // three are false during a rearrangement: the tile is drawn from the
  // animation's board, at a camera this function cannot see.
  const centreOverlay = useCallback(
    (w: number, h: number) => {
      const cellRect = centerCellRect(cam.current, { width: w, height: h });
      const box = searchBoxScreenRect(cellRect);
      const settled = !anim.current;
      return {
        cellRect,
        box,
        usable: settled && overlapsViewport(box, w, h) && isSearchBoxUsable(cellRect),
        // Stricter than `usable`: half a search box is worth drawing but
        // not worth focusing.
        fullyUsable: settled && fullyInViewport(box, w, h) && isSearchBoxUsable(cellRect),
        // No tab stop on a book whose title is illegible or off-display.
        books: settled && overlapsViewport(cellRect, w, h) && areSpinesLegible(cellRect),
      };
    },
    [cam]
  );

  // The panel's search affordance: focus the live field on the center tile
  // if it is fully usable, otherwise fly to the opening view and focus once
  // landed. A dropped flight (the reader grabbed the map mid-flight) leaves
  // focus alone. Defined here rather than with the search wiring below
  // because `useMapCursor` takes it for `/` - as a plain JSX prop, this
  // position costs no listener rebinding.
  const goToSearch = useCallback(async () => {
    const canvas = canvasRef.current;
    const input = searchFormRef.current?.querySelector('input');
    if (!canvas || !input) return;
    if (centreOverlay(canvas.clientWidth, canvas.clientHeight).fullyUsable) {
      input.focus();
      return;
    }
    // flyTo aims at a cell's middle (+0.5, via cameraAtCell); `opening` is
    // already a raw camera position, so cancel the offset here or the
    // flight lands half a cell short. Same reasoning in the double-tap
    // handler below.
    const landed = await flyTo(opening.x - 0.5, opening.y - 0.5, opening.zoom);
    if (landed) input.focus();
  }, [flyTo, opening, centreOverlay]);

  // `Escape` returns focus to the canvas from any center-tile control.
  // `Shift+Tab` can also reach it, but the controls in between are
  // conditionally rendered - the distance depends on zoom and features, so
  // Escape gives it as a fixed jump. The shelf binds `Escape` the same way
  // (`useCenterShelf.ts`).
  const focusCanvas = useCallback(() => {
    canvasRef.current?.focus();
  }, [canvasRef]);

  const onSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      focusCanvas();
    },
    [focusCanvas]
  );

  // `Escape` handler shared by the five plain center-tile buttons
  // (`.center-book`, reorder, the two sort toggles, the search trigger) -
  // they use no other keys, since activation is native click.
  const onControlKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      focusCanvas();
    },
    [focusCanvas]
  );

  // --- the keyboard cursor ---------------------------------------------------
  //
  // Everything about it - the cell, what gets said, and every key - is
  // `useMapCursor`. It is derived from the camera rather than tracked beside
  // it, so it goes in after `useMapCamera` and takes that hook's movers.
  const { cursorLabel, cursorEntry, cursorDesc, cursorId, onMapKeyDown, announceArrangement } =
    useMapCursor({
      layout,
      order,
      metadata,
      cam,
      canvasRef,
      flyTo,
      nudgeBy,
      flightTarget,
      camera: config.camera,
      setStatus,
      requestDraw,
      onOpenCard: setCard,
      goToSearch,
    });

  // --- switching between the two readings ----------------------------------
  //
  // The map is hidden, never unmounted: the camera and tile cache survive,
  // and so do useMapCamera's pointer listeners, which bind once against the
  // ref object - a remounted canvas would silently have none. See
  // `useModeTransition.ts` for the FLIP.
  const { mode, leaving, enterCatalog, exitCatalog, firstTileRef } = useModeTransition({
    canvasRef,
    cam,
    catalogConfig: config.catalog,
    onModeChange: useCallback(() => setCard(null), []),
    initialMode: INITIAL_MODE,
  });

  // The shelf's "forget searches" book wipes the whole wall at once.
  // Declared here because `useCenterShelf` below is its only caller.
  const forgetSearches = useCallback(() => setHistory([]), []);

  // The center room's bookshelf. Called here because two of the actions a
  // book runs - `enterCatalog` and `search` - must exist first.
  const { centreSlots, bookFocus, setBookFocus, onBook, onBooksKeyDown } = useCenterShelf({
    metadata,
    slotSeed: config.map.slotSeed,
    history,
    booksRef,
    canvasRef,
    setQuery,
    search,
    enterCatalog,
    setHelpOpen: useCallback((open: boolean) => {
      setHelpOpen(open);
      if (open) setShowHelpHint(false);
    }, []),
    forgetSearches,
  });

  // --- rendering -----------------------------------------------------------
  //
  // The frame loop is `useMapRenderer`/`useMapRendererGL`. `draw` stays here
  // because the tile cache above is built with `onLoad: requestDraw` - the
  // request must exist before the hook that fulfils it; one ref breaks the
  // cycle.
  //
  // The favorite badge's paint inputs - null with no store, so no badge is
  // drawn anywhere. Badges belong to the map: the catalog's favorite
  // control is DOM.
  const favoritesOverlay = useMemo(
    () => (favorites.enabled ? { isFavorite: favorites.isFavorite } : null),
    [favorites.enabled, favorites.isFavorite]
  );
  // config.center's auto-fit font range for spines. Memoized because
  // useMapRenderer's effect keys on the object's identity.
  const spineFontLimits = useMemo(
    () => ({ minPx: config.center.spineMinPx, maxPx: config.center.spineMaxPx }),
    [config.center.spineMinPx, config.center.spineMaxPx]
  );

  // --- the rearrangement animation -----------------------------------------
  //
  // useRearrangement owns whether a change animates, what plays while it
  // does, and what is said when it lands. `announce` is the exception:
  // which voice speaks depends on which reading is on screen, which lives
  // here. In the catalog it describes the list instead - the arrangement
  // sentence talks about clustering around a center the catalog has no
  // notion of.
  const announce = useCallback(
    (note: string) => {
      if (mode !== 'map') {
        setStatus(describeCatalog({ total: order.length, query: result?.term ?? '', note }));
        return;
      }
      announceArrangement(note);
    },
    [mode, order, result, setStatus, announceArrangement]
  );

  // Closes the useSearch <-> useRearrangement cycle discussed at
  // `requestAnimationRef`'s declaration.
  const { requestAnimation } = useRearrangement({
    layout,
    order,
    mode,
    canvasRef,
    searchFormRef,
    cam,
    flyTo,
    isFlying,
    requestDraw,
    config,
    anim,
    announce,
    cache,
    onPreparing: WEBGL ? onPreparingGL : undefined,
    loadingAnim,
    onPreparingChange: setPreparingRearrangement,
  });
  requestAnimationRef.current = requestAnimation;

  // --- distill mode ------------------------------------------------------------
  //
  // Hides every generic room and lets the corpus rooms already on the map
  // pack into the space, then reverses. `useDistillMode.ts` explains the
  // contentRatio flip behind it and what the fade adds.
  const { distillMode, toggleDistill, genericFade } = useDistillMode({
    defaultRatio: config.map.contentRatio,
    fadeMs: config.map.distillFadeMs,
    setContentRatio,
    requestAnimation,
    requestDraw,
  });

  useMapRenderer({
    canvasRef: WEBGL ? inertCanvasRef : canvasRef,
    searchFormRef, booksRef, searchArrowRef, centerBookRef, controlsRef, draw, anim, cam,
    mode, layout, order, renderer, slideRenderer, cache, centreSlots, spineFontLimits, centreOverlay, blockedCount,
    favorites: favoritesOverlay, favTooltipRef, sortMode, genericFade, distillMode, distillTooltipRef,
    loadingAnim,
  });
  useMapRendererGL({
    canvasRef: WEBGL ? canvasRef : inertCanvasRef,
    searchFormRef, booksRef, searchArrowRef, centerBookRef, controlsRef, draw, anim, cam,
    mode, layout, order, cache, centreSlots, spineFontLimits, centreOverlay, blockedCount,
    favorites: favoritesOverlay, favTooltipRef, sortMode, genericFade, distillMode, distillTooltipRef,
    warmTexturesRef, warmTimeoutMs: config.slide.prepareTimeoutMs, loadingAnim,
  });

  // After a favorite-triggered resort lands: if the room just favorited is
  // the one whose card is open, fly the camera to its new cell at the
  // reader's existing zoom - the resort may have moved it out from under
  // the card. A different room's card, or none, is left alone. A ref
  // reassigned every render because `onSettled` fires later, against the
  // `card` and `cellById` of that moment, not of the click.
  const onFavoriteRearrangedRef = useRef((_id: number) => {});
  onFavoriteRearrangedRef.current = (id: number) => {
    if (mode !== 'map' || !card || 'generic' in card || card.id !== id) return;
    const cell = cellById.get(id);
    if (cell) flyTo(cell.x, cell.y);
  };

  /**
   * One room's favorite state, in the shape `RoomDetails` wants; null for a
   * generic cell (no file to favorite) and null throughout when no store is
   * deployed. A function, not a map, so nothing assembles per-room state
   * for rooms nobody is looking at.
   *
   * Toggling requests the slide animation under a favorites sort: the
   * toggle changes `sortResult` - order and density - and useRearrangement
   * only animates a change a caller asked for. Under 'relevance'/'random'
   * the toggle moves nothing. `startRearrangement` zooms out in place, so
   * the reader's position survives; `onFavoriteRearrangedRef` handles an
   * open card when the resort lands.
   */
  const favoriteFor = useCallback(
    (id: number | null | undefined) =>
      favorites.enabled && id != null && id >= 0
        ? {
            on: favorites.isFavorite(id),
            count: favorites.countOf(id),
            toggle: () => {
              if (mode === 'map' && (sortMode === 'mine' || sortMode === 'count')) {
                requestAnimation('', { onSettled: () => onFavoriteRearrangedRef.current(id) });
              }
              void favorites.toggle(id);
            },
          }
        : null,
    [favorites.enabled, favorites.isFavorite, favorites.countOf, favorites.toggle, mode, sortMode, requestAnimation]
  );

  // A chip on a card is a live search. The card and the catalog overlay
  // close first: the map is about to rearrange, and each names a position
  // that would then hold a different room.
  const searchKeyword = (text: string) => {
    setQuery(text);
    setCard(null);
    // The overlay names a rank, and a search rebuilds the ranking - leaving it
    // open would have it describing a position that now holds another room.
    setOverlay(null);
    search(text);
  };

  // Choosing a ranked result flies the camera and opens the card, ordered
  // but not waiting on each other: the card's content is reachable the
  // instant this runs, and the flight is continuity for a sighted reader,
  // not a precondition for anyone else. This is the touch reader's path
  // into a room that right-click and long-press never gave them.
  const openRoom = useCallback(
    (x: number, y: number, id: number, rank: number) => {
      setCard({ id, rank, x, y });
      flyTo(x, y, overviewZoom(canvasRef.current, config.camera.minVisibleCells, cam.current));
    },
    [flyTo, config, canvasRef, cam]
  );

  // The catalog's own scroll position - not part of the mode transition, so
  // it stays here rather than moving into `useModeTransition`.
  const catalogScrollRef = useRef<HTMLDivElement>(null);

  // A canvas-sized box for overviewZoom. While the catalog is open the map
  // is `display: none` and reports 0x0, which shrinks the fit target to
  // nothing and clamps to the widest zoom-out there is; the viewport is the
  // size the canvas reports whenever it is shown (`#root, canvas { inset: 0
  // }`, both full width/height).
  const mapViewport = useCallback(
    (): { clientWidth: number; clientHeight: number } =>
      mode === 'map' && canvasRef.current
        ? canvasRef.current
        : { clientWidth: window.innerWidth, clientHeight: window.innerHeight },
    [canvasRef, mode]
  );

  /** A row's "show on the map" - aim the camera, then go and look. */
  const showOnMap = useCallback(
    (x: number, y: number) => {
      flyTo(x, y, overviewZoom(mapViewport(), config.camera.minVisibleCells, cam.current));
      exitCatalog();
    },
    [flyTo, config, exitCatalog, mapViewport, cam]
  );

  // The panel's map controls are handlers, not inline markup: a reorder is
  // seed bumps plus an animation request - machinery this file owns, not
  // something a presenter should know.
  //
  // A full reshuffle: it rerolls `seed` (which cells are content slots)
  // along with `orderSeed` (which room lands where), and drops the active
  // search and favorite sort - both are placement inputs the new scatter
  // would otherwise be laid out around. Leaving either in place would reroll
  // everything except the one thing the reader is looking at.
  // `startRearrangement` already treats a combined layout+order change as
  // one arrangement (a search makes the same two), so no new animation path.
  const reorder = useCallback(() => {
    requestAnimation('');
    setOrderSeed((s) => s + 1);
    setSeed((s) => s + 1);
    setSortMode('relevance');
    clearSearch();
  }, [requestAnimation, clearSearch]);
  // A sort change is a re-rank, not a rebuild: it swaps `order` and lets
  // the sliding-tile animation carry the map over. Only a search may rebuild
  // the layout, because only a search has a certainty profile to place by.
  const changeSort = useCallback(
    (next: SortMode) => {
      if (next === sortMode) return;
      // Entering 'random' draws a fresh shuffle, and clears an active
      // search: while one runs, `effectiveSortMode` reads 'random' as
      // 'relevance', so the shuffle would look like a no-op.
      if (next === 'random') {
        setRandomSortSeed(Date.now());
        if (result) clearSearch();
      }
      requestAnimation(describeSort(next, favoriteCount(manifest.rooms, favorites.mine)));
      setSortMode(next);
    },
    [sortMode, requestAnimation, manifest, favorites.mine, result, clearSearch]
  );

  // The center tile's favorites-sort switch works like a physical switch,
  // not a select: pressing the lit one returns to 'relevance'. That is what
  // lets `render.ts`'s two "on" faces be the whole state display - neither
  // lit means 'relevance'.
  const toggleSort = useCallback(
    (next: SortMode) => changeSort(sortMode === next ? 'relevance' : next),
    [changeSort, sortMode]
  );

  const rescatter = useCallback(() => {
    requestAnimation('');
    setSeed((s) => s + 1);
  }, [requestAnimation]);
  const recentre = useCallback(
    () => flyTo(0, 0, overviewZoom(canvasRef.current, config.camera.minVisibleCells, cam.current)),
    [flyTo, config, canvasRef, cam]
  );

  // Selecting a book on the center room. Off the center cell or on an empty
  // book, nothing happens - the tap is not otherwise claimed.
  tapRef.current = (px, py, camera) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = { width: canvas.clientWidth, height: canvas.clientHeight };
    const cell = centerCellRect(camera, rect);

    // The live search field: focus it. Checked before the books - it sits
    // above the shelf, never over a spine. Going through `onTap` (which
    // only fires for a genuine tap) is what lets a pan or pinch that
    // crosses the box's rect keep panning.
    if (searchBoxAtPoint(px, py, cell)) {
      searchFormRef.current?.querySelector('input')?.focus();
      return;
    }

    // The open book, in a shelf gap: outside the lettered runs
    // `bookAtPoint` walks, so it gets its own check before the books.
    if (centerBookAtPoint(px, py, cell)) {
      openArtistStatement();
      return;
    }

    // The reorder button - a fixed hotspot, checked before the books for
    // the same reason as the two above: it overlaps no spine.
    if (shuffleButtonAtPoint(px, py, cell)) {
      reorder();
      return;
    }

    // The favorites-sort switches - two more fixed hotspots, meaningless
    // without a store, hence gated where the reorder button above is not.
    if (favorites.enabled) {
      if (mineToggleAtPoint(px, py, cell)) {
        toggleSort('mine');
        return;
      }
      if (countToggleAtPoint(px, py, cell)) {
        toggleSort('count');
        return;
      }
    }

    // The distill toggle - another fixed hotspot, outside the gate above:
    // distill mode needs no favorite store.
    if (distillToggleAtPoint(px, py, { x: cell.w, y: cell.h }, cell.x, cell.y, distillMode)) {
      toggleDistill();
      return;
    }

    const slotIndex = bookAtPoint(px, py, cell);
    if (slotIndex != null) {
      onBook(slotIndex);
      return;
    }

    // A tap on a room's favorite badge toggles it - an ordinary room tile
    // has no other tap behaviour. `roomAtPoint` already excludes the center
    // cell (null) and generic cells, which have no badge.
    if (favorites.enabled) {
      const hit = roomAtPoint(px, py, camera, rect, layout, order);
      if (hit && !('generic' in hit)) {
        const cellPx = pxPerCell(camera);
        const { x: sx, y: sy } = worldToScreen(hit.x, hit.y, camera, rect);
        const hitRect = favoriteHitRect(cellPx, sx, sy, COARSE_POINTER);
        if (hitRect && pointInRect(px, py, hitRect)) favoriteFor(hit.id)?.toggle();
      }
    }
  };

  // The double-tap body: fit the room, or undo the fit (see `doubleTapRef`
  // above). `roomAtPoint` returns null for the center cell, so
  // double-tapping the shelf never fights the book taps above.
  doubleTapRef.current = (px, py, camera) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = { width: canvas.clientWidth, height: canvas.clientHeight };
    const hit = roomAtPoint(px, py, camera, rect, layout, order);
    if (!hit) return;

    const cellKey = `${hit.x},${hit.y}`;
    const toggle = zoomToggle.current;
    if (toggle && toggle.cellKey === cellKey) {
      zoomToggle.current = null;
      // Cancel flyTo's +0.5 cell-centering: `toggle.from` is already a raw
      // camera position (see `goToSearch`).
      flyTo(toggle.from.x - 0.5, toggle.from.y - 0.5, toggle.from.zoom);
      return;
    }

    zoomToggle.current = { cellKey, from: camera };
    const zoom = fitZoom({
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      target: { w: 1, h: 1 },
      aspect: camera.aspect ?? CELL_ASPECT,
      limits: camera.limits ?? { min: config.camera.minZoom, max: config.camera.maxZoom },
      margin: 0.92,
    });
    flyTo(hit.x, hit.y, zoom);
  };

  // `?debug`'s scripted runner, for perf/memory profiling: from a browser
  // console, `__babelDebug.run('some-seed')` replays a seeded, repeatable
  // random-usage session. `debugActions.ts` builds and dispatches the steps;
  // this object is where a step's abstract args (a delta, a factor, a room
  // id) resolve against the live camera/layout/cellById the way a real
  // gesture would - see that file's header for why the split exists.
  // Rebuilt unmemoized every render, like the tap handlers: cheaper than a
  // dependency array naming nearly everything in this hook.
  if (DEBUG) {
    const debugActions: DebugActions = {
      pan: (dx, dy) => nudgeBy(dx, dy),
      zoom: (factor) => flyTo(cam.current.x, cam.current.y, clampZoom(cam.current.zoom * factor, cam.current.limits ?? ZOOM_LIMITS)),
      search: (term) => search(term),
      favorite: (id) => favoriteFor(id)?.toggle(),
      enterCatalog: () => enterCatalog(),
      exitCatalog: () => exitCatalog(),
      book: (index) => onBook(index),
      reorder: () => reorder(),
      rescatter: () => rescatter(),
      sort: (mode) => changeSort(mode),
      distill: () => toggleDistill(),
      recentre: () => recentre(),
      openCard: (id) => {
        const cell = cellById.get(id);
        if (cell) openRoom(cell.x, cell.y, id, order.indexOf(id));
      },
      closeCard: () => {
        setCard(null);
        setOverlay(null);
      },
      goToSearch: () => goToSearch(),
    };
    (window as typeof window & { __babelDebug?: unknown }).__babelDebug = {
      actions: debugActions,
      buildSequence: (seed: number | string, durationMs = DEFAULT_DURATION_MS) => buildSequence(seed, durationMs, total),
      run: (seed: number | string, durationMs = DEFAULT_DURATION_MS) =>
        runSequence(debugActions, buildSequence(seed, durationMs, total), {
          mode: () => mode,
          onStep: (step, i, skipped) =>
            console.debug(`[babel-debug] ${i}: ${step.action}${skipped ? ' (skipped, catalog mode)' : ''}`, step.args),
        }),
    };
  }

  return (
    <>
      <MapView
        mode={mode}
        canvasRef={canvasRef}
        searchFormRef={searchFormRef}
        booksRef={booksRef}
        searchArrowRef={searchArrowRef}
        centerBookRef={centerBookRef}
        controlsRef={controlsRef}
        favTooltipRef={favTooltipRef}
        onOpenArtistStatement={openArtistStatement}
        manifest={manifest}
        total={total}
        described={described}
        status={status}
        query={query}
        setQuery={setQuery}
        onSearch={runSearch}
        onClearSearch={clearSearch}
        onSearchKeyDown={onSearchKeyDown}
        onControlKeyDown={onControlKeyDown}
        onGoToSearch={goToSearch}
        maxQueryLength={config.search.maxQueryLength}
        cursorLabel={cursorLabel}
        cursorEntry={cursorEntry}
        cursorDesc={cursorDesc}
        highlight={highlight}
        tagLinks={tagLinks}
        onMapKeyDown={onMapKeyDown}
        onKeyword={searchKeyword}
        centreSlots={centreSlots}
        showHelpHint={showHelpHint}
        bookFocus={bookFocus}
        setBookFocus={setBookFocus}
        onBook={onBook}
        onBooksKeyDown={onBooksKeyDown}
        searchResults={searchResults}
        onOpenRoom={openRoom}
        roomCount={roomCount}
        setRoomCount={setRoomCount}
        contentRatio={contentRatio}
        setContentRatio={setContentRatio}
        onReorder={reorder}
        onRescatter={rescatter}
        distillTooltipRef={distillTooltipRef}
        favorites={favorites.enabled}
        sortMode={sortMode}
        onToggleSort={toggleSort}
        favoriteFor={favoriteFor}
        cursorId={cursorId}
        onRecentre={recentre}
        history={history}
        onForgetSearches={forgetSearches}
        onEnterCatalog={enterCatalog}
        hasLoadingAnimation={hasLoadingAnim}
        onAnimationPreviewChange={setAnimationPreview}
        preparingRearrangement={preparingRearrangement}
      />

      {(mode === 'catalog' || leaving) && (
        <CatalogView
          config={config}
          urlFor={urlFor}
          order={catalogOrder}
          metadata={metadata}
          result={result}
          highlight={highlight}
          tagLinks={tagLinks}
          query={query}
          setQuery={setQuery}
          onSearch={runSearch}
          onClearSearch={clearSearch}
          paging={paging}
          setPaging={setPaging}
          onExit={exitCatalog}
          onShowOnMap={showOnMap}
          onKeyword={searchKeyword}
          onExpand={expandRoom}
          favorites={favorites.enabled}
          sortMode={sortMode}
          onSortMode={changeSort}
          favoriteFor={favoriteFor}
          centreSlots={centreSlots}
          onBook={onBook}
          onOpenArtistStatement={openArtistStatement}
          distillMode={distillMode}
          onToggleDistill={toggleDistill}
          cellOfId={(id) => cellById.get(id) ?? null}
          history={history}
          onForgetSearches={forgetSearches}
          note={
            result
              ? describeSignals(
                  result.signals ?? { clip: false, keyword: false, title: false, story: false },
                  Boolean(searchIndex)
                )
              : ''
          }
          scrollRef={catalogScrollRef}
          firstTileRef={firstTileRef}
          leaving={leaving}
          spotlightId={catalogSpotlightId}
          onSpotlightHandled={clearCatalogSpotlight}
        />
      )}

      {/*
        The app's one live region, outside both views: the panel is part of
        the map, so a region inside it would remount on every mode switch -
        and a screen reader loses a live region that goes away. What it says
        varies by mode; the node a reader is listening to never changes.

        `role="status"` announces every change to its subtree, so nothing
        else may share it; the map's static hint stays in the panel.
      */}
      <div className="live">
        <span role="status">{status}</span>
      </div>

      {overlay && mode === 'catalog' && (
        <RoomOverlay
          room={overlay}
          desc={describeRoom(
            overlay.id,
            overlay.rank,
            order.length,
            metadata?.[overlay.id] ?? null
          )}
          entry={metadata?.[overlay.id] ?? null}
          src={urlFor(overlay.id, 0)}
          naturalSize={overlayNaturalSize}
          onClose={() => setOverlay(null)}
          onKeyword={searchKeyword}
          highlight={highlight}
          tagLinks={tagLinks}
          result={result}
          weights={config.search.weights}
          favorite={favoriteFor(overlay.id)}
          shareSlug={roomSlugs[overlay.id] ?? null}
          view={(() => {
            const cell = cellById.get(overlay.id);
            return cell
              ? { label: 'show on the map', shortLabel: 'map', onClick: () => { showOnMap(cell.x, cell.y); setOverlay(null); } }
              : null;
          })()}
        />
      )}

      {helpOpen && (
        <HelpDialog
          onClose={() => setHelpOpen(false)}
          availableTags={availableTags}
          blockedTags={blockedTags}
          onToggleTag={toggleBlockedTag}
          blockedCount={blockedCount}
        />
      )}

      {artistStatementOpen && (
        <ArtistStatementOverlay onClose={() => setArtistStatementOpen(false)} />
      )}

      {card && cardDescription && (
        <RoomOverlay
          room={card}
          desc={cardDescription}
          entry={'id' in card ? metadata?.[card.id] ?? null : null}
          src={cardSrc}
          naturalSize={cardNaturalSize}
          onClose={() => setCard(null)}
          onKeyword={searchKeyword}
          highlight={highlight}
          tagLinks={tagLinks}
          result={result}
          weights={config.search.weights}
          favorite={'id' in card ? favoriteFor(card.id) : null}
          shareSlug={'id' in card ? roomSlugs[card.id] ?? null : null}
          view={
            'id' in card
              ? {
                  label: 'show in the catalog',
                  shortLabel: 'catalog',
                  onClick: () => {
                    setCatalogSpotlightId(card.id);
                    enterCatalog();
                    setCard(null);
                  },
                }
              : null
          }
        />
      )}
    </>
  );
}

/**
 * The most options the ranked listbox mounts at once - a DOM budget.
 * `gradedCount` is normally tens of rooms; this exists for the corpus where
 * it is not.
 */
const RESULTS_WINDOW = 50;

/**
 * Touch (coarse pointer) or mouse (fine), from one matchMedia call at module
 * load - same reasoning as `prefersReducedMotion` in useMapCamera.ts. On
 * touch, a favorite badge's tap target is padded out to
 * `MIN_FAVORITE_HIT_TOUCH`; a mouse stays precise.
 */
const COARSE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/**
 * `window.__INITIAL_ROUTE__` - set by `app.ts`'s `renderPage` only on the
 * SSR `/catalog` and `/catalog/:slug` routes (see index.html's
 * `%%INITIAL_ROUTE_SCRIPT%%`), absent on plain `/`. Read once at module
 * scope, so a visitor landing on one of those urls boots straight into the
 * matching interactive view instead of watching the server-rendered content
 * vanish when `bundle.js` takes over.
 */
declare global {
  interface Window {
    __INITIAL_ROUTE__?: { mode: 'catalog'; room?: string };
  }
}
const INITIAL_ROUTE = typeof window !== 'undefined' ? (window.__INITIAL_ROUTE__ ?? null) : null;

/**
 * Which reading the page opens on: `?catalog`, or `INITIAL_ROUTE.mode` on a
 * server-rendered url. Read once at module scope, read-only thereafter: the
 * toggle never writes the param back, so there are no history entries to
 * design and no way for the address bar and the page to disagree.
 */
const INITIAL_MODE =
  INITIAL_ROUTE?.mode === 'catalog' ||
  (typeof location !== 'undefined' && new URLSearchParams(location.search).has('catalog'))
    ? 'catalog'
    : 'map';

/**
 * `?blockTags=a,b,c` - sensitive-content tags to exclude from the map and
 * catalog, read once at module scope. It only ever seeds the stored choice
 * (`KEYS.blockedTags`): a reader who has already chosen tags in HelpDialog
 * keeps them, and a fresh browser following a shared link starts blocked as
 * the link asks.
 */
const URL_BLOCKED_TAGS: string[] =
  (typeof location !== 'undefined' ? new URLSearchParams(location.search).get('blockTags') : null)
    ?.split(',')
    .map((t) => t.trim())
    .filter(Boolean) ?? [];

const rootEl = document.getElementById('root');
if (rootEl) createRoot(rootEl).render(<App />);
