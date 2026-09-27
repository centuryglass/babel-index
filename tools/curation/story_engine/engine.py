"""
The staged story engine: pitch premises, then draft several at once.

Each stage is a separate model call with a narrow job, so no single prompt
has to invent, choose and write at once. The stages:

1. ``pitch``: a short reading of the image (its enigma, what the pitches
   build on) and one high-concept pitch per seed, each seed chosen by the
   model from a weighted menu. A pitch carries a ``hook``: what the reader
   keeps, which may be a turn, a deliberate open question, a joke, a
   recognizable behavior or an image.
2. A human rejects pitches with obvious flaws. Pitch review is a coarse
   filter only: many stories that work on the page read as nothing in pitch
   form, so the real choice happens between drafts.
3. ``write``: one draft per surviving pitch, written in parallel, each in a
   form drawn by weight and sometimes with an odd constraint.
4. A human chooses a draft (outside the engine).

The reading is part of each pitch reply, not a cached stage of its own. The
writer gets it so both calls work from one interpretation of the image,
since a model's reasoning never carries between calls. A fresh reading per
batch keeps re-pitched batches from anchoring on the same details.

Everything project-specific lives in the ``Frame``, so the engine carries
no knowledge of Babel Index. The writer never sees other stories: feeding it
the corpus makes it copy the corpus's patterns.
"""

from __future__ import annotations

import random
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field

from story_engine import llm
from story_engine.llm import ReplyError, require_str, require_str_list
from story_engine.options import Option, OptionSet
from story_engine.trace import TraceLog, new_run_id


@dataclass
class Frame:
    """What the engine is writing for. Prose fields are pasted into prompts.

    - ``subject``: what one image is and where it sits.
    - ``base_scene``: what every image shares, so the reading can say what
      differs.
    - ``presentation``: how the reader meets the story.
    - ``voice``: the stance the writer takes.
    - ``style_rules``: extra writing rules, one per list entry.
    - ``seed_menu``: how many more seeds to offer than there are pitches.
      The model picks the ones that suit the image; a seed forced onto an
      image that can't support it produces a contrived premise.
    - ``constraint_chance``: the probability a draft gets an odd constraint.
    - ``pitch_limits``: word caps on each pitch field, enforced by the
      validator. A model stretches a sentence limit indefinitely, but a
      counted cap comes back with the exact overrun and gets fixed on retry.
    """

    subject: str
    base_scene: str
    presentation: str
    voice: str
    seeds: OptionSet
    forms: OptionSet
    constraints: OptionSet | None = None
    constraint_chance: float = 0.25
    word_limit: int = 150
    pitch_count: int = 6
    seed_menu: int = 4
    pitch_limits: dict[str, int] = field(
        default_factory=lambda: {"pitch": 15, "hook": 20, "anchor": 12}
    )
    style_rules: list[str] = field(default_factory=list)


@dataclass
class Reading:
    """What the pitcher saw in the image, passed on to the writer."""

    enigma: str
    notes: list[str]

    def as_notes(self) -> str:
        return "\n".join([f"- Enigma: {self.enigma}", *(f"- {note}" for note in self.notes)])


@dataclass
class Pitch:
    seed: str
    pitch: str
    hook: str
    anchor: str


@dataclass
class PitchBatch:
    run: str
    reading: Reading
    pitches: list[Pitch]

    @classmethod
    def from_event(cls, event: dict) -> "PitchBatch | None":
        """Rebuild a batch from its trace event, or None for an older or unreadable format."""
        try:
            result = event["result"]
            return cls(
                run=event["run"],
                reading=Reading(**result["reading"]),
                pitches=[Pitch(**p) for p in result["pitches"]],
            )
        except (KeyError, TypeError):
            return None


@dataclass
class Draft:
    index: int  # the pitch's position in its batch
    form: str
    constraint: str | None
    story: str


