# Comment refactor plan

A standing work plan for rewriting this repository's code comments to the
house style. It is meant to be read at the start of any session that is doing
a comment pass, so that the work is repeatable and does not have to be
re-derived each time.

Companion doc: [`claude_critique.md`](claude_critique.md) — the *diagnosis*.
This file is the *process*: what we're doing, the problems to fix and how, the
running list of files, the verification tool, and gotchas.

## 1. What we're doing, and why

The bulk of this codebase's comments were written by Claude (the model), and
the style reads poorly: correct, but written as advocacy — briefs arguing a
design to a skeptic — when a reader needs reference — signage stating what is
true, fast. It sabotages skimming in specific, nameable ways (catalogued in
`claude_critique.md`).

The fix is a second pass over every code file that **rewrites comment text
only and never touches code**, moving each comment toward: rule first, one
fact one home, pinned to a declaration, plain declaratives, length
proportional to risk. Two passes are committed as exemplars:

- `main.tsx` (db67cbe) — the archetype: every failure mode present.
- `illusion.ts` (10bf4c8) — the nuance: a file where heavy commentary is
  *mostly earned*, so the pass is narrower (dedup + de-shout, not compress).

167 code files total (107 sources + 60 tests/specs), plus two CSS/HTML files
tracked separately since neither has a test to pair with; the running checklist
in §4 is the source of truth for how many are done. That is far more than one
session, so it proceeds in batches. This document tracks the queue and the
method.

Scope: JS/TS sources under `packages/`, `tools/`, `build/`, and their tests,
plus `packages/web/index.html` and `packages/web/style.css` - §5's verifier
covers all four via `tools/comment-check/strip.mjs`'s per-extension dispatch
(a real parser for JS/TS, a hand-rolled comment scan for CSS/HTML).

Bug-fixing and deep code analysis are outside of the scope of this plan, but
a pass of this breadth is likely to incidentally find bugs, design oversights,
code smells, and other problems that will need to be resolved eventually. Any
such discoveries should be recorded in docs/pending_task_list.md.

## 2. Common problems and how to fix each

Distilled from `claude_critique.md`'s eight mechanisms, the two committed
passes, and five other models' independent critiques (folded into §2b). Each is
a **tell** (how to spot it) and a **move** (what to do), listed in the order that
tends to pay off.

**P1 — A fact told many times (mechanism 5).** *Tell:* the same rationale, in
slightly different words, in ≥2 places; you finish a sentence before you start
it. In `illusion.ts` the "park a whole batch before feeding it" argument
appeared five times. *Move:* pick the one structural home (usually where the
thing is *defined*), state it fully there, and replace the others with either
silence or a four-word pointer ("see the staging note above"). This is the
highest-value move on most files.

**P2 — Lede buried (mechanism 1).** *Tell:* line 1 of a comment is scene-setting
and the operative rule lands in the last clause. *Move:* make line 1 a
standalone summary; a reader who stops there must lose no invariant. In `main.tsx`
this was pervasive; in `illusion.ts` it was mostly already fine — check, don't
assume.

