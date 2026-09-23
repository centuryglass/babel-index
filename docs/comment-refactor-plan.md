# Comment refactor plan

A standing work plan for rewriting this repository's code comments to the
house style. It is meant to be read at the start of any session that is doing
a comment pass, so that the work is repeatable and does not have to be
re-derived each time.

Companion doc: [`claude_critique.md`](claude_critique.md) — the *diagnosis*.
This file is the *process*: what we're doing, the problems to fix and how, the
verification tool, and gotchas.

## 1. What we're doing, and why

The bulk of this codebase's comments were written by Claude (the model), and
the style reads poorly: correct, but written as advocacy — briefs arguing a
design to a skeptic — when a reader needs reference — signage stating what is
true, fast. It sabotages skimming in specific, nameable ways (catalogued in
`claude_critique.md`).

The work is a comment pass that **rewrites comment text only and never touches
code**, moving each comment toward: rule first, one fact one home, pinned to a
declaration, plain declaratives, length proportional to risk. Two passes are
committed as exemplars of the two dominant modes:

- `main.tsx` (db67cbe) — the archetype: every failure mode present.
- `illusion.ts` (10bf4c8) — the nuance: a file where heavy commentary is
  *mostly earned*, so the pass is narrower (dedup + de-shout, not compress).

The tree-wide rewrite is done: every code file was passed once (see the git
history and the AGENTS.md pass notes). What remains is *spot-checks* — a
section flagged in review, the comments a change just touched, or a file you're
already in for another reason. Each spot-check runs the §3 workflow over that
one section rather than a whole batch, and the §4 verifier proves the same way
that no code moved. Bug-fixing and deep code analysis stay out of scope: a
comment pass reads code closely enough to *notice* a bug, and the rule is to
open a GitHub issue for it (AGENTS.md, "Tracking open work": what was
observed, how to reproduce it, what is ruled out), not fix it in the same
commit. Search the open issues first (`.claude/cache/issues/index.md`) so a
known bug gets a comment rather than a duplicate.

Scope: JS/TS sources under `packages/`, `tools/`, `build/`, and their tests,
plus `packages/web/index.html` and `packages/web/style.css` - §4's verifier
covers all four via `tools/comment-check/strip.mjs`'s per-extension dispatch
(a real parser for JS/TS, a hand-rolled comment scan for CSS/HTML).

## 2. Common problems and how to fix each