# ---------------------------------------------------------------------------
# Validator: raw parsed JSON -> (Reading, [Pitch]), or ReplyError
# ---------------------------------------------------------------------------
def _pitch_validator(offered: list[Option], count: int, limits: dict[str, int]):
    names = {option.name.casefold(): option.name for option in offered}

    def validate(data: object) -> tuple[Reading, list[Pitch]]:
        if not isinstance(data, dict):
            raise ReplyError("expected a JSON object")
        raw_reading = data.get("reading")
        if not isinstance(raw_reading, dict):
            raise ReplyError("expected a \"reading\" object")
        reading = Reading(
            enigma=require_str(raw_reading, "enigma", "reading"),
            notes=require_str_list(raw_reading, "notes", "reading"),
        )
        if not isinstance(data.get("pitches"), list):
            raise ReplyError("expected a \"pitches\" list")
        pitches = []
        overruns = []
        used = set()
        for i, item in enumerate(data["pitches"]):
            where = f"pitches[{i}]"
            if not isinstance(item, dict):
                raise ReplyError(f"{where} must be an object")
            seed = require_str(item, "seed", where)
            if seed.casefold() not in names:
                raise ReplyError(f"{where}: seed {seed!r} is not one of {sorted(names.values())}")
            if seed.casefold() in used:
                raise ReplyError(f"{where}: seed {seed!r} is used twice; each pitch needs its own")
            used.add(seed.casefold())
            fields = {key: require_str(item, key, where) for key in ("pitch", "hook", "anchor")}
            for key, text in fields.items():
                words, cap = len(text.split()), limits.get(key)
                if cap is not None and words > cap:
                    overruns.append(f"{where}.{key} has {words} words, over the cap of {cap}")
            pitches.append(Pitch(seed=names[seed.casefold()], **fields))
        if overruns:
            raise ReplyError(
                "; ".join(overruns)
                + ". Cut each of these down to its core concept; don't just compress the wording"
            )
        if len(pitches) != count:
            raise ReplyError(f"expected {count} pitches, got {len(pitches)}")
        return reading, pitches

    return validate


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
def _bullets(options: list[Option]) -> str:
    return "\n".join(f"- {option.name}: {option.description}" for option in options)


def pitch_prompt(frame: Frame, keywords: list[str], offered: list[Option], count: int) -> str:
    limits = frame.pitch_limits

    def cap(key: str) -> str:
        return f" At most {limits[key]} words." if key in limits else ""

    return (
        f"{frame.subject}\n{frame.presentation}\n\n"
        f"Every image in the series shares a base scene: {frame.base_scene}. "
        f"This one was generated from the keywords: {', '.join(keywords)}.\n\n"
        "Start by studying the image. Find its enigma: the single most "
        "unexplained thing in the frame, the detail a curious viewer would most "
        "want explained. Notice what departs from the base scene, which keywords "
        "visibly shaped the image (often few do), and where the ordinary and the "
        "strange meet in it. Describe only what is there; if text or a figure is "
        "illegible or ambiguous, don't invent it.\n\n"
        f"Then pitch {count} ideas for a very short story, at most "
        f"{frame.word_limit} words, to go with this image. Each grows from a "
        f"different seed. Choose the {count} seeds below that this image "
        "supports best, and skip the ones it would have to be forced into:\n"
        f"{_bullets(offered)}\n\n"
        "Each pitch is a JSON object:\n"
        '- "seed": the name of the seed it grows from.\n'
        '- "pitch": the idea in one high-concept line, the way a writer pitches '
        "it to a friend: \"a wizard exploits a glitch in the building for petty "
        "gain\", \"a children's party venue, as seen by a culture with no "
        f"reference for it\".{cap('pitch')}\n"
        '- "hook": what a reader keeps from the story. It can be a turn, an open '
        "question with several intriguing answers, a joke, a recognizable human "
        f"behavior in a strange setting, or an arresting image.{cap('hook')}\n"
        '- "anchor": the thing in the image the pitch grows from, named plainly.'
        f"{cap('anchor')}\n\n"
        "A pitch is a concept, not a draft. Leave out setting, names, sensory "
        "texture and backstory; the writer adds those later. The word caps are "
        "counted, and a pitch over its cap is rejected.\n\n"
        "What tends to work:\n"
        "- People behaving like people: rituals, hacks, petty schemes, hobbies, "
        "grievances, misunderstandings, routines, dares. Petty, superstitious, "
        "reckless or incompetent is fine; acting only to serve the plot is not.\n"
        "- A strange mechanism is best when people live with it: they use it, "
        "exploit it, work around it, or have made it routine.\n"
        "- Small, specific stakes over large, abstract ones. Drama about strangers "
        "the reader knows nothing about rarely lands.\n"
        "- Leave questions open on purpose, but not by accident. If the first "
        "skeptical question (\"why not just...?\", \"how would that even work?\") "
        "sinks the premise, fix it or drop it.\n"
        "- Dry, straight-faced absurdity usually works better than earnest melodrama.\n"
        "- Real things from our world (places, practices, subcultures, the "
        "history behind a keyword) can be moved into this one.\n"
        "- A pitch may reinterpret what something in the image is, but never "
        "claim it looks different from how it does. Keywords can shape the world, "
        "but the anchor must be visible.\n"
        "- The story need not be about this room or its books, as long as it "
        "grows out of the image.\n"
        "- The pitches differ from each other in subject and in shape.\n\n"
        "Reply with only a JSON object:\n"
        '{"reading": {"enigma": "one sentence", "notes": ["a few short notes on '
        'what the pitches build on"]}, "pitches": [...]}\n'
        "The reading is passed to the writer, so keep it to what's visible and useful."
    )


