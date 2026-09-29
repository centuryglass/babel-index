# Story workflow

How a tile gets from a freshly generated image with no story to a finalized
story in `metadata.json`. This describes the intended workflow of the staged
story engine. Some stages are not built yet: issue #385 tracks the engine
work, and issue #409 the review GUI that will match this shape.

Prompts are summarized here, not copied. Each stage names the function that
builds its prompt, so the full text is one click away.

## Overview

```
 images (external)
   |
 1. Import ............ keywords only, story absent
   |
 2. Pitch ............. reading of the image + 6 pitches, each from a seed;
   |                    "Pitch more" appends to the same list
 3. Novelty filter .... flags premises too close to the corpus   [deferred]
   |
 4. Pitch review ...... drop obvious failures, sharpen near misses
   |
 5. Draft ............. one draft per kept pitch, in parallel
   |
 6. Check ............. lint, optional LLM critic                [not built]
   |
 7. Critique .......... hand edits and revision requests, on any
   |                    drafts, repeated as often as needed
 8. Choose ............ pick one draft (or re-pitch / redraft);
   |                    critique can continue on it afterwards
 9. Accept ............ mark Final
   |
10. Record ............ tag the story into corpus memory         [not built]
```

A tile's reading, pitches and drafts live in one workspace file that grows
as the tile is worked on, so leaving a tile and coming back loses nothing.
Model calls are also logged to a trace (see "The trace").

## Principles

These shape every stage below. The evidence behind them is in issue #385's
comments and the maintainer's local `story_preferences.md`.

- **A pitch predicts a story poorly.** A favorite story's value is often
  angle, voice and one line that sticks, and none of that survives being
  compressed into a premise. So pitch review only removes obvious failures,
  and the real choice happens between finished drafts.
- **The writer never sees the corpus.** A model shown past stories copies
  their patterns. Novelty is policed outside the writer, by the novelty
  filter and the maintainer's review, never by a ban list in the prompt.
- **Each model call has one narrow job.** No single call has to read,
  invent, choose and write at once.
- **Human judgment is cheap to give.** Writing prose critiques is tiring.
  Every judging point asks for a quick decision, with notes optional.
- **A hand edit beats a request.** The reviewer can edit, add, duplicate
  and delete pitches and drafts directly. Asking a model to delete two
  words costs more than deleting them.
- **Every judging point has a configurable owner** (see "Evaluators"), and
  the trace records the decision the same way whoever makes it.

## Where things live

| What | Where |
| --- | --- |
| Engine stages, prompts, validators | [`story_engine/engine.py`](../story_engine/engine.py) |
| JSON reply parsing and retry | [`story_engine/llm.py`](../story_engine/llm.py) |
| Weighted option lists | [`story_engine/options.py`](../story_engine/options.py) |
| Workspace: one tile's reading, pitches, drafts and choice | [`story_engine/workspace.py`](../story_engine/workspace.py) |
| Trace log | [`story_engine/trace.py`](../story_engine/trace.py) |
| Babel Index's frame: subject, presentation, voice, style rules | [`babel_index_review/story_frame.py`](../babel_index_review/story_frame.py) |
| The base scene every image shares | `core.py`'s `BASE_SCENE` |
| Seeds, forms, constraints | `data/story_seeds.json`, `data/story_forms.json`, `data/story_constraints.json` |
| Model backends | `tag/describe_image.py` |
| Workspaces on disk | `DIR/story_traces/<tile stem>.json` |
| Traces on disk | `DIR/story_traces/<tile stem>.jsonl` |

## 1. Import

**Does:** `python -m babel_index_review.tile_process DIR` turns each loose
`.png` in `DIR` into `NNNNN.webp`. It reads the three style keywords from
the A1111 prompt metadata, normalizes them through `data/keyword_map.json`
and writes them to `metadata.json`. The tile starts with keywords and no
story.

