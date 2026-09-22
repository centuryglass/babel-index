# Claude's comment style: a critique

Source: `packages/web/src/main.tsx` as of b4a9522 — ~1,550 lines, near-continuous
commentary. All line references are to that file before revision.

The premise for this review: comments have two jobs. (1) Let a reader tell at a
glance what's going on and why. (2) Record non-obvious reasoning so hard-won
decisions don't get casually reverted. In this file, job 2 is almost always
delivered — the information is there. Job 1 is systematically sabotaged, by
habits that are individually invisible and cumulatively exhausting. The
following tries to name them.

## The failure, in one sentence

These comments are written as **advocacy** — briefs defending a design to a
skeptical reviewer — when the reader needs **reference** — signage that tells
them what is true, quickly. Every element of the style below follows from that
one misdirection: advocacy is linear and adversarial; reference is indexical
and inert. The reader's eye can't tell the file isn't *about* arguing with
them, so it keeps bracing, keeps evaluating counterfactuals, keeps hitting
sentences it can't stop reading at.

That's also why the problem is "hard to define": there is no wrong text. Every
sentence is defensible in isolation. The style fails an *attention* check, not
a correctness check.

## The mechanisms

### 1. The lede is buried

A skimmer reads line 1 of each comment, then moves on. Claude's comments build
to their point: the operative rule lands in the last clause, and lines 1–3 are
scene-setting.