def write_prompt(
    frame: Frame,
    keywords: list[str],
    reading: Reading,
    pitch: Pitch,
    form: Option,
    constraint: Option | None,
) -> str:
    rules = [
        "The hook arrives within the first two sentences. What follows builds on it; nothing delays it.",
        "Keep the story light to read. Each detail can carry its own small "
        "idea, a joke or a strange fact, and a passing detail that costs the "
        "reader nothing is welcome: an unexplained name that hints at a larger "
        "world, an image that adds rhythm. Avoid chains of detail, where each "
        "particular exists to explain the one before it; that is what slows a reader down.",
        frame.voice,
        "Don't describe the image. It is shown beside the story.",
        f"The image was generated from the keywords {', '.join(keywords)}. Take tone "
        "and texture from them, but don't name them and don't use any names they "
        "contain. The reader sees them separately.",
        f"Hard limit of {frame.word_limit} words. That's a budget, not a target.",
        *frame.style_rules,
    ]
    if constraint is not None:
        rules.append(f"An extra constraint for this one: {constraint.description}")
    return (
        f"{frame.subject}\n{frame.presentation}\n\n"
        f"Notes on this image:\n{reading.as_notes()}\n\n"
        "Write the story from this pitch:\n"
        f"- Pitch: {pitch.pitch}\n"
        f"- Hook: {pitch.hook}\n"
        f"- Anchor: {pitch.anchor}\n\n"
        "The pitch is a starting point. Keep its hook, but where the pitch is "
        "thin, the texture and voice you bring are what make it work. The pitch "
        "fields are notes to you, not text: don't reuse their wording.\n\n"
        f"Form: {form.name}. {form.description}\n\n"
        "Rules:\n" + "\n".join(f"- {rule}" for rule in rules) + "\n\n"
        "Reply with only the story: no title, no preamble, no quotation marks "
        "around it, no markdown. Plain line breaks are fine where the form needs them."
    )


