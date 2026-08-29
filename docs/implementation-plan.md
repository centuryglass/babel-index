# The Index of Babel — implementation plan

Pending task list. Remove tasks as they are completed, the code and git logs will
serve as completed task history.

## Map interface:
 - Inpaint the "Catalog" volume in the center tile to give it a more
   distinctive appearance.

## Search:
- The target behavior is now specified in `search_rules.md`; the gap between it
  and the code, and the steps to close it, are in `search-plan.md`. Work the
  search rework from there rather than restating it here.
- Decide on a user-friendly way to present search ranking and certainty to
  users in the catalog mode (`search-plan.md` §5.4 covers the signed-certainty
  rendering; this is the broader "what does the catalog show" question).


## A11y:
- Add alt text:  The corpus supports alt text but doesn't have it yet.
  Generate via a cheap local LLM, validate, add to metadata under
 [filename]['alt'].
- No actual screen reader testing has happened yet. Learn orca and test
  manually. See accessibility-plan.md for more details on what to check, and
  other lingering questions.
- The ranked results listbox (accessibility-plan.md §3.2) now lives in the
  dev panel, which is `?debug`-only. Give it a non-debug home before this
  matters for anyone relying on the lossless reading of a search.

## Hosting:
- Price out what it'll cost to host somewhere I can target with Terraform CD,
  compare with the hassle of just kludging it onto my VPS with other projects.
- The CORS follow-up for `--remote` mode is done: `infra/r2.tf`'s
  `cloudflare_r2_bucket_cors` (schema confirmed against the provider version
  pinned in `versions.tf`) covers `embeddings.bin`/`metadata.json`'s
  cross-origin `fetch()` calls. Set `app_origins` in `terraform.tfvars` and
  apply before relying on `--remote` mode in production - not yet applied or
  tested against a real Cloudflare zone.
- The Cloudflare abuse protection in `infra/abuse-protection.tf` only scopes
  `assets_hostname` (the R2 bucket). `/api/search` is a much better DoS target
  than static asset serving - it's CPU-bound ML inference on an unprotected
  origin. Add a second ruleset (rate limit + short-TTL cache keyed on the
  query string) scoped to the app's hostname for that endpoint specifically.