Distilled from `claude_critique.md`'s eight mechanisms, the two committed
passes, and five other models' independent critiques (folded into §2b). Each is
a **tell** (how to spot it) and a **move** (what to do), listed in the order that
tends to pay off. In a spot-check, apply every one of them to the comment
lines under your hand — they are a checklist to read against, not a queue to
work through file by file.

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
conviction adverbs (`really`, `precisely`, `never`, `on purpose`; the word-level
keeps-and-cuts for `exactly` and possessive `own` are P9's).
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

**P9 — Redundant emphasis words: `own` and `exactly`.** Two single-word
emphasis tells, both stating the writer's confidence rather than a fact. They
were not in the eight original mechanisms; they surfaced in later spot-checks
(favorite-badge issue #257) and are cheap to grep.

*Tell — `own`:* it sits between a possessive and the noun it already owns —
"the badge's **own** pyramid", "the tile's **own** scale", "that level's **own**
reference width." Native English does not say these; it says "the badge's
pyramid." The possessive `'s` carries ownership, so `own` only adds length and
awkwardness. *Move:* drop it from the possessive form. Two cases are *not*
this tell and must survive:
- The idiom "X **has/have** its/their own Y" ("the badge has its own pyramid")
  is the ordinary way to state exclusive possession — keep it.
- `own` doing real disambiguation — "no pyramid **of its own**", "a pyramid **of
  their own**", "see its **own** comment" (which comment? this function's) -
  marks the exclusive-vs-shared or self-referent reading. Keep it, or replace
  with the plainer "exclusive"/"respective" if the contrast is genuinely
  load-bearing; do not keep the bare possessive form as the compromise.

*Tell — `exactly`:* it is a confidence signal, not information — "for
**exactly** these two files", "**exactly** what a real draw looks like." *Move:*
delete it unless a reader would otherwise draw a wrong conclusion — where it is
load-bearing it is usually contrasting two values ("the hover tracks the art
exactly" is real, because the tap target is padded, so without "exactly" the
reader assumes both paths use the padded box). The test is P8's, applied to one
word: would a careful reader do the wrong thing if `exactly` were gone? If not,
cut it.

## 2b. Extra patterns from the model bake-off

`docs/comment-revision-tests/` holds five other models' critiques + main.tsx
revisions plus a meta-analysis. Their diagnoses converge with the eight
mechanisms above, so nothing replaces P1–P9 — but a few sharpen them, and one
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
`concept.md` is explicitly not kept in sync, and an issue closes when its
work is done — so a section number into one is a fact with an expiry date. A
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
renumber where a `§4.2a` will not. And an issue pointer (`#NN`) is fine when
the issue is open and anchored at that exact spot, the "issue #NN tracks the
fix for this line" shape, because it gets cleaned up as the issue closes; a
pointer to a closed issue, or to one whose fix will not touch this line, is
the same dead `§4.2a` in a different costume (AGENTS.md: cite an issue only
when it is open and the reader should follow it). Tells to grep for:
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
a repro. Then per AGENTS.md's bug rule: correct the comment to the truth, and
open a GitHub issue when the code is what is wrong. The claim travels, so check
where it is quoted: `svgPath.ts`'s `flattenPath` carried the importer's false
one until its own pass corrected it to the code's actual behaviour.

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

## 3. The spot-check workflow (definition of done)

Run this on each section you touch. Steps 4, 6 and 7 are what make a pass
trustworthy.

1. **Pick the section** — the comments one change or one review flagged, not a
   batch. A section is usually a single declaration's comment (or a file
   header, or one test's rationale), plus any adjacent comment the change
   makes untrue.
2. **Read the section in full first.** Note where the ledes are, where facts
   repeat, and — critically — which long comments are earned hazards (P8).
   Re-read the relevant `AGENTS.md` "Things that will bite you" bullets; those
   invariants must survive the rewrite verbatim in substance.
3. **Edit comments only.** Apply P1–P9 and the §2b sharpenings; reach for the
   §2c formatting devices (preamble, section dividers) where a section needs
   one. Preserve every fact and hazard; never delete information to save space —
   relocate or condense it. Never touch a functional comment (an
   `eslint-disable`, `@ts-*`, `@license`, or a directive the toolchain reads) —
   those are code, not prose.
4. **Verify no code changed** — §4's tool, `check.mjs`, on every file touched.
   Must report `OK (comment-only)` or `clean (unchanged)` for all of them.
   This is not optional; it caught a dropped `rows.sort(...)` line during the
   illusion.ts pass that hand-review had missed. It is also what catches a
   deleted `eslint-disable` pragma, since stripping it changes emitted code.
5. **Run the gates:** `npm test`, `npm run lint`, `npm run typecheck`. (These
   also catch a comment edit that broke a `@example`-style fenced block or an
   unused-var reference from a removed doc line.)
6. **Check every cross-reference resolves.** Grep the section for `see \``,
   "see <Name>", literal claims ("the two things", a raw count), and doc
   pointers (`§[0-9]`, `\.md`) — then confirm each named symbol/file still exists
   (`grep -rn`), each literal was replaced by a symbol reference, and each doc
   still has the section cited. Union-alpha's otherwise-best revision shipped a
   dead `positionSearchBox` pointer; this step is the net for that, and for the
   `accessibility-plan.md §4.2a` class of rot that outlives its doc's last cull.
7. **Self-check the diff** — read `git diff` once more; confirm every changed
   line is a comment line and the prose follows the house rules (ASCII hyphens
   in comments, single quotes, two-space indent, no "used to"). Sweep the lines
   you touched for the P9 words (`own` after a possessive, `exactly`), since
   they survive an otherwise-careful edit.
8. **Commit** — comments-only in the message, name the dominant moves, cite
   that the verifier showed byte-identical code.

## 4. Verification: "no code changed"

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
(which `npm test` would pick up; see the local-only note below).

This is a **local-only tool**: classic TS is installed in a nested
`tools/comment-check/package.json` so its `tsc` binary can't shadow the
project's `typescript` (pinned to `^6`; see AGENTS.md's *Commands*). Consequences:
- The nested `node_modules/` is gitignored and is not installed by CI. That is
  intentional — this is a branch/machine tool. On a fresh clone, run once:
  `npm --prefix tools/comment-check install`.
- `npm test` picks up `strip.test.mjs`, which fails without that install, so
  don't copy it onto `main` for a pass (AGENTS.md, "Comment and documentation
  audits").

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

## 5. Tips that will save you

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
  hand-review missed it — only the verifier caught it. Run §4 before you trust
  your own eyes, every time.
- **Delete any scratch file before committing.** A temp `.mjs` at the repo root
  or a helper dropped under `tools/` gets picked up by `eslint .` (and any
  `*.test.*` scratch by `npm test`). Remove scaffolding used to build or test a
  tool; commit only the tool's real files.
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
- **The plan itself is not exempt.** If a spot-check turns up a worse pattern
  than anything in §2, add it there (with the comment that showed it) rather
  than only fixing that one comment. P9's `own`/`exactly` tells entered this
  way — caught checking the favorite-badge section, not on a scheduled pass.
- **AGENTS.md got the same pass (2026-09-17).** Its Conventions section now
  carries the distilled house rules — lead with the rule, one fact one home,
  pin to declarations, keep hazards and drop ghosts, length proportional to
  risk with a hazard floor, plain declaratives, and references that resolve
  (this §2 stays the long-form catalog with the tells). Its Layout entries are
  now one-line signage pointing at the "Things that will bite you" bullets,
  which are the canonical home for subsystem facts — when a code comment or a
  doc passes through one of those facts, cite the bullet, don't restate it.
  Also cleared there: the stale `.js`/`.mjs` filename citations, the deleted
  catalog-plan's "plan §8", the dead
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