def _clean_story(text: str) -> str:
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
    return text


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
class Engine:
    """Runs the stages for one frame, logging each to ``trace``.

    ``subject`` is the trace log's per-image id; ``image`` is the file sent
    to the model. Every method that calls a model blocks on the network, so a
    GUI calls them off its main thread. Only the trace file is written; where
    a chosen story is stored is the caller's business.
    """

    def __init__(self, frame: Frame, trace: TraceLog, rng: random.Random | None = None):
        self.frame = frame
        self.trace = trace
        self.rng = rng or random.Random()

    # -- Pitching --------------------------------------------------------------
    def pitch(self, subject: str, image: str, keywords: list[str], model: str) -> PitchBatch:
        """A fresh reading and batch of pitches."""
        count = self.frame.pitch_count
        offered = self.frame.seeds.draw(count + self.frame.seed_menu, self.rng)
        count = min(count, len(offered))
        prompt = pitch_prompt(self.frame, keywords, offered, count)
        validate = _pitch_validator(offered, count, self.frame.pitch_limits)
        (reading, pitches), raws = llm.ask_json(image, prompt, model, validate, retries=2)
        run = new_run_id()
        self.trace.append(
            subject,
            {
                "stage": "pitch",
                "run": run,
                "model": model,
                "offered_seeds": [option.name for option in offered],
                "prompt": prompt,
                "raw": raws,
                "result": {"reading": asdict(reading), "pitches": [asdict(p) for p in pitches]},
            },
        )
        return PitchBatch(run, reading, pitches)

    def latest_batch(self, subject: str) -> PitchBatch | None:
        event = self.trace.latest(subject, "pitch")
        return PitchBatch.from_event(event) if event else None

    # -- Drafting --------------------------------------------------------------
    def write(
        self,
        subject: str,
        image: str,
        keywords: list[str],
        batch: PitchBatch,
        index: int,
        model: str,
        form: str | None = None,
    ) -> Draft:
        """Write one draft from pitch ``index`` of ``batch``.

        ``form`` names a form to use; ``None`` draws one by weight. A drawn
        draft also gets an odd constraint with ``constraint_chance``.
        """
        pitch = batch.pitches[index]
        chosen = self.frame.forms.by_name(form) if form else self.frame.forms.draw(1, self.rng)[0]
        constraint = None
        if self.frame.constraints and self.rng.random() < self.frame.constraint_chance:
            constraint = self.frame.constraints.draw(1, self.rng)[0]
        prompt = write_prompt(self.frame, keywords, batch.reading, pitch, chosen, constraint)
        raw = llm.ask(image, [("user", prompt)], model)
        draft = Draft(index, chosen.name, constraint.name if constraint else None, _clean_story(raw))
        self.trace.append(
            subject,
            {
                "stage": "write",
                "run": batch.run,
                "index": index,
                "model": model,
                "pitch": asdict(pitch),
                "form": draft.form,
                "form_drawn": form is None,
                "constraint": draft.constraint,
                "prompt": prompt,
                "raw": [raw],
                "result": draft.story,
            },
        )
        return draft

    def write_drafts(
        self,
        subject: str,
        image: str,
        keywords: list[str],
        batch: PitchBatch,
        indices: list[int],
        model: str,
        form: str | None = None,
        workers: int = 6,
    ) -> tuple[list[Draft], list[str]]:
        """Write a draft for each pitch in ``indices`` in parallel.

        Returns ``(drafts, errors)``, drafts in ``indices`` order. One failed
        call costs only its own draft.
        """
        drafts: list[Draft] = []
        errors: list[str] = []
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futures = [
                pool.submit(self.write, subject, image, keywords, batch, i, model, form) for i in indices
            ]
            for i, future in zip(indices, futures):
                try:
                    drafts.append(future.result())
                except Exception as err:  # reported to the caller with the pitch it belongs to
                    errors.append(f"pitch {i + 1}: {err}")
        return drafts, errors

    def drafts(self, subject: str, run: str) -> list[Draft]:
        """Every draft written from batch ``run``, oldest first."""
        return [
            Draft(e["index"], e["form"], e.get("constraint"), e["result"])
            for e in self.trace.events(subject)
            if e.get("stage") == "write" and e.get("run") == run and "index" in e
        ]

    # -- Human judgments -------------------------------------------------------
    def _latest_per_target(self, subject: str, run: str, stage: str) -> dict:
        out = {}
        for event in self.trace.events(subject):
            if event.get("stage") == stage and event.get("run") == run:
                out[event["index"]] = event
        return out

    def record_verdict(self, subject: str, run: str, index: int, rejected: bool) -> None:
        """Log a pitch rejected (or restored) at review. A later verdict replaces an earlier one."""
        self.trace.append(subject, {"stage": "verdict", "run": run, "index": index, "rejected": rejected})

    def rejected(self, subject: str, run: str) -> set[int]:
        latest = self._latest_per_target(subject, run, "verdict")
        return {index for index, event in latest.items() if event["rejected"]}

    def record_critique(self, subject: str, run: str, index: int | None, text: str) -> None:
        """Log a human critique of pitch ``index`` in batch ``run``.

        ``index`` None is a note on the whole batch. A later critique of the
        same target replaces an earlier one, and empty text clears it.
        """
        self.trace.append(subject, {"stage": "critique", "run": run, "index": index, "text": text})

    def critiques(self, subject: str, run: str) -> dict[int | None, str]:
        """The current critique text per pitch index (None for the batch) in ``run``."""
        latest = self._latest_per_target(subject, run, "critique")
        return {index: event["text"] for index, event in latest.items() if event["text"]}

    def record_choice(self, subject: str, run: str, draft: Draft) -> None:
        """Log the draft a human chose as the tile's story."""
        self.trace.append(subject, {"stage": "choose", "run": run, **asdict(draft)})

    def record_outcome(self, subject: str, outcome: str, story: str | None = None, **extra) -> None:
        """Log a human decision (``accepted``, ``discarded``, ...) for calibration."""
        self.trace.append(subject, {"stage": "outcome", "outcome": outcome, "story": story, **extra})