> `inertCanvasRef` (86–92) — the actionable fact, "the inactive renderer gets
> this permanently-null ref," is the *final* of seven lines. Ahead of it: a
> trivia warm-up about context types, a parenthetical about "spike code," and
> a rejected alternative ("rather than gate a context type inside
> `useMapRenderer.ts`…") the reader must reconstruct and dismiss before being
> told what the ref is.

Consequence: no comment is stoppable at line 1, so skimming is impossible and
every decision in the file demands a full read. This is the central mechanism;
most of the others amplify it.

### 2. Uniform emphasis — and counterfeit emphasis where there is any

Importance reaches a skimmer through form: first line is the claim, length
tracks risk, structure is stable. Here, a genuine hazard ("must not depend on
rank," 567–568) sits at the same length and volume as an aside about what
makes sliders usable (249–250). Form carries no signal, so the style
compensates with SHOUTING CAPITALS — `DEFAULT` (136), `ALWAYS` (600), `NATIVE`
(655), `ENTIRELY` (704), `LOSSLESS` (588), `RE-RANK` (1077), `BY THEN` (943),
`IS` (1031), `SEEDS` (1527). Nine comments in one file each declare their own
word essential. Capitals that mark everything mark nothing; the shouting is
itself evidence that position and length have already been spent at uniform
volume.

### 3. Arguing with ghosts

A large share of sentences defend the code against designs that are not in the
file and never were:

> - "so rather than gate a context type inside `useMapRenderer.ts`… (spike
>   code, not meant to touch the production hook)" (88–90)
> - "It is not only a convenience: this is what titles the center room's
>   shelf" (164–165)
> - "nothing is lost by waiting this long to call it" (829–830)
> - "a genuine cycle, not just an ordering accident" (889–890)
> - "Read-only on purpose… so there is no history-entry behaviour to design"
>   (1512–1514)

`AGENTS.md` names this exact trap ("would only drift," "rather than folded
into X") and the file keeps falling into it anyway. For the writer, the
counterfactual is the interesting part of the decision. For the reader it is
pure overhead: to learn what the code *does*, they first model what it
*doesn't* do and why an alternative lost. Note that some contrasts are load-
bearing — "it must not depend on rank" prevents a real regression — so the fix
is not deletion but demotion: the standing warning stays as the main clause,
and the ghost goes.

### 4. Hypotaxis — dash-joined run-ons

House style forces prose comments to use `" - "` rather than em dashes, and
this hyphen has become the comment's universal joint: it does the work of
commas, colons, semicolons, parentheses, and (confusingly) bullet points. The
result is sentences that must be parsed before they can be understood, and
pseudo-bullets indistinguishable from real ones:

> "A tap selects a book on the center room. Stable identity - so the pointer
> listeners are not re-bound every render - over a ref that always holds the
> latest logic, since the handler closes over `search` and `centreSlots`,
> which are redefined below and on every render." (625–628)

The sentence's spine is "Stable identity… over a ref…" — subject and complement
separated by an em-dashed aside, the verb buried, two facts (what the ref is
for; which values force the indirection) tangled in one breath. Content: two
easy facts. Form: full unpacking required every pass.

### 5. One fact, told many times

Because the rationale is the interesting thing to *write*, it gets rewritten
wherever it is *used*:

- "positioned imperatively from the render loop, like `booksRef`" — seven
  times in 35 lines (94–127), each in slightly different words.
- the `useSearch` ↔ `useRearrangement` cycle — twice (220–224, 887–891).
- `flyTo`'s +0.5 cell-centering correction — twice (740–744, 1212–1214).
- generic tiles' positional face — twice (247–250, 565–569).

Paraphrases don't pattern-match as "same fact," so the reader reconciles them
from scratch on every encounter; and each copy is one edit away from drift.
At-a-glance wants one canonical statement at the shared site and plain
pointers elsewhere. Redundancy also destroys triage: when everything is
explained at length, nothing looks like it *needs* explanation.

### 6. The narrator's voice

The comments perform cleverness — phrasings whose function is style, not
information: "a bounded handful" (398, 414), "so this is how 'what did the
browser actually send' stays answerable without a USB cable" (649–650), "a
promise to remix the whole shelf" (1057–1058), "reads the same but looks
different" (182), "more geometry than a `?` press needs to earn its keep"
(1550). The register is blog-post-about-the-code, not signage-on-the-code.
Worse than wasted words: after fifty instances the reader learns the fatal
generalization that these comments are half decoration — which devalues the
half that is hazard warnings. The same failure at smaller scale: the
hedge/intensifier adverbs (`exactly`, `really`, `deliberately`, `precisely`,
`never`, `only ever`, `on purpose`) that mark the writer's conviction rather
than the fact's content. A cousin of these is the possessive `own` — "the
badge's **own** pyramid", "the tile's **own** scale" — where the genitive `'s`
already owns the noun and `own` only pads; the exception that stays is the real
idiom "X has **its own** Y" (and the existentials "a Y **of its own**" / "no Y
**of its own**"), which say exclusive possession the bare possessive cannot.

### 7. Comments painted on regions, not pinned to declarations

The consequence of all of the above, made visible by code motion. Prose
paragraphs describe *neighborhoods*, and neighborhoods move; the file carries
three fresh wounds:

- **236–250**: a single 15-line block that opens "Both of these are runtime
  parameters" — neither "these" is nearby; the referents are arguments to
  `createLayout` 40 lines down. `git log -L` shows the sediment: three separate
  commits pasted new paragraphs onto the block's tail without a blank line, so
  layout inputs, generic tiles, and favorites now read as one paragraph
  describing three unrelated things, with two of them now interleaved in code.
- **1539–1551**: a full `/** … */` doc comment for the `?`-key surroundings
  floating over `createRoot`. The function it documented lives in
  `useMapCursor.ts` now. Nothing failed when it moved, because the comment was
  attached to a region, not to a declaration.
- **96**: "see `positionSearchBox`" — that function no longer exists anywhere
  in the repository; the positioning code moved into `useMapRenderer.ts`.

A one-line comment pinned to a declaration moves with its code or visibly
becomes wrong. A fifteen-line paragraph painted on a region quietly becomes a
confident-looking lie.

### 8. Inverted cost

Comment bulk correlates with writer interest, not with code risk. Obvious
three-line `useState`s carry 8–20-line justifications (162–172, 941–949),
while the genuinely subtle machinery — the three-way `usable`/`fullyUsable`/
`books` gating, `effectiveSortMode`'s override semantics — gets comparable
volume. A first-time reader's cost is total prose, so the file currently reads
as a long document with occasional code.

## Why this is hard to pin down (attempted answer)

Ordinary bad comments fail by being absent, wrong, or noise. These are present,
true, and signal-rich — and still slow you down, because human skimming runs on
form: first-line summaries, length-proportional-to-risk, stable locatable
structure, low redundancy. The style defeats all four channels simultaneously:
sentences build to their point (kills first-line stops), everything is the same
size (kills triage), paragraphs float over regions (kills anchoring), facts
recur in paraphrase (kills pattern-matching). "At a glance" silently degrades
into "read everything, in order, while evaluating arguments you didn't make."
The tell that it's a *style* failure and not an *information* failure: you can
delete half of any given comment with no loss of truth and a large gain in
readability.

## Rules applied in the revision

The same commit revises `main.tsx`'s comments — comments only; no code line,
and no fact of substance, is changed. The revision targets each mechanism above:

1. **Lead with the rule.** Line 1 of every comment is a standalone summary;
   stopping there must never cost a reader an invariant.
2. **One fact, one home.** The canonical statement lives at the shared site;
   other places point or stay silent.
3. **Pin to declarations, never to regions.** One comment, one thing below it;
   no multi-topic paragraphs. The drifted block at 236–250 is split and
   re-attached to the code it actually describes.
4. **Keep hazards, drop ghosts.** Standing warnings stay, upgraded to main
   clauses ("`must not depend on rank`"); rebuttals of never-attempted designs
   are cut.
5. **Length proportional to risk.** ≤3 lines is the default; more is allowed
   only where a named hazard earns it (`centreOverlay`'s three-way gate,
   `mapViewport`'s 0×0 trap, the hidden-not-unmounted rule).
6. **Plain declaratives.** No SHOUTING CAPS, no narrator asides, no conviction
   adverbs; emphasis comes from position and structure.
7. **Lists for list-shaped content**; short sentences; one clause per dash.

## Flagged for follow-up (deliberately not done here)

- The orphaned `?` doc block (1539–1551) is deleted rather than moved, since
  this revision was scoped to `main.tsx`. Half its content already survives at
  `useMapCursor.ts:205`; the piece found nowhere else — "four cardinal
  directions, not eight: a diagonal nearest-room search is more geometry than
  the key needs" — should be appended to `describeSurroundings`'s doc comment
  in `useMapCursor.ts` (or `docs/accessibility-plan.md` §4.2a) before it is
  lost.
- `AGENTS.md`'s comment-hygiene note could cite mechanisms 1, 3, and 5 — it
  currently only warns about mechanism 3's past-tense variant.

---

# A second file: `packages/map/illusion.ts`

Source: `packages/map/illusion.ts` as of db67cbe — ~577 lines. Same style
family, but the pass here goes differently, and the difference is the point.

## Why this file is not main.tsx

`main.tsx`'s failure was *inverted cost* (mechanism 8): long advocacy on
three-line `useState`s, thin notes on genuinely subtle gating. `illusion.ts`
inverts that profile — the commentary is heavy almost everywhere, but
**mostly where it is earned**. This is a non-obvious algorithm (a toroidal
sliding-puzzle solver whose whole thesis is that repeated values make it a
supply problem, not a permutation problem), and the reader who does not grasp
that will casually break it. So:

- **Mechanism 1 (buried lede) is largely absent.** Almost every function leads
  with a standalone rule: `normaliseDistance` ("Reduce a cyclic distance to the
  shorter signed direction"), `makeAvailable` ("An unlocked off-camera cell
  holding `v`…"), `validate` ("The preconditions the algorithm leans on, checked
  once and loudly"), `applyMove`, `batched`, `find`. The file-level header is
  split into named subsections ("### The move set is the guarantee", "### Values
  repeat…", "### Board, not map") that are good indexical signage. Little to fix
  on this axis.
- **Mechanism 8 is largely satisfied.** The phase-2 `k`-step derivation, the
  "never needs the column emptied first, because a legal region may be taller
  than half the board" hazard, the `lockedInRow`/`lockedInCol` O(1) insight —
  these carry their length. The right move was to *leave them*, and resisting
  the urge to trim prose that looks bloated but is load-bearing was most of the
  discipline here.

The mechanisms that *do* bite are narrower, and 5 leads them.

## What actually needed editing

**Mechanism 5 (one fact, many homes) — the real problem.** The independence
rule — "park a whole batch before feeding any of it, which makes the batch's
lines independent, which is what lets the animation play them as one wave" —
was re-derived in five places: the primitives block, `batched`, phase 1's park
step, phase 1's sort note, and phase 2's batch paragraph. Each paraphrase added
one local wrinkle on top of an identical core, so a reader met the same
argument four times before finding the fifth. Fix: the primitives block (where
`stage`/`line`/`wave` are defined) becomes the single canonical statement;
`batched`, the phase-1 park, and the phase-2 paragraph now say their local fact
and point back.

**Mechanism 2 (shouting caps).** `OFF-CAMERA`, `UNLOCKED`, `INDEPENDENT`,
`FEED`, `PARKING`, `NOW`, `BATCH`, `AND`/`ROWS` — eight comments each promoting
one word to capitals. Mostly demoted to normal prose; where the caps marked a
real contrast (feed vs. parking stages, "locked now vs. locked at the end") the
contrast is now carried by sentence structure or a list item instead.

**Mechanism 6 (narrator).** The header's "Rearranging the map without admitting
that the grid is not a space," "exactly the illusion worth keeping," "robbed,"
"cannibalized" — phrasings whose job was style. Kept the concepts, dropped the
performance. The `### Values repeat` / `### Board, not map` subsection titles
stay — those earn their cleverness by being accurate and locatable.

**Mechanism 3 (ghosts) — light here, one instance.** `AGENTS.md` flags the
past-tense variant specifically, and there was exactly one: phase 2's "one
column per batch — which is *the original, strictly sequential behaviour* —"
argues against a version of the planner that exists only in git. Cut. The other
counterfactuals in the header (why a whole-line rotation over a tile gliding
over a backdrop) are standing hazards, not ghosts, so they stay.

**Mechanism 4 (hypotaxis).** A few dash-joined run-ons split — the `makeAvailable`
"reserved cell" hazard and the pool bullet in particular — but the file's
dashes mostly do honest parenthetical work and were left alone.

## The judgment this pass required

The main.tsx pass could mostly apply its seven rules mechanically. Here the
work was knowing which prose that *looks* like the bad style is actually a
hazard warning wearing the same clothes. Two tests separated them, applied to
every block I touched:

1. **Would deleting this clause let a competent reader write a real bug?** The
   phase-2 derivation, the early-locking rationale, the "toroidal only because
   the wrap is off-camera" gate — yes. All kept.
2. **Does this sentence tell what the code *does*, or only argue that an
   alternative lost?** The "original, strictly sequential behaviour" aside and
   the header's "without admitting" lede only argue; cut or rewritten to
   declaratives.

So the approach flipped from main.tsx's "compress everything toward a ≤3-line
default" to "hold the length where risk justifies it, and spend the effort on
de-duplicating the one fact the whole file leans on." The output is shorter in
places and about the same length in others — the change is that nothing is now
said twice, and nothing important is now buried in a paraphrase.