## Architecture:
- **`checkJs` is on.** `jsconfig.json` (project-wide, `skipLibCheck`, JSX via
  `react-jsx` since the app uses the automatic runtime) plus `npm run typecheck`
  (`tsc --noEmit`) and `typescript`/`@types/{node,react,react-dom,express}` as
  devDependencies. Not wired into CI yet - it's a local signal for now, same
  spirit as `npm run lint`.
  - First run surfaced two real JSDoc bugs, now fixed: an `import('../../map/
    metadata.js')` / `scoring.js` type reference off by one `../` in
    `useCorpus.js`/`useSearch.js` (silently resolved to nothing, so the linked
    type was never checked), and a `@returns {MapLayout}` in `ordering.js`
    referencing a typedef that was never declared anywhere. Also gave
    `packages/map/metadata.js` a real `RoomMeta` typedef (`joinMetadata` was
    typed as returning `(object|null)[]`, so every downstream reader of a
    room's `keywords`/`story`/`alt` was checked as `object` and silently
    unchecked), and added the `slide`/`catalog` sections `resolveConfig`
    (`config.mjs`) actually returns but its `@returns` didn't mention.
  - After those fixes, ~227 diagnostics remain (`npm run typecheck` to see
    them), almost all the same root cause repeated: hook/function params
    documented as `@param {object} opts` rather than a typed shape, so every
    property and every `.current` read off a ref inside comes back as
    `TS2339` on bare `object`. Heaviest concentrations: `useMapRenderer.js`,
    `slide.js`, `useRearrangement.js`, `tiles.js`, `useMapCursor.js`,
    `useMapCamera.js`, `main.jsx`, `scoring.js`. A few other shapes worth
    knowing about before writing more JSDoc: `useRef(fn)` for a stable-identity
    ref reassigned later (`main.jsx`'s `tapRef`) infers the ref's type from the
    initial closure, not what it's reassigned to, so calls through it come back
    arity-mismatched; a `@param {unknown} raw` narrowed by `typeof x ===
    'object'` still can't be property-accessed without a cast (see
    `normaliseEntry`'s `entry` pattern) because TS's `object` is deliberately
    property-less; asset imports (`.svg`) and CSS custom properties in style
    objects need a small `.d.ts` if imports of them should typecheck at all.
  - So: the JSDoc that exists is basically accurate where it names a real
    type, and wrong or absent in the two ways above. Confirms the plan below -
    typing the data protocols (`RoomMeta`/`MapLayout` now exist; `Manifest`,
    `SearchResult`, `Move`, `Rearrangement`, `Config` don't yet) is where
    `checkJs` earns the most, cheaply, for the size of file it clears.
- **Decided: migrating to TypeScript, file by file.** See AGENTS.md's
  TypeScript bullet for the two file kinds (pure type contract vs. real
  module) and how each runs. All of the data protocols called out early on -
  `Manifest`/`Room` (`packages/map/manifest.ts`), `Config`
  (`packages/config/config.ts`), `Move`/`Rearrangement`
  (`packages/map/moves.ts`), and `SearchResult` (`packages/map/searchResult.ts`,
  `rankHybrid`'s return shape plus `useSearch.js`'s `result` state) - are now
  typed. `packages/server/port.ts` proved out the real-module conversion path
  (`build/`'s Node loader hook); `packages/server` is now fully converted, and
  so is `packages/map` except for `scoring.js`. `ordering.js`, `board.js`,
  `illusion.js` and `describe.js` converted to `.ts` alongside that package's
  existing type contracts, with `MapLayout` now a real interface
  (`ordering.ts`) rather than a JSDoc typedef. `metadata.js` converted too,
  once its keyword shape was tightened to `{text, type}` only (dropping the
  plain-string form it used to also accept) - at that point `RoomMeta` was
  already a real, fixed shape and there was nothing left to defer. Application
  logic converts opportunistically, not on a schedule; the deliberately loose
  shapes called out in AGENTS.md (`scoring.js`'s duck-typed ranking arrays,
  `center.js`'s `RUNS`, the animation state in `slide.js`) are the
  ones to leave for last, once there's a real type worth writing for them.
  `camera.js` turned out not to be one of those - it's pure math over a fixed
  `Camera`/`Flight` shape with no duck-typing to defer - so it's now
  `camera.ts`, with `Camera`, `ZoomLimits`, `Flight`, `FlightState` and
  `CursorGranularity` as real exported types other modules can import instead
  of restating a subset inline (`picking.ts` and `useModeTransition.ts` still
  carry their own narrower local `Camera` interfaces; unifying those is a
  follow-up, not required for this conversion since they're structurally
  compatible). `useMapCamera.js` converted right after, for the same reason -
  the pointer plumbing is DOM-typed (`PointerEvent`/`WheelEvent`/
  `HTMLCanvasElement`) rather than duck-typed, and it consumes `camera.ts`'s
  new `Camera` type directly. Fixed twelve pre-existing `checkJs` diagnostics
  in the same file and in `main.jsx`'s call site along the way (untyped
  `object` params/refs coming back as real shapes).

## TypeScript migration - remaining `.js`/`.jsx`/`.mjs` files:
Not a schedule - convert one when you're already touching it or it's a clean
opportunity, per AGENTS.md. Roughly ordered easiest/most-isolated first,
deliberately-loose shapes last; `CatalogView.tsx`/`MapView.tsx` (converted
from `.jsx`, prop types from `map/manifest.ts`'s `Manifest`,
`config/config.ts`'s `Config`, `map/describe.ts`'s `Description`,
`map/metadata.ts`'s `RoomMeta`, `map/searchResult.ts`'s
`SearchResult`/`MatchRange`, and `lib/rooms.ts`'s `UrlFor`; a `Slot` type
local to both files for `center.js`'s still-untyped `assignTitles()` return
shape. Also tightened `useSearch.js`'s `setQuery`/`runSearch` JSDoc from
`Function`/`(e: Event) => void` to `(query: string) => void`/React's
`FormEventHandler<HTMLFormElement>`, which the stricter prop types surfaced
as a mismatch - the same pattern as `RoomCard.tsx`'s `highlight` fix below.
`manifest.directory` picked up an `?.` in `MapView.tsx`'s panel heading:
`Manifest.directory` is optional (absent for a remote manifest), which the
old untyped prop silently let through unguarded) are the most recent
conversions. `RoomDetails.tsx` (converted from `.jsx`,
same type sources as its callers below - `RoomMeta`, `Description`,
`SearchResult`/`MatchRange`, `Config['search']['weights']` - plus its own
internal `Highlight`/`ClipCertainty`/`ScoreBreakdown` helpers typed in
place; `explainScore` stays imported from `scoring.js` untyped, since that
module is one of the deliberately-loose ones left for last) came before
that. `RoomOverlay.tsx` (converted from `.jsx`, same prop
types as `RoomCard.tsx` below - `Description`, `RoomMeta`,
`SearchResult`/`MatchRange`, `Config['search']['weights']` - `room` typed
inline as `{id, rank}` since that's exactly the shape `main.jsx`'s
`expandRoom` builds, nothing more) came before that.
`HelpDialog.tsx`/`RoomCard.tsx` (converted from `.jsx`, types from
`picking.ts`'s `RoomPick`, `map/describe.ts`'s `Description`,
`map/metadata.ts`'s `RoomMeta`, `map/searchResult.ts`'s
`SearchResult`/`MatchRange`, and `config/config.ts`'s `Config` - also tightened
`useSearch.js`'s `highlight` JSDoc from `Function` to the real range-finder
signature, which the stricter `RoomCard` prop type surfaced as a mismatch)
came before that. Test files (`*.test.mjs`) travel with
their module when it converts and aren't listed separately.

Hooks with real, nameable shapes (`Manifest`/`SearchResult`/`Config` etc.
already exist as types to write these against; `useCorpus.js`, `useSearch.js`,
`useModeTransition.js`, `useCenterShelf.js`, `useMapCamera.js`,
`useMapCursor.js`, `useMapRenderer.js` and `useRearrangement.js` already
converted - `useMapRenderer.ts` names `SlideRenderer`/`SlideStats` locally
since `slide.js` stays untyped, but now imports `RoomRenderer`/`DrawResult`
from `render.ts` directly rather than restating them, now that the file is
typed; `RunningAnim` (the shape `useRearrangement.ts` builds into the `anim`
ref) is exported from `useMapRenderer.ts` instead of restated, since that hook
already named it and both read/write the same ref). None left in this bucket -
the rest are the deliberately-loose files below.

`render.js` also converted, once a look at it turned up that its remaining
ambiguity wasn't deliberate looseness so much as convenience predating the
TypeScript decision - `RoomAtResult` (`ordering.ts`) and `Camera` (`camera.ts`)
already existed to type its `layout`/`cam` params, and the two real gaps were
small: `RoomId` (`number | string`) was declared but not exported from
`tiles.ts` (now `export type`), and its own 2d-context parameter had never had
any type at all. Rather than pull in the whole DOM `CanvasRenderingContext2D`
- which `render.test.mjs`'s recording fake was never going to implement in
full - `render.ts` names `DrawContext`, the narrow slice of the 2d context API
this file actually calls (`fillStyle`/`strokeStyle`/`lineWidth`/`font` plus
`fillRect`/`strokeRect`/`fillText`/`drawImage`), with `fillStyle`/`strokeStyle`
typed as the real context's `string | CanvasGradient | CanvasPattern` and
`drawImage`'s image parameter as `LoadableImage | CanvasImageSource` - both
purely so a real context still satisfies the interface structurally, since
this file only ever assigns/passes the narrower half of each union. A real
`CanvasRenderingContext2D` and the test's fake both satisfy `DrawContext`
as-is, so nothing changed at either call site. `centreSlots` keeps the same
`ReturnType<typeof assignTitles>[number]` local-derivation trick
`useMapRenderer.ts`/`useCenterShelf.ts` already use for the same reason
(`center.js`'s `assignTitles` is one of the deliberately-loose files below,
not itself converted here). `render.test.mjs` converted alongside it, per the
paired-test rule - the fake context and fake image objects are now typed
against `DrawContext`/`LoadableImage` explicitly rather than left for `tsc` to
infer, which is what surfaced the two union-widening fixes above.

Deliberately loose today (see AGENTS.md) - convert once there's a real type
worth writing rather than an `any`/`object` that just papers over it;
`main.jsx` last since it wires every hook above together and is only as
typeable as they are (`camera.js` converted - see above; it wasn't actually
one of these):
 - `packages/web/src/lib/slide.js`
 - `packages/web/src/lib/center.js`
 - `packages/map/scoring.js`
 - `packages/web/src/main.jsx`

## Other:
- Config variables are still mostly untuned, make sure to take care of that.
- Fonts and text rendering are unpolished, try some alternatives. The
  (uncommitted) font-lab tool can help.
- **Check the in-tile search field on an actual iOS device.** Its font size
  is whatever `.center-search input` inherits (13px, the app's body size),
  well under the ~16px that keeps iOS Safari from auto-zooming the viewport
  on focus. The page's `maximum-scale=1, user-scalable=no` viewport meta
  likely suppresses that already, but it needs testing.
- Should users be able to constrain search to CLIP/keyword/story only?
  Wouldn't be hard to insert some toggles.