**Choices:**
- `--map` for a different keyword map.
- Nothing about stories. Import only prepares tiles; story writing starts at
  stage 2.

**Output:** `metadata.json` entry `{"keywords": [...]}`.

## 2. Pitch

**Does:** the first vision-model call for a tile reads the image and returns
a short **reading** plus six **pitches**. Later calls reuse the reading and
append more pitches to the same list.

The engine first draws a **seed menu** from `data/story_seeds.json`:
`pitch_count + seed_menu` seeds (6 + 4 by default). The model picks the six
seeds this image supports best and skips the rest, so no seed is forced onto
an image that can't carry it. A seed is one of four kinds, each with its own
weight so a long list can't crowd out a short one:
- **angle:** a question about the room ("What's the worst book in the
  collection?"). These are the old single-prompt generator's questions.
- **behavior:** people doing something human (ritual, hack, petty scheme,
  hobby, grievance...).
- **displacement:** something from our world moved into this one.
- **payload:** what the story delivers (mystery, comedy, alien rule...).

**Prompt:** `engine.py`'s `pitch_prompt`, filled from the `Frame`. In short:
- Find the image's **enigma** (its most unexplained detail), what departs
  from the base scene, and which keywords visibly shaped it. Describe only
  what is there.
- Each pitch has four fields, with counted word caps (`Frame.pitch_limits`):
  - `seed`: the seed it grows from;
  - `pitch`: one high-concept line;
  - `hook`: what the reader keeps (a turn, an open question with several
    good answers, a joke, a recognizable behavior, an image);
  - `anchor`: the visible detail it grows from.
- A list of "what tends to work": people acting like people, mechanisms
  people live with, small stakes, open questions left on purpose, dry
  absurdity, real-world things displaced. Also: never claim the image looks
  different from how it does.

**Validation:** `_pitch_validator` rejects unknown or repeated seeds, the
wrong pitch count, and any field over its word cap. The error goes back to
the model, which retries (up to two retries).

**Choices:**
- **Model.** Pitching is a good fit for a cheap model.
- **Pitch more.** Asks for a set number of further pitches (6 by default).
  The call gets the current reading and the pitches already on the list, so
  it doesn't repeat them, and its seed menu skips seeds already used where
  enough remain. New pitches are appended; nothing is replaced.
- **Edit the reading** by hand to correct a real flaw, or **regenerate** it
  alone. Either change applies to every later pitch and draft call; pitches
  and drafts already written keep what they have.

**Output:** the reading, and pitches appended to the tile's list. The reading
goes on to the writer so both calls share one interpretation of the image.

## 3. Novelty filter (deferred)

**Does:** compares each pitch against **corpus memory** (stage 10), which the
writer never sees, and flags rather than bans:
- premises too similar to existing ones (see issue #385's comment on
  premise similarity: embed a content-stripped schema of each premise, then
  have an LLM judge the nearest few);
- trope tags already over their weight, penalized by inverse frequency;
- overused openers and n-grams.

Until reviewing pitches becomes a chore, the maintainer's pitch review is
the novelty filter.

## 4. Pitch review

**Does:** a coarse filter, and a chance to sharpen near misses. Every pitch
starts kept. The reviewer drops pitches with:
- an obvious major flaw (a premise that collapses at the first "why not
  just...?", a claim the image doesn't support);
- an overdone pattern;
- an idea plainly against taste.

A pitch that isn't interesting on its own but could become something good
stays in. A pitch that is nearly good gets a note that says what it's
missing.

**Choices:**
- Keep or drop each pitch, one click each.
- An optional note on a pitch. The writer receives it with the pitch, so a
  few words can redirect it ("needs a reason anyone would put up with
  this"). Notes also feed `story_preferences.md` and prompt tuning. They are
  never required.
- Edit a pitch by hand.
- Add a pitch of your own, without having to drop one first.
- Delete a pitch.
- Pitch more if nothing is worth drafting.
- **Owner:** `human`, `llm` or `auto` (keep everything).

**Output:** in the workspace, each pitch's kept flag and note, and any
hand edits, additions or deletions.

## 5. Draft

**Does:** writes one draft per kept pitch, all in parallel. Each draft gets:
- a **form** drawn by weight from `data/story_forms.json` (anecdote, letter,
  dialogue, notice, list, marginalia, transcript...);
- with a set probability (0.25 by default), an **odd constraint** from
  `data/story_constraints.json` ("the narrator is a child", "no more than 30
  words"). Constraints break a model out of a rut, and keep drafts from
  sounding alike when one keyword dominates.

**Prompt:** `engine.py`'s `write_prompt`. The writer sees the current
reading, one pitch with its review note, the form and the rules, and nothing
about other stories. The rules:
- the hook arrives within the first two sentences;
- detail can carry its own small idea, but no chains of detail where each
  particular explains the one before;
- a strange rule or mechanism answers at least one of its whys;
- a question is left open only when it has several good answers, and the
  story doesn't end on a mystery it hasn't set up;
- fully diegetic voice (`story_frame.py`'s `VOICE`);
- don't describe the image;
- take tone from the keywords without naming them;
- 150-word hard limit, a budget and not a target;
- the frame's style rules (no em dashes);
- the constraint, if one was drawn.

**Choices:**
- **Form override:** force one form for this round instead of drawing.
- **Constraint chance:** set per round, from never to always.
- **Draft kept pitches** drafts every kept pitch without a draft yet.
- **Redraft** one draft: a new draft from the same pitch, with a new form and
  constraint drawn. The old draft stays.
- **Model.** Drafting benefits from a stronger model than pitching.

**Output:** drafts appended to the workspace, tagged with their pitch, form
and constraint.

## 6. Check (not built)

**Does:** screens drafts automatically before anyone reads them.
1. **Deterministic lint:** em dashes, banned n-grams, word budget, names
   reused from the corpus, overused openers. Low priority, since these are
   easy to fix by hand.
2. **Critic (optional):** an LLM reads each sentence against the pitch's
   hook and flags chains of detail that slow a reader down, and a hook that
   arrives late. A flagged draft goes to stage 7 with the critic's findings
   as its revision request.

**Choices:** whether the critic runs, and whether lint failures block or
only annotate.

## 7. Critique

**Does:** fixes what the reviewer (or the stage 6 critic) found, on any
number of drafts, in as many rounds as needed. It runs before Choose, after
it on the chosen draft, or both.

**Choices:**
- **Hand edit** a draft. Renaming a character or dropping two words is
  faster by hand than by prompt.
- **Revision request:** a short instruction ("cut the second sentence",
  "make the clerk less competent") written on one draft and sent at once.
  Requests on different drafts run in parallel, since a reply can take a
  minute or two. The revision call continues the writer's own conversation,
  with its reading, pitch, form and rules, and says plainly that only the
  named change is wanted. The draft keeps its earlier versions.
- **Objection:** the writer may answer a revision request by explaining
  what the flagged passage was meant to do, instead of changing it. The
  reviewer then rewrites the request, or passes the draft as it is. A
  critic that misreads a twist would otherwise remove it.
- **Add a draft:** write one by hand, or duplicate an existing draft to try
  different requests on each copy.
- **Delete** a draft. Its pitch can be redrafted.
- **Owner:** `human` by default.

**Output:** revised drafts and their earlier versions in the workspace,
`revise` events in the trace, and hand edits, additions and deletions.

## 8. Choose

**Does:** the reviewer reads the drafts side by side, with the image visible,
and picks one. This is where the real selection happens.

**Choices:**
- Pick a draft. It becomes the tile's story, unfinalized. More critique
  rounds can follow on it.
- Redraft (back to stage 5), or pitch more (back to stage 2).
- Discard the chosen story and go back to the drafts or pitches.
- Leave the tile for later. Nothing is lost; the workspace holds every
  pitch and draft.
- **Owner:** `human` or `llm`.

**Output:** the chosen draft's id in the workspace, a `choose` event, and
the draft in `metadata.json`'s `story`.

## 9. Accept

**Does:** marking the story **Final** accepts it. The trace records the
outcome (`accepted`), which draft it came from, and whether it was edited by
hand after being chosen. Clearing an engine-written story records
`discarded`.

**Choices:** Final, or not yet. A final story is locked against Generate,
Revise and Clear until it is unmarked.

## 10. Record (not built)

**Does:** tags the accepted story into corpus memory: its tropes, seed, form
and constraint, plus opener and n-gram statistics. Existing stories are
backfilled once. Corpus memory feeds the novelty filter (stage 3) and the
weight-tuning report (see "Tuning"). The writer never reads it.

## After the story

Once stories are final, the rest of the tile's metadata follows. These are
outside the story engine, but they read the story:
- **Title:** `python -m babel_index_review.titles DIR`, from the image and
  final story.
- **Alt text:** `python -m babel_index_review.alt_text DIR`, from the image
  and keywords only.
- **Sensitive-content tags:** `python -m babel_index_review.sensitive_tags DIR`.

## Evaluators

Each judging point has an owner:

| Judging point | Stage | Default owner |
| --- | --- | --- |
| Novelty flags | 3 | `llm` (once built) |
| Pitch review | 4 | `human` |
| Critic | 6 | `llm`, optional |
| Critique | 7 | `human` |
| Draft choice | 8 | `human` |
| Final accept | 9 | `human` |

- `human`: shown in the review GUI, with the image visible.
- `llm`: a judging model, usually stronger than the pitching model.
- `auto`: pass everything through.

Human decisions are recorded in the same trace format an LLM judge would
produce, so they become calibration data. The live site's favorite counts
are a second calibration signal. The open question is where human judgment
pays off: if an early human pick means fewer drafts are thrown away later,
the traces should show it.

## Tuning

The maintainer tunes the engine between sessions:
- **Weights.** Raise seeds, forms and constraints that keep producing chosen
  stories; lower those that don't. A weight of 0 removes an entry from draws
  but keeps it available by hand. A report over the traces gives choice and
  accept rates per seed, form and constraint.
- **Lists.** Add or remove entries in the `data/story_*.json` files. No code
  change needed.
- **Prompts.** Notes from pitch review and the critique export
  (`python -m babel_index_review.story_critiques DIR`) are distilled into
  `story_preferences.md`, then into `pitch_prompt` and `write_prompt`.

## The workspace

`DIR/story_traces/<tile stem>.json`, rewritten on every change. It is the
review GUI's state for the tile:
- the current reading;
- every pitch, with its seed, fields, kept flag, note and where it came from
  (a model call or a hand-written pitch);
- every draft, with its pitch, form, constraint, text, the writer's prompt,
  earlier versions and any open objection;
- the chosen draft's id.

Pitches and drafts have ids that never change, so a hand edit never loses a
mark. A tile with a trace but no workspace (one reviewed before the
workspace existed) is imported from its trace on first open.

## The trace

`DIR/story_traces/<tile stem>.jsonl`, one JSON event per line, append-only.
It logs each model call (prompt, raw reply, parsed result) and each choice
and outcome, for debugging and calibration. Nothing reads it back except the
one-time workspace import.

| Stage | Holds |
| --- | --- |
| `pitch` | model, offered seeds, prompt, raw replies, reading (first call only) and pitches |
| `reading` | a reading regenerated on its own |
| `write` | pitch id, form, constraint, prompt, raw reply, story |
| `check` | lint and critic findings (once built) |
| `revise` | draft id, request, and either the result or the writer's objection |
| `choose` | the chosen draft |
| `outcome` | `accepted` or `discarded`, edited or not |