**P3 — Arguing with ghosts (mechanism 3).** *Tell:* the comment defends against
an alternative that is not in the file ("rather than X," "would only drift,"
"the original behaviour"). AGENTS.md names the past-tense variant specifically.
*Move:* separate the two things hiding here. A **standing hazard** ("must not
depend on rank," "the wrap is only safe because it's off-camera") is a real
regression guard — keep it, as the main clause. A **counterfactual about a design
never built** — delete. `illusion.ts` had exactly one such ghost; a comment
referencing a prior implementation is almost always this.

**P4 — Uniform emphasis and counterfeit SHOUTING CAPS (mechanism 2).** *Tell:*
every comment is the same length/volume, so importance is smuggled in as
`CAPITALS`; when nine comments each promote one word, the capitals carry no
signal. *Move:* demote caps to normal prose; where the caps marked a genuine
contrast, carry that contrast with structure instead (a list item, a leading
clause). Reserve any surviving emphasis for a real hazard.

**P5 — Comments painted on regions (mechanism 7).** *Tell:* a multi-topic
paragraph describing a *neighborhood* of code, or a doc block for a function
that moved away from it (the orphaned `?`-key block in `main.tsx`). *Move:* one
comment, one declaration below it; split any paragraph that describes more than
one thing and re-attach each piece. A pinned one-line comment moves with its
code or visibly goes wrong; a region paragraph quietly becomes a confident lie.

**P6 — Hypotaxis / dash run-ons (mechanism 4).** *Tell:* a single sentence doing
the work of five, with `" - "` as a universal joint. *Move:* one clause per
sentence/dash; break list-shaped content into an actual list. Don't over-apply —
dashes doing honest parenthetical work are fine.

**P7 — Narrator voice (mechanism 6).** *Tell:* phrasings whose job is style
("a bounded handful," "without admitting that…," "robbed," "cannibalized") and
conviction adverbs (`exactly`, `really`, `precisely`, `never`, `on purpose`).
*Move:* rewrite as plain declaratives, keeping the concept the flourish was
decorating. This is the lowest-priority fix — it costs reader trust slowly —
but it's cheap when you're already in the sentence.

**P8 — Inverted cost (mechanism 8).** *Tell:* comment bulk tracks writer interest,
not code risk; obvious `useState`s get 15-line justifications. *Move:* compress
low-risk commentary toward ≤3 lines. **But the inverse trap is real:** in a file
of genuinely subtle logic (`illusion.ts`, `scoring.ts`, `ordering.ts`), long
commentary is often *earned* — a competent reader will otherwise write a bug.
The test is never "is this long?"; it is "would deleting this clause let a
careful reader introduce a real bug?" If yes, the length stays. The main.tsx
pass compressed aggressively; the illusion.ts pass mostly did not — same rules,
opposite dominant move. Know which file you're in (§3, step 2).

## 2b. Extra patterns from the model bake-off

`docs/comment-revision-tests/` holds five other models' critiques + main.tsx
revisions plus a meta-analysis. Their diagnoses converge with the eight
mechanisms above, so nothing replaces P1–P8 — but a few sharpen them, and one
formatting idea (union-alpha's) is worth adopting because it is *already* a
house convention. These are folded into the same pass; the source model is named
where it is the clearest articulation.

**Local completeness — the root of P1 and P5.** (GLM's framing is the sharpest:
Claude's comments are "sequentially dependent, not locally complete.") A comment
written as a *delta on the comment above it* ("the same treatment as the two
overlays above") is unreadable on arrival mid-file, which is how people actually
read. *Move:* every comment must parse with no other comment open; state the
shared scheme once (in the section header or the first sibling) and let later
siblings carry only their own subject; a pointer names a **symbol or section
label, never a position** ("see `booksRef`" / "see *Primitives* above", never
"see the one above"). This is also what stops P5 region-paint: positional
prose rots the moment code moves.

**Prose that rots — literal facts where a symbol reference would stay true.**
(GLM's "prose that rots"; and union-alpha, otherwise the bake-off's best
revision, *re-introduced* a reference to the nonexistent `positionSearchBox` —
the cautionary tale.) Hardcoded counts and claims age badly and many are already
wrong: "the forty buttons" (that's generated `BOOK_COUNT`), "one of the two
things that survive a reload" (at least four persist), `persist.js` (it's
`.ts`), and a range restated beside the field that sets it — `sheets.ts` opened
with "Levels 2-4", where `SHEETS.fromLevel` was 3 and the ladder has six rungs.
The pipeline batch also carried four `.js`/`.mjs` filenames the TypeScript
conversion left behind (`pyramid.js`, `mips.mjs`, `metadata.js`, `scan.mjs`), so
the extension tell is worth grepping in *any* comment, not only after a `see`.
*Move:* reference the symbol, not its current value ("the buttons in
`BOOK_COUNT`"); drop self-counting claims ("one of the two"); and **every
cross-reference must resolve to something that exists** — verify a `see X` before
committing, because a dangling pointer is exactly the confident-looking lie P5
warns about. Cheap tells to grep for: `the two things`, `the forty`,
`\.(js|jsx|mjs)\b` anywhere in a comment, and any `see \`([a-zA-Z]+)\`` whose
name `grep`s to nothing. The search-half batch (2026-09, a parallel checkout)
showed the worst variant: prose that restates an *enumeration or formula*
computed nearby goes quietly stale when the code grows. `scoring.ts` said
"five-constant" for a seven-constant weights shape, "three more independent
sorts" for four axes, listed three axes where `explainRanking` reports four,
and carried a soft-OR formula missing the `Kt` factor the code multiplies; a
dead symbol name (`explainScore`) had propagated into three files at once.
When a comment counts, lists, or restates a formula, check it against the
declaration in the same breath, and prefer naming the symbol over the count.

**Doc pointers rot fastest of all.** (`nextRoom.ts` said `accessibility-plan.md
§4.2a`; that section has not existed since a4eb2ae culled and restructured the
doc, and the same commit deleted `docs/catalog-plan.md` outright while four files
went on citing its `§2` and `§7`.) Plan docs are *ephemeral* by design —
`concept.md` is explicitly not kept in sync, and a task list entry leaves by
being done — so a section number into one is a fact with an expiry date. A
*quotation* from one rots the same way and reads as more authoritative while it
does: `config.ts` said `0.2 is the concept's "maybe 80% generic"`, and
`concept.md` never gave a percentage (it says "A configurable percentage") — the
phrase was a paraphrase that had hardened into a quote, and the number it quoted
had since changed to 0.25. *Move:* when the pointer you are checking no longer
resolves, **delete it and keep the sentence's claim**, rather than renumbering
it; the renumber just rots again at the next cull. Two exceptions. A pointer into
a doc AGENTS.md calls a *spec* — `search_rules.md`, which it says to update
alongside a scoring change, and `keyboard-controls.md` — is durable, and a named
*section title* there (`docs/search_rules.md "Story matching"`) survives a
renumber where a `§4.2a` will not. And a pending-task pointer is fine when it is
a live TODO anchored at that exact spot, the "see the pending entry for details
on this right here" shape, because it gets cleaned up as the issue does; a
pointer to an entry that has already shipped, or to one whose fix will not touch
this line, is the same dead `§4.2a` in a different costume. Tells to grep for:
`§[0-9]`, `docs/`, `\.md` inside a comment, and a quoted phrase attributed to a
doc — check the doc still contains it.

**A comment can state behaviour the code does not have.** Distinct from
prose-that-rots, which was once true: this class was never true, and it is the
one a comment pass cannot catch — the verifier proves the code did not change,
so a wrong claim survives a green run with more confidence behind it. Three in
`tools/center-placement/import-shelf-svg.ts`: "S/Q/T are refused rather than
silently mishandled" (they are not in the tokenizer's command set at all, so the
letter is dropped and their numbers read as repeated pairs of the previous
command, and the `PATH_ARG_COUNT` throw below it is unreachable); "`A(rc) is
unsupported`" (`A` is supported, as a lineto to its own endpoint); and `attr()`'s
unanchored `\b`, which no comment mentioned and which returns a rect's
`stroke-width` for `width` whenever that presentation attribute comes first in
the tag. *Move:* when a comment says the code *refuses*, *requires*, *enforces*
or *never* does something, read the branch it claims or run it before keeping the
sentence — cheap in a tools tree, where the input is a text file you can edit into
a repro. Then per AGENTS.md's bug rule: correct the comment to the truth, and file
the gap when the code is what is wrong (both of this file's findings are in
`docs/pending_task_list.md`'s "Tools"). The claim travels, so check where it is
quoted: `svgPath.ts`'s `flattenPath` carried the importer's false one until
its own pass corrected it to the code's actual behaviour (documented rather
than fixed; the importer-side fix stays in the pending entry).

**A rationale whose premise moved elsewhere.** A comment can state its rule
correctly and still be false because it reasons from what *another* file wants.
`cosine-stats.ts`'s header argued at length what `search.density.clipLow` "wants"
— a high percentile of the overall distribution — while `CLIP_CERTAINTY` and
`docs/search_rules.md` had long since moved to anchors read off known-outcome
keyword lists, so the file's whole first section explained a calibration nobody
used, in the present tense. *Move:* when a comment names another module's field,
constant, or doc, read that thing rather than trusting the comment's paraphrase
of it, and rewrite the comment around what the consumer now asks — keeping any
part of the old reasoning that is a live hazard (there it was "a common word
genuinely true of many rooms scores below a whole-list percentile cutoff", which
belongs on `suggestClipBounds`, the function that still computes it).

**One abstraction level per comment.** (Gemini's "entanglement of abstraction
levels.") A single sentence that swerves from product metaphor ("the library is
round") to DOM mechanics (`pointer-events: none`) to React lifecycle to repo
meta-history ("plan §4.2b") forces a context switch every clause. *Move:* keep
each comment in one register; the *why* is usually one level, not four stapled
together.

**What belongs in a code comment at all.** (GPT Luna's "miniature design
documents.") A local comment answers up to three separable questions — *what is
this for*, *what invariant holds*, *why is that non-obvious* — and often doesn't
need all three. Broad, cross-cutting policy belongs in the **owning module or in
AGENTS.md**, not restated at each use; a test-only caveat belongs **in the test**.
*Move:* if you're writing the fourth paragraph about a five-line `useState`, one
of those facts probably wants a different home (this is P1's "one fact one home"
read outward, to files rather than lines).

**Terse has a floor.** (The meta-analysis rates Gemini's cuts the most aggressive
and Union Alpha's the best read, precisely because it pruned prose *and kept every
hazard*.) Compressing is not the goal — skimmable is. Deleting a hard-won
justification to hit a line count is the one failure worse than a wordy comment.
When a hazard and a target length collide, keep the hazard (this is the P8 test,
run the other direction).

## 2c. Formatting toolbox

Two devices from the bake-off that are worth reaching for — and, critically,
**both are already house convention**, so adopting them is consistency, not
novelty (`illusion.ts` uses dividers throughout; ~47 files open with a doc block).

- **File-level preamble.** A short `/** */` at the top saying what the module is
  and how it's organized, for files that lack one — `main.tsx` opens straight on
  its imports and has none, so a 1,400-line entry point gives a first-time reader
  no map. Add one when a file is big or has non-obvious internal structure.
- **`// --- Section name ---------` dividers.** Name the regions of a long file
  so navigation is scannable (`// --- Settings and persistent reader choices
  ---`). Use them where a file has more than a handful of unrelated declaration
  clusters; don't sprinkle them on small files where every declaration is its own
  section. Keep the style consistent with `illusion.ts`.

Labeled hazard/invariant tags (`Hazard:`/`Invariant:`, from Gemini) are the one
device *not* adopted: the repo states hazards as the main clause of the sentence,
and half-adopting a tag vocabulary is worse than none. Revisit only as a
repo-wide convention if a future pass ever has the appetite.

## 3. The per-pass workflow (definition of done)

Run this every session. Steps 4, 6 and 7 are what make a pass trustworthy.

1. **Pick a batch** from §4 (follow the recommended order; keep
   cross-referencing files in one batch). Announce which files, and check the
   box for each when done.
2. **Read the file end-to-end first.** Note where the ledes are, where facts
   repeat, and — critically — which long comments are earned hazards (P8).
   Re-read the relevant `AGENTS.md` "Things that will bite you" bullets; those
   invariants must survive the rewrite verbatim in substance.
3. **Edit comments only.** Apply P1–P8 and the §2b sharpenings; reach for the
   §2c formatting devices (preamble, section dividers) where a file needs a map.
   Preserve every fact and hazard; never delete information to save space —
   relocate or condense it. Never touch a functional comment (an
   `eslint-disable`, `@ts-*`, `@license`, or a directive the toolchain reads) —
   those are code, not prose.
4. **Verify no code changed** — §5's tool, `check.mjs`, on every file touched.
   Must report `OK (comment-only)` or `clean (unchanged)` for all of them.
   This is not optional; it caught a dropped `rows.sort(...)` line during the
   illusion.ts pass that hand-review had missed. It is also what catches a
   deleted `eslint-disable` pragma, since stripping it changes emitted code.
5. **Run the gates:** `npm test`, `npm run lint`, `npm run typecheck`. (These
   also catch a comment edit that broke a `@example`-style fenced block or an
   unused-var reference from a removed doc line.)
6. **Check every cross-reference resolves.** Grep the file for `see \``,
   "see <Name>", literal claims ("the two things", a raw count), and doc
   pointers (`§[0-9]`, `\.md`) — then confirm each named symbol/file still exists
   (`grep -rn`), each literal was replaced by a symbol reference, and each doc
   still has the section cited. Union-alpha's otherwise-best revision shipped a
   dead `positionSearchBox` pointer; this step is the net for that, and for the
   `accessibility-plan.md §4.2a` class of rot that outlives its doc's last cull.
7. **Self-check the diff** — read `git diff` for the file once more; confirm
   every changed line is a comment line and the prose follows the house rules
   (ASCII hyphens in comments, single quotes, two-space indent, no "used to").
8. **Commit** — comments-only in the message, name the dominant moves, cite
   that the verifier showed byte-identical code. Update §4 boxes in the same
   commit.

## 4. Running list of files to pass

Legend: `[x]` = comment pass done · `[ ]` = not yet · indentation shows a source
file's paired test(s), to be passed in the same batch as the source.

**Recommended order** (batches), roughly hardest-clustered-first so the
rearrangement/geometry vocabulary that many files share gets a single canonical
home early — see §6 for the rationale:

1. `packages/map` — the pure spatial/algorithm core. Done (2026-09-17, across
   parallel checkouts): the rearrangement half (`illusion.ts` and its test,
   `board.ts` and its test, `moves.ts`, plus the small shared `prng.ts` and
   `nextRoom.ts`), then the search half (`ordering.ts`/`scoring.ts`/
   `searchResult.ts` and the two paired tests; they cross-reference each
   other heavily, so they went as one batch), then the remainder
   (`describe.ts`, `favorites.ts`, `metadata.ts`, `manifest.ts` and the
   paired tests). The remainder's pass found live instances of the §2b
   rot classes: five `.js`/`.mjs` filename citations, four dead
   `accessibility-plan.md` section/phase pointers, a `fetchRemoteManifest`
   pointer whose real name is `scanRemote`, a quote attributed to the
   curation prompt that the prompt does not contain, a "1.2 seconds" claim
   the config's viewport-sized durations make unfalsifiable-by-reading, and
   two claims the code does not have (`roomTitle` as "the one place the
   `Room {id}` fallback is written", `/api/manifest` serving the scan
   "verbatim plus a `config` field").
2. `packages/config` — done (2026-09-17). One file (`config.ts`) is the single
   densest comment block in the repo (480 comment lines); it took its own pass,
   and most of that block's bulk was P1 (facts AGENTS.md, `camera.ts`,
   `ordering.ts` and `search_rules.md` already own) and rotting literals.
3. The renderers as **one cluster**: `lib/render.ts` + `lib/glRenderer.ts` +
   `lib/slide.ts` + `lib/glSlideRenderer.ts` + the two `useMapRenderer*` hooks
   + their paired tests (done 2026-09-17).
   AGENTS.md's WebGL lockstep rule means their comments describe the same
   per-frame decisions twice — dedup across them, don't let one file's wording
   drift from its twin's.
4. `packages/server` — `app.ts` first (largest, and many other files cite it).
   Done (2026-09-17, out of order and in parallel).
5. `packages/web/src/lib` (geometry/DOM-adjacent) → `hooks/` → `components/`.
   `center.ts` + `tools/center-placement` are coupled; batch them. The
   `tools/center-placement` half went alone on 2026-09-17, out of order and in
   parallel, so that pairing note now applies to `center.ts` by itself. The
   `lib/gl` cluster also went alone on 2026-09-17, out of order and in
   parallel; the renderer cluster it is the WebGL counterpart of had passed
   first, so its wording (the lockstep rule, the per-cell loop, the headless
   flat-quad fallback) is the canonical home the gl/ files were deduped
   toward. `webglFlag.ts` went with `webgl-map.e2e.ts` the same day, which
   closes the WebGL set that orders 3, 5 and 7 each held a piece of. The
   `components/` batch also went on 2026-09-17, out of order and
   in parallel, ahead of `lib/` and `hooks/`; what it left those two batches
   to collect is recorded in `docs/pending_task_list.md`.
 6. `packages/pipeline`, then the `tools/*` trees, then `build/`. Pipeline is
   done (2026-09-17, out of order and in parallel), and so are `tools/embed`
   and `tools/upload`.
7. e2e/parity/bundle specs last (their comments are lower-stakes and they change
   most often — doing them late avoids churn).

Progress: §4's checklist is the whole record — tick boxes as you go, and do not
maintain a count here, because a tally that every pass has to re-derive is a
number that is wrong the moment two passes run at once. `packages/map`,
`packages/server`, `packages/pipeline`, `packages/config`, the renderer
cluster, `tools/center-placement`, `tools/embed`, `tools/upload`,
`tools/perf-capture`, `tools/font-lab`, `packages/web/src/lib/gl` and
`packages/web/src/lib` (camera, catalog, center) were taken on 2026-09-17 in
parallel across checkouts, out of the recommended order. `main.tsx` passed first
and passed again, and stays unticked because fresh changes from another branch
went in after the second pass. Order is a deduping aid within a cluster, not a
rule between clusters, so a batch can be taken from any package no other checkout
is in.

`tools/center-placement` went without `center.ts`, which order 5 pairs it with;
`center.ts` passed alongside `camera.ts` and `catalog.ts` on 2026-09-17, also in
parallel. What those three owed, and the pass took: the extension rot
(`main.jsx`, `geometry.js`, `render.js`, `picking.js`, `center.js`, `rooms.js`,
`scan.mjs`, `pyramid.js`, `camera.test.mjs`, `pyramid.test.mjs`), two dead
`accessibility-plan.md` section pointers of which one cited a quoted phrase no
doc contains, five positional "see `RUNS` below" pointers, and camera.ts's
"imported into `packages/config` as `camera.x`" rationale, which each of its five
by-feel constants re-derived and `packages/config` already states once.

Three claims the code does not have were corrected in place: `assignTitles` said
slots "remain null" for a corpus with no tags (it fills them with
`kind: 'empty'`), `panByCells` said a scale of 1 "preserves whatever offset it
picked up" once back inside the region (the snap discards it), and `glideToRest`
priced "five hundred" iterations against a `GLIDE_REST_MAX_STEPS` of 20,000. Two
"no test pins this value" claims were simply false: `camera.test.ts` brackets
`CURSOR_GRANULARITY_PX` at its own default, and `center.test.ts` brackets
`MIN_SPINE_PX` either side of 5. The rest went to
`docs/pending_task_list.md`.

Order 7's e2e fleet went one file early: `webgl-map.e2e.ts` passed on
2026-09-17 alongside `webglFlag.ts`, and what the pass found but did not touch
is what the rest of that order owes:

- The run block ("None of the files in this directory are part of `npm
  test`...") is verbatim in every spec file in `packages/web/e2e/`, and
  `map-gestures.e2e.ts` is already the file the others cite for "why and how" —
  that is its one home.
- Five files say "One of five files split out of the original
  `smoke.e2e.mjs`": the split is real (cbaa067 deleted the original), the count
  has moved since, and the `docs/pending_task_list.md` citation beside it has no
  matching entry left.
- Four `.js`/`.jsx` citations the TypeScript conversion left behind:
  `picking.js` (`map-gestures.e2e.ts`), `center.js` (`shelf.e2e.ts`),
  `debug.js` and `main.jsx` (`support.ts`).
- Two comments reason from a default that has since flipped:
  `render-parity.parity.ts` calls itself "the last thing standing between the
  GL renderer and flipping `DEFAULT_WEBGL`", and `support.ts`'s `openLibrary`
  doc says "The default there is now WebGL" — both were true of the change that
  made them, and read as the present tense a reader has to check.
- Strays the queue should not lose: `catalog.e2e.ts`'s header cites
  `docs/catalog-plan.md`, a deleted file already filed in
  `docs/pending_task_list.md`, and three comments promote a word to capitals —
  `EXPLICITLY` (`support.ts`), `PRIMARY` (`shelf.e2e.ts`), `MERGE GATE`
  (`map-gestures.e2e.ts`).

`packages/web/src/hooks/` went on 2026-09-17, out of order and in parallel:
ten files (useCenterShelf, useContentZoom, useCorpus, useDialog + test,
useDistillMode, useFavorites, useMapCamera, useMapCursor, useModeTransition,
useRearrangement, useSearch). All ten report comment-only via check.mjs; all
785 tests pass; lint and typecheck clean. What it found: dead section references
from deleted accessibility-plan.md (§4.2a, §4.2b, §4.3, §8 item 4) in three
files (`useMapCursor.ts`, `useRearrangement.ts`) plus perf-research.md pointers
(§3.1, §3.7, §9) in one file, ghost PR references ("used to provide for free",
"ghost PR review") in one file, outdated mentions of `imageZoom.ts` /
`useImageZoom.ts` (now `contentZoomCamera.ts`) in two files, and remaining
`.jsx` filename citations across several files. The dialog stack header was
rewritten from copy-paste history into an AGENTS.md pointer; distill mode's
"fade to black" language was corrected to match `render.ts`'s crossfade wording.

The next `packages/web/src/lib/` batch went on 2026-09-17, out of order and in
parallel: clearHistoryBook + test, contentZoomCamera + test, debug,
debugActions + test. All seven report comment-only via check.mjs; all 785 tests
pass; lint and typecheck clean. What it found: five dead `imageZoom.ts`
citations inside `contentZoomCamera.ts` and its test (the file that replaced
that one still cited its predecessor), a past-tense ghost in
`clearHistoryBook.ts` ("an earlier version anchored to the book's own bounding
box") now rewritten as a standing hazard, a dead pointer in `debugActions.ts`
(`DebugStep.args` named a switch in `runSequence` that lives in `dispatch`),
and one comment stating behaviour the code does not have: `debug.ts` claimed
the panel's results list and sliders had moved diegetic and that a session
without the flag compiles the panel out of the tree, when `MapView.tsx` still
renders them behind a runtime `DEBUG &&` — the comment now lists the panel's
actual contents and describes the gate as it is.

The next `packages/web/src/lib` batch went the same day: loadingAnimation +
test, svgPath + test, persist + test. What it found: `persist.ts`'s header
carried a `main.jsx` citation, a six-thing count, and a per-key story
paragraph the `KEYS` entries and `main.tsx` already own (the whys moved down
to each key), a dated provenance cite into `docs/concept.md`, and a client-id
comment reasoned from the IP address it replaced; `svgPath.ts`'s
`flattenPath` repeated the importer's since-corrected false claim ("the same
restriction the importer itself enforces on import") and now states the code's
actual behaviour - non-canonical letters and their numbers drop silently;
`loadingAnimation.ts` priced the preload at "a couple of seconds" and stated
the stop-at-a-boundary guarantee three times over. Found-bug fixes in the
same pass: AGENTS.md's "History is session-only React state" (history is
persisted, `KEYS.history`), three `main.jsx` citations in `infra/`
(`README.md`, `variables.tf`, `terraform.tfvars.example`), and
`touchDebug.ts`'s own `main.jsx` citation - that file still owes its full
pass.

The last non-e2e batch went the same day: tiles + test, perfProbe + test,
spineFont, touchDebug, assets.d.ts, bundle.test.ts, and main.tsx's remainder
after the branch merge. All seven touched files report comment-only via
check.mjs; all 785 tests pass; lint and typecheck clean; assets.d.ts and
perfProbe.test.ts reviewed with no edits needed. What it found: two dead
`accessibility-plan.md` section pointers in `main.tsx` (`§3.2`, `§4.2b` - the
doc's cull left no numbered sections to resolve to), a wrong count ("five
resolutions" against pyramid.ts's six-rung ladder) and a ladder-derived literal
("up to eleven `locateTile` calls") in `tiles.ts`, a stale `pyramid.test.mjs`
citation, a `perfSetPhase` doc pointer whose target does not discuss phase lag
(rewritten to performance-research.md's "Instrumentation caveats" section
title), a dead "the plan" pointer in `bundle.test.ts`, and a `TileHit.sheetUrl`
doc citing "perfProbe.ts's §2.3" when the § numbering belongs to
performance-research.md, not that file. `touchDebug.ts`'s "the whole feature
compiles out" claim was corrected to what the gate actually does: nothing
renders, and `useMapCamera` is handed no callback. The remaining unticked
entries are all e2e/parity specs and `support.ts`, which order 7 holds to last.

### Source files and their tests

#### packages/map
- [x] packages/map/board.ts
  - [x] packages/map/board.test.ts
- [x] packages/map/describe.ts
  - [x] packages/map/describe.test.ts
- [x] packages/map/favorites.ts
  - [x] packages/map/favorites.test.ts
- [x] packages/map/illusion.ts
  - [x] packages/map/illusion.test.ts
- [x] packages/map/manifest.ts  — no unit test
- [x] packages/map/metadata.ts
  - [x] packages/map/metadata.test.ts
- [x] packages/map/moves.ts  — no unit test
- [x] packages/map/nextRoom.ts
  - [x] packages/map/nextRoom.test.ts
- [x] packages/map/ordering.ts
  - [x] packages/map/ordering.test.ts
- [x] packages/map/prng.ts  — no unit test
- [x] packages/map/scoring.ts
  - [x] packages/map/scoring.test.ts
- [x] packages/map/searchResult.ts  — no unit test

#### packages/config
- [x] packages/config/config.ts
  - [x] packages/config/config.test.ts
- [x] packages/config/load.ts
  - [x] packages/config/load.test.ts

#### packages/pipeline
- [x] packages/pipeline/index.ts  — no unit test
- [x] packages/pipeline/layout.ts  — no unit test
- [x] packages/pipeline/mips.ts
  - [x] packages/pipeline/mips.test.ts
- [x] packages/pipeline/sheets.ts
  - [x] packages/pipeline/sheets.test.ts

#### packages/server
- [x] packages/server/app.ts
  - [x] packages/server/app.test.ts
- [x] packages/server/base-path.ts
  - [x] packages/server/base-path.test.ts
- [x] packages/server/catalogPage.ts
  - [x] packages/server/catalogPage.test.ts
- [x] packages/server/favorites.ts
  - [x] packages/server/favorites.test.ts
- [x] packages/server/image-fixtures.ts  — no unit test
- [x] packages/server/index.ts  — no unit test
- [x] packages/server/logger.ts
  - [x] packages/server/logger.test.ts
- [x] packages/server/port.ts
  - [x] packages/server/port.test.ts
- [x] packages/server/remote.ts
  - [x] packages/server/remote.test.ts
- [x] packages/server/roomContent.ts
  - [x] packages/server/roomContent.test.ts
- [x] packages/server/scan.ts
  - [x] packages/server/scan.test.ts
- [x] packages/server/search-cache.ts
  - [x] packages/server/search-cache.test.ts
- [x] packages/server/seo.ts
  - [x] packages/server/seo.test.ts
- [x] packages/server/version.ts
  - [x] packages/server/version.test.ts

#### packages/web
- [x] packages/web/index.html  — no unit test, checked by `stripHtml`
- [x] packages/web/style.css  — no unit test, checked by `stripCss`
- [ ] packages/web/e2e/support.ts  — no unit test
- [x] packages/web/src/components/ArtistStatementOverlay.tsx  — no unit test
- [x] packages/web/src/components/BabelBookOverlay.tsx
  - [x] packages/web/src/components/BabelBookOverlay.test.ts  (reviewed; no edits needed)
- [x] packages/web/src/components/BookOverlay.tsx  — no unit test
- [x] packages/web/src/components/CatalogView.tsx  — no unit test
- [x] packages/web/src/components/HelpDialog.tsx  — no unit test
- [x] packages/web/src/components/MapView.tsx  — no unit test
- [x] packages/web/src/components/RoomDetails.tsx  — no unit test
- [x] packages/web/src/components/RoomOverlay.tsx  — no unit test
- [x] packages/web/src/components/SearchForm.tsx  — no unit test
- [x] packages/web/src/components/SearchIcon.tsx  — no unit test
- [x] packages/web/src/components/ZoomControls.tsx  — no unit test
- [x] packages/web/src/hooks/useCenterShelf.ts  — no unit test
- [x] packages/web/src/hooks/useContentZoom.ts  — no unit test
- [x] packages/web/src/hooks/useCorpus.ts  — no unit test
- [x] packages/web/src/hooks/useDialog.ts
  - [x] packages/web/src/hooks/useDialog.test.ts
- [x] packages/web/src/hooks/useDistillMode.ts  — no unit test
- [x] packages/web/src/hooks/useFavorites.ts  — no unit test
- [x] packages/web/src/hooks/useMapCamera.ts  — no unit test
- [x] packages/web/src/hooks/useMapCursor.ts  — no unit test
- [x] packages/web/src/hooks/useMapRenderer.ts  — no unit test
- [x] packages/web/src/hooks/useMapRendererGL.ts  — no unit test
- [x] packages/web/src/hooks/useModeTransition.ts  — no unit test
- [x] packages/web/src/hooks/useRearrangement.ts  — no unit test
- [x] packages/web/src/hooks/useSearch.ts  — no unit test
- [x] packages/web/src/lib/camera.ts
  - [x] packages/web/src/lib/camera.test.ts
- [x] packages/web/src/lib/catalog.ts
  - [x] packages/web/src/lib/catalog.test.ts
- [x] packages/web/src/lib/center.ts
  - [x] packages/web/src/lib/center.test.ts
- [x] packages/web/src/lib/clearHistoryBook.ts
  - [x] packages/web/src/lib/clearHistoryBook.test.ts
- [x] packages/web/src/lib/contentZoomCamera.ts
  - [x] packages/web/src/lib/contentZoomCamera.test.ts
- [x] packages/web/src/lib/debug.ts  — no unit test
- [x] packages/web/src/lib/debugActions.ts
  - [x] packages/web/src/lib/debugActions.test.ts
- [x] packages/web/src/lib/distillToggle.ts
  - [x] packages/web/src/lib/distillToggle.test.ts
- [x] packages/web/src/lib/favoriteBadge.ts
  - [x] packages/web/src/lib/favoriteBadge.test.ts
- [x] packages/web/src/lib/gl/context.ts  — no unit test
- [x] packages/web/src/lib/gl/glowTexture.ts  — no unit test
- [x] packages/web/src/lib/gl/shaders.ts  — no unit test
- [x] packages/web/src/lib/gl/spineTexture.ts  — no unit test
- [x] packages/web/src/lib/gl/textureCache.ts  — no unit test
- [x] packages/web/src/lib/gl/warm.ts  — no unit test
- [x] packages/web/src/lib/glRenderer.ts
  - [x] packages/web/src/lib/glRenderer.test.ts  (reviewed; no edits needed)
- [x] packages/web/src/lib/glSlideRenderer.ts
  - [x] packages/web/src/lib/glSlideRenderer.test.ts  (reviewed; no edits needed)
- [x] packages/web/src/lib/loadingAnimation.ts
  - [x] packages/web/src/lib/loadingAnimation.test.ts  (reviewed; no edits needed)
- [x] packages/web/src/lib/perfProbe.ts
  - [x] packages/web/src/lib/perfProbe.test.ts  (reviewed; no edits needed)
- [x] packages/web/src/lib/persist.ts
  - [x] packages/web/src/lib/persist.test.ts  (reviewed; no edits needed)
- [x] packages/web/src/lib/picking.ts
  - [x] packages/web/src/lib/picking.test.ts
- [x] packages/web/src/lib/pyramid.ts
  - [x] packages/web/src/lib/pyramid.test.ts
- [x] packages/web/src/lib/render.ts
  - [x] packages/web/src/lib/render.test.ts  (reviewed; no edits needed)
- [x] packages/web/src/lib/rooms.ts
  - [x] packages/web/src/lib/rooms.test.ts
- [x] packages/web/src/lib/slide.ts
  - [x] packages/web/src/lib/slide.test.ts
- [x] packages/web/src/lib/spineFont.ts  — no unit test
- [x] packages/web/src/lib/svgPath.ts
  - [x] packages/web/src/lib/svgPath.test.ts  (reviewed; no edits needed)
- [x] packages/web/src/lib/tiles.ts
  - [x] packages/web/src/lib/tiles.test.ts
- [x] packages/web/src/lib/touchDebug.ts  — no unit test (stale `main.jsx`
  citation fixed 2026-09-17 alongside the persist batch; the rest of its pass
  went with the last non-e2e batch the same day)
- [x] packages/web/src/lib/webglFlag.ts  — no unit test
- [x] packages/web/src/main.tsx  — no unit test (re-passed end to end
  2026-09-17 after the branch merge; what remained was the two dead
  `accessibility-plan.md` section pointers)
- [x] packages/web/src/assets.d.ts  — no unit test (reviewed; no edits needed)
_Standalone specs/helpers (no same-name source):_
- [x] packages/web/bundle.test.ts
- [ ] packages/web/e2e/accessibility.e2e.ts
- [ ] packages/web/e2e/artist-statement.e2e.ts
- [ ] packages/web/e2e/catalog.e2e.ts
- [ ] packages/web/e2e/favorites.e2e.ts
- [ ] packages/web/e2e/keyboard-cursor.e2e.ts
- [ ] packages/web/e2e/map-gestures.e2e.ts
- [ ] packages/web/e2e/render-parity.parity.ts
- [ ] packages/web/e2e/shelf.e2e.ts
- [x] packages/web/e2e/webgl-map.e2e.ts

#### tools/center-placement
- [x] tools/center-placement/import-shelf-svg.ts  — no unit test
- [x] tools/center-placement/lib/geometry.ts  — no unit test
- [x] tools/center-placement/lib/measured.ts  — GENERATED: prose fixed in the
  generator's `body` template and re-run (`npm run generate:shelf-geometry`), so
  the artifact itself still verifies comment-only
- [x] tools/center-placement/lib/svg.ts  — no unit test
_Standalone specs/helpers (no same-name source):_
- [x] tools/center-placement/geometry.test.ts

#### tools/center-animation
- [x] tools/center-animation/index.ts  — no unit test
- [x] tools/center-animation/lib.ts
  - [x] tools/center-animation/lib.test.ts  (reviewed; no edits needed)

#### tools/embed
- [x] tools/embed/cosine-range.ts  — no unit test
- [x] tools/embed/cosine-stats.ts
  - [x] tools/embed/cosine-stats.test.ts
- [x] tools/embed/embed.ts  — no unit test

#### tools/upload
- [x] tools/upload/lib.ts
  - [x] tools/upload/lib.test.ts
- [x] tools/upload/upload-r2.ts  — no unit test

#### tools/perf-capture
- [x] tools/perf-capture/capture.ts  — no unit test

#### tools/font-lab
- [x] tools/font-lab/download-fonts.ts  — no unit test (reviewed; no edits needed)
- [x] tools/font-lab/fonts.ts  — no unit test
- [x] tools/font-lab/render.ts  — no unit test
- [x] tools/font-lab/variants.ts  — no unit test

#### build
- [x] build/register.mjs  — no unit test
- [x] build/ts-loader.mjs  — no unit test

## 5. Verification: "no code changed"

A comment pass must be provably code-free. Two independent checks, both cheap:

### Primary — `tools/comment-check/check.mjs` (classic-TS5)

```sh
node tools/comment-check/check.mjs <file>...          # working tree vs HEAD
node tools/comment-check/check.mjs --base <rev> <file>...   # vs another rev
```

For JS/TS it parses each file with the real TypeScript 5 parser and **prints it
back with comments removed** (`ts.createPrinter({ removeComments: true })`),
then diffs that canonical output between the two versions. Equal ⟹ only
comments changed; it prints `-/+` of the code lines that actually moved
otherwise. It preserves **type annotations**, so a slipped `a: number` →
`a: string` is caught, and parses correctly through regex-vs-division, template
`${}` substitutions, and JSX text — the cases a hand-rolled lexer (or
eyeballing a diff) gets wrong.

For `.css`/`.html` (`packages/web/style.css`, `packages/web/index.html`) there
is no parser in this tree, so `strip.mjs`'s `stripCss`/`stripHtml` hand-scan
the source instead — safe because both languages' comment delimiters are
unambiguous outside a string, unlike JS's `/`. They track quoted strings so a
comment-like sequence inside one is left alone, then collapse whitespace runs
to one space so a comment edit that shifts surrounding blank lines still reads
as comment-only. Neither walks into a nested language: `stripHtml` has no
`<script>`/`<style>` handling, which is fine only because `index.html` embeds
neither today.

Contract self-tests for both paths live in `tools/comment-check/strip.test.mjs`
(also run by `npm test`, which discovers `tools/`).

This is a **local-only tool**: classic TS is installed in a nested
`tools/comment-check/package.json` so its `tsc` binary can't shadow the
project's `typescript` v7 (the native tsgo port). Consequences:
- The nested `node_modules/` is gitignored and is not installed by CI. That is
  intentional — this is a branch/machine tool. On a fresh clone, run once:
  `npm --prefix tools/comment-check install`.
- `npm test` will try to load `strip.test.mjs`; if classic TS isn't installed it
  errors. Not a merge gate concern (local only), but know why.

### Fallback — esbuild one-liner (faster, one blind spot)

If `check.mjs` isn't available, an esbuild transpile of before/after and a
byte-compare confirms no *value* code changed — but **esbuild erases TypeScript
types**, so a type-only edit slips through. Use it as a quick check only; the
TS5 tool is the real gate.

```sh
node -e '
const {readFileSync}=require("fs"), e=require("esbuild");
const go=f=>e.transformSync(readFileSync(f,"utf8"),{loader:"ts",format:"esm",legalComments:"none"}).code;
console.log(go("/path/before.ts")===go("/path/after.ts")?"IDENTICAL-CODE":"CODE-DIFFERS");'
```

(Both were used on the illusion.ts pass; the esbuild check is what first flagged
the dropped `rows.sort(...)`. They agree.)

## 6. Tips that will save you

- **Never `git add -A`/`git add .` to commit a pass.** This working tree
  routinely carries untracked scratch that must not be committed
  (`favorite.json`, `reference/…`, `screen_reader_issues.txt`,
  `docs/comment-revision-tests/`, the nested `tools/comment-check/node_modules`).
  `git add -A` swept 30+ such files into the illusion.ts commit; recover with
  `git reset --soft HEAD^`, `git reset HEAD -- <paths>`, re-commit staging only
  your files. Stage paths explicitly (`git add packages/map/illusion.ts
  docs/claude_critique.md docs/comment-refactor-plan.md`).
- **A dropped code line is the real risk, not a mangled sentence.** The illusion.ts
  pass accidentally deleted `rows.sort(...)` inside a comment rewrite and
  hand-review missed it — only the verifier caught it. Run §5 before you trust
  your own eyes, every time.
- **Delete any scratch file before committing.** A temp `.mjs` at the repo root
  or a helper dropped under `tools/` gets picked up by `eslint .` (and any
  `*.test.*` scratch by `npm test`). Remove scaffolding used to build or test a
  tool; commit only the tool's real files.
- **Batch by cross-reference, not by folder size.** When file A's comment points
  at file B ("see `board.ts`"), deduping (P1) needs you to see both at once, so
  A and B go in one batch. The renderer cluster and the center/geometry cluster
  exist for this reason.
- **Comments use ASCII hyphens; this plan and the critique use em dashes.**
  AGENTS.md rule: prose comments in `.ts`/`.tsx` use `" - "`, not —. Match the
  file you're editing, not this document.
- **Don't rewrite a hazard you don't fully understand.** If a comment warns about
  something and you can't see the bug it prevents, keep it (you may keep it in
  tighter words). The failure mode is confidently deleting a load-bearing warning
  because it read like filler. When unsure, lean to keeping.
- **Type-only contracts still get passes.** `manifest.ts`, `moves.ts`,
  `searchResult.ts`, `assets.d.ts` are interfaces with a lot of JSDoc explaining
  invariants — the style rules apply, and the verifier still proves code-
  (type-) preservation.
- **`tools/center-placement/lib/measured.ts` is generated.** Its header says "Do
  not edit by hand." Comment fixes there belong in the generator
  (`import-shelf-svg.ts`), not the file — either skip it or fix the generator.
  Fixing the generator means editing prose that sits *inside* a template literal,
  so `check.mjs` reports the generator itself as code-changed (every line after
  the literal shifts, and the literal is a string to the parser). Run it on the
  regenerated artifact, which is where the claim can be proved: `measured.ts`
  reports comment-only, and a second run of the generator against the unchanged
  SVG reproduces the file byte for byte, which is what shows no number moved.
- **A pass adds signage as well as pruning prose.** Two invariants of sheet
  packing — tiles pasted row-major in the order `sheetPosition` reports, and a
  part-filled final sheet keeping the whole grid — were asserted only by a test,
  and nothing in `sheets.ts` said them. Where a contract lives only in a test or
  in a reader's head, writing it at the declaration is the same work as deduping
  it, and the verifier is indifferent to which direction a comment moved.
- **Tests get a lighter touch.** Their comments are usually about *why this
  assertion* — that's a hazard note (P3/P8) and mostly worth keeping. Still fix
  buried ledes and repetition, but don't strip a test's rationale to make it
  skim-friendly.
- **Use `git diff` at the end, not `git diff --stat`.** Read the real changed
  lines once as a human after the verifier passes — it's the last net for P4/P7
  prose slips and for catching a "comment-only" edit that quietly reordered two
  statements.
- **The plan itself is not exempt.** If you find a worse pattern than anything in
  §2, add it here (with the file that showed it) rather than only fixing the one
  file. And if a batch reveals the ordering here is wrong, update §4.
- **AGENTS.md got the same pass (2026-09-17).** Its Conventions section now
  carries the distilled house rules — lead with the rule, one fact one home,
  pin to declarations, keep hazards and drop ghosts, length proportional to
  risk with a hazard floor, plain declaratives, and references that resolve
  (this §2 stays the long-form catalog with the tells). Its Layout entries are
  now one-line signage pointing at the "Things that will bite you" bullets,
  which are the canonical home for subsystem facts — when a code comment or a
  doc passes through one of those facts, cite the bullet, don't restate it.
  Also cleared there: the stale `.js`/`.mjs` filename citations, the deleted
  catalog-plan's "plan §8" (moved to `pending_task_list.md`), the dead
  `accessibility-plan.md §3.7` pair, and the `server-nginx.conf` namings.
- **Where these ideas came from (§2b).** The bake-off lived in
  `docs/comment-revision-tests/` (local, untracked): five models each critiqued
  and revised `main.tsx`, plus a meta-analysis ranking them. Union-alpha's
  revision won largely on section dividers + file preamble (→ §2c) and
  facts-first prose; GLM's critique had the sharpest *diagnosis* (local
  completeness, prose-that-rots); Gemini's the cleanest counterfactual taxonomy
  ("the ghost PR review"); none caught everything. The meta-analysis's "what none
  of them caught" list — the `useSearch`↔`useRearrangement` cycle and
  `usable`/`fullyUsable` still stated twice in most revisions — is exactly the
  P1 dedup work, so expect to catch it fresh per file. If you re-read that folder,
  take the *tells*, not their prose: no other model's revision was adopted.
