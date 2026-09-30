"""
The staged story engine: pitch premises, draft them, revise drafts.

Each stage is a separate model call with a narrow job, so no single prompt
has to invent, choose and write at once. The stages:

1. ``pitch``: one high-concept pitch per seed, each seed chosen by the model
   from a weighted menu. A pitch carries a ``hook``: what the reader keeps,
   which may be a turn, a deliberate open question, a joke, a recognizable
   behavior or an image. The first pitch call for an image also returns a
   short reading of it (its enigma, what the pitches build on); later calls
   are given that reading and the pitches so far, and add to them.
2. A human rejects pitches with obvious flaws. Pitch review is a coarse
   filter only: many stories that work on the page read as nothing in pitch
   form, so the real choice happens between drafts.
3. ``write``: one draft per kept pitch, each in a form drawn by weight and
   sometimes with an odd constraint.
4. ``revise``: one targeted change to one draft, continuing its writer's
   conversation. The writer may object instead of making the change.
5. A human chooses a draft (outside the engine).

The writer gets the reading so both calls work from one interpretation of
the image, since a model's reasoning never carries between calls. ``read``
regenerates the reading alone.

Every method here makes one model call and returns its result; keeping the
pitch and draft lists is ``workspace.py``'s job.

Everything project-specific lives in the ``Frame``, so the engine carries
no knowledge of Babel Index. The writer never sees other stories: feeding it
the collection makes it copy the collection's patterns.
"""

from __future__ import annotations

import random
from dataclasses import asdict, dataclass, field

from story_engine import llm
from story_engine.llm import ReplyError, require_str, require_str_list
from story_engine.options import Option, OptionSet
from story_engine.trace import TraceLog


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
    - ``constraint_chance``: the default probability a draft gets an odd
      constraint; ``Engine.write`` takes a per-call override.
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
class Draft:
    """A written draft, with the prompt a revision continues from."""

    form: str
    constraint: str | None
    story: str
    prompt: str


@dataclass
class Revision:
    """A revision reply: the revised story, or the writer's objection to the request."""

    story: str | None
    objection: str | None


# ---------------------------------------------------------------------------
# Validators: raw parsed JSON -> engine values, or ReplyError
# ---------------------------------------------------------------------------
def _reading_from(data: object) -> Reading:
    if not isinstance(data, dict):
        raise ReplyError("expected a JSON object")
    raw_reading = data.get("reading")
    if not isinstance(raw_reading, dict):
        raise ReplyError("expected a \"reading\" object")
    return Reading(
        enigma=require_str(raw_reading, "enigma", "reading"),
        notes=require_str_list(raw_reading, "notes", "reading"),
    )


def _pitch_validator(offered: list[Option], count: int, limits: dict[str, int], with_reading: bool):
    """Checks a pitch reply: ``(reading or None, pitches)``."""
    names = {option.name.casefold(): option.name for option in offered}

    def validate(data: object) -> tuple[Reading | None, list[Pitch]]:
        if not isinstance(data, dict):
            raise ReplyError("expected a JSON object")
        reading = _reading_from(data) if with_reading else None
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


def _image_intro(frame: Frame, keywords: list[str]) -> str:
    return (
        f"{frame.subject}\n{frame.presentation}\n\n"
        f"Every image in the series shares a base scene: {frame.base_scene}. "
        f"This one was generated from the keywords: {', '.join(keywords)}.\n\n"
    )


_STUDY = (
    "Study the image. Find its enigma: the single most unexplained thing in "
    "the frame, the detail a curious viewer would most want explained. Notice "
    "what departs from the base scene, which keywords visibly shaped the image "
    "(often few do), and where the ordinary and the strange meet in it. "
    "Describe only what is there; if text or a figure is illegible or "
    "ambiguous, don't invent it."
)

_READING_SHAPE = (
    '{"reading": {"enigma": "one sentence", "notes": ["a few short notes on '
    'what the pitches build on"]}'
)


def reading_prompt(frame: Frame, keywords: list[str]) -> str:
    """Asks for the reading alone, to replace one that missed something."""
    return (
        _image_intro(frame, keywords)
        + _STUDY
        + "\n\nThe notes are passed to a writer who will pitch and write very "
        "short stories for this image, so keep them to what's visible and useful.\n\n"
        "Reply with only a JSON object:\n" + _READING_SHAPE + "}"
    )


def pitch_prompt(
    frame: Frame,
    keywords: list[str],
    offered: list[Option],
    count: int,
    reading: Reading | None = None,
    existing: list[Pitch] | None = None,
    extra: str = "",
) -> str:
    """The pitch call's prompt.

    With no ``reading`` the reply also carries one. With a ``reading`` the
    model works from it, and ``existing`` lists the pitches it must not
    repeat. ``extra`` is the editor's own instructions for this call.
    """
    limits = frame.pitch_limits

    def cap(key: str) -> str:
        return f" At most {limits[key]} words." if key in limits else ""

    if reading is None:
        start = "Start here. " + _STUDY + "\n\nThen pitch"
    else:
        start = (
            f"Notes from an earlier look at this image:\n{reading.as_notes()}\n\n"
            "Work from these notes and the image. Pitch"
        )
    listed = ""
    if existing:
        listed = (
            "\n\nThese pitches are already on the list. Yours are added to them, "
            "so don't repeat their ideas:\n"
            + "\n".join(f"- [{p.seed}] {p.pitch}" for p in existing)
        )
    editor = f"\n\nAn extra instruction from the editor:\n{extra.strip()}" if extra.strip() else ""
    reply_shape = (
        _READING_SHAPE + ', "pitches": [...]}\n'
        "The reading is passed to the writer, so keep it to what's visible and useful."
        if reading is None
        else '{"pitches": [...]}'
    )
    return (
        _image_intro(frame, keywords)
        + f"{start} {count} ideas for a very short story, at most "
        f"{frame.word_limit} words, to go with this image. Each grows from a "
        f"different seed. Choose the {count} seeds below that this image "
        "supports best, and skip the ones it would have to be forced into:\n"
        f"{_bullets(offered)}{listed}\n\n"
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
        "- A strange rule, practice or mechanism answers at least one of its "
        "whys (why it exists, why it works that way, why people put up with it), "
        "and usually not all of them. One that exists only to hand out a penalty "
        "or a reward is arbitrary.\n"
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
        f"- The pitches differ from each other in subject and in shape.{editor}\n\n"
        "Reply with only a JSON object:\n" + reply_shape
    )


def write_prompt(
    frame: Frame,
    keywords: list[str],
    reading: Reading | None,
    pitch: Pitch | None,
    form: Option | None,
    constraint: Option | None,
    note: str = "",
) -> str:
    """The writer's prompt. ``pitch`` and ``form`` are None for a hand-written draft,
    whose revisions still need the writer's rules as context."""
    rules = [
        "The hook arrives within the first two sentences. What follows builds on it; nothing delays it.",
        "Keep the story light to read. Each detail can carry its own small "
        "idea, a joke or a strange fact, and a passing detail that costs the "
        "reader nothing is welcome: an unexplained name that hints at a larger "
        "world, an image that adds rhythm. Avoid chains of detail, where each "
        "particular exists to explain the one before it; that is what slows a reader down.",
        "A strange rule, practice or mechanism answers at least one of its whys, "
        "and usually not all of them. One that exists only to hand out a penalty "
        "or a reward reads as arbitrary.",
        "Leave a question open only when it has several good answers and the story "
        "gives at least one of its means, motive or consequence. Don't end on a new "
        "mystery the story hasn't set up.",
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
    if pitch is None:
        brief = "Write a story for this image.\n\n"
    else:
        brief = (
            "Write the story from this pitch:\n"
            f"- Pitch: {pitch.pitch}\n"
            f"- Hook: {pitch.hook}\n"
            f"- Anchor: {pitch.anchor}\n"
            + (f"- Editor's note on the pitch: {note.strip()}\n" if note.strip() else "")
            + "\nThe pitch is a starting point. Keep its hook, but where the pitch is "
            "thin, the texture and voice you bring are what make it work. The pitch "
            "fields are notes to you, not text: don't reuse their wording.\n\n"
        )
    return (
        f"{frame.subject}\n{frame.presentation}\n\n"
        + (f"Notes on this image:\n{reading.as_notes()}\n\n" if reading else "")
        + brief
        + (f"Form: {form.name}. {form.description}\n\n" if form else "")
        + "Rules:\n" + "\n".join(f"- {rule}" for rule in rules) + "\n\n"
        "Reply with only the story: no title, no preamble, no quotation marks "
        "around it, no markdown. Plain line breaks are fine where the form needs them."
    )


def revise_prompt(request: str) -> str:
    return (
        "Revise the story you just wrote. Make only the change asked for below, "
        "and keep everything else as it is, word for word where you can.\n\n"
        f"The change: {request.strip()}\n\n"
        "If you think the change would damage what the passage is doing (a "
        "twist, a joke or a setup the request has misread), don't make it. "
        "Reply instead with OBJECTION: followed by a sentence or two on what "
        "the passage is meant to do.\n\n"
        "Otherwise reply with only the full revised story: no preamble, no "
        "quotation marks around it, no markdown. The same rules apply as before."
    )


_OBJECTION = "objection:"


def _parse_revision(raw: str) -> Revision:
    text = raw.strip()
    if text.casefold().startswith(_OBJECTION):
        return Revision(story=None, objection=text[len(_OBJECTION):].strip())
    return Revision(story=_clean_story(text), objection=None)


def _clean_story(text: str) -> str:
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
    return text


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
class Engine:
    """Runs the stages for one frame, logging each model call to ``trace``.

    ``subject`` is the trace log's per-image id; ``image`` is the file sent
    to the model. Every method that calls a model blocks on the network and
    touches no shared state but the trace, so a GUI runs several at once off
    its main thread.
    """

    def __init__(self, frame: Frame, trace: TraceLog, rng: random.Random | None = None):
        self.frame = frame
        self.trace = trace
        self.rng = rng or random.Random()

    # -- Reading and pitching --------------------------------------------------
    def read(self, subject: str, image: str, keywords: list[str], model: str) -> Reading:
        """A reading of the image on its own."""
        prompt = reading_prompt(self.frame, keywords)
        reading, raws = llm.ask_json(image, prompt, model, _reading_from, retries=2)
        self.trace.append(
            subject,
            {"stage": "reading", "model": model, "prompt": prompt, "raw": raws, "result": asdict(reading)},
        )
        return reading

    def pitch(
        self,
        subject: str,
        image: str,
        keywords: list[str],
        model: str,
        count: int | None = None,
        reading: Reading | None = None,
        existing: list[Pitch] | None = None,
        extra: str = "",
    ) -> tuple[Reading | None, list[Pitch]]:
        """``count`` pitches, and a reading when none is given.

        With a ``reading``, the model works from it and adds to ``existing``,
        and the seed menu leaves out seeds ``existing`` already used while
        enough others remain. Returns ``(new reading or None, pitches)``.
        """
        count = count or self.frame.pitch_count
        used = {p.seed for p in existing or []}
        menu = count + self.frame.seed_menu
        offered = self.frame.seeds.draw(menu, self.rng, exclude=used)
        if len(offered) < menu:
            offered += self.frame.seeds.draw(
                menu - len(offered), self.rng, exclude={o.name for o in offered}
            )
        count = min(count, len(offered))
        prompt = pitch_prompt(self.frame, keywords, offered, count, reading, existing, extra)
        validate = _pitch_validator(offered, count, self.frame.pitch_limits, with_reading=reading is None)
        (new_reading, pitches), raws = llm.ask_json(image, prompt, model, validate, retries=2)
        result: dict = {"pitches": [asdict(p) for p in pitches]}
        if new_reading is not None:
            result["reading"] = asdict(new_reading)
        self.trace.append(
            subject,
            {
                "stage": "pitch",
                "model": model,
                "offered_seeds": [option.name for option in offered],
                "prompt": prompt,
                "raw": raws,
                "result": result,
            },
        )
        return new_reading, pitches

    # -- Drafting and revising -------------------------------------------------
    def write(
        self,
        subject: str,
        image: str,
        keywords: list[str],
        reading: Reading | None,
        pitch: Pitch,
        model: str,
        form: str | None = None,
        constraint_chance: float | None = None,
        note: str = "",
        pitch_id: str | None = None,
    ) -> Draft:
        """Write one draft from ``pitch``.

        ``form`` names a form to use; ``None`` draws one by weight. A draft
        gets an odd constraint with ``constraint_chance`` (the frame's when
        None). ``note`` is the reviewer's note on the pitch, passed to the
        writer. ``pitch_id`` only labels the trace event.
        """
        chosen = self.frame.forms.by_name(form) if form else self.frame.forms.draw(1, self.rng)[0]
        chance = self.frame.constraint_chance if constraint_chance is None else constraint_chance
        constraint = None
        if self.frame.constraints and self.rng.random() < chance:
            constraint = self.frame.constraints.draw(1, self.rng)[0]
        prompt = write_prompt(self.frame, keywords, reading, pitch, chosen, constraint, note)
        raw = llm.ask(image, [("user", prompt)], model)
        draft = Draft(chosen.name, constraint.name if constraint else None, _clean_story(raw), prompt)
        self.trace.append(
            subject,
            {
                "stage": "write",
                "pitch_id": pitch_id,
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

    def context_prompt(self, keywords: list[str], reading: Reading | None, pitch: Pitch | None, note: str = "") -> str:
        """A writer's prompt for a draft that has none, e.g. one written by hand."""
        return write_prompt(self.frame, keywords, reading, pitch, None, None, note)

    def revise(
        self,
        subject: str,
        image: str,
        prompt: str,
        story: str,
        request: str,
        model: str,
        draft_id: str | None = None,
    ) -> Revision:
        """Make one targeted change to ``story``, or return the writer's objection.

        Continues the writer's conversation: ``prompt`` (the draft's writer
        prompt), then ``story`` as the writer's own reply, then the request.
        ``story`` is the draft's current text, hand edits included.
        """
        turns = [("user", prompt), ("assistant", story), ("user", revise_prompt(request))]
        raw = llm.ask(image, turns, model)
        revision = _parse_revision(raw)
        self.trace.append(
            subject,
            {
                "stage": "revise",
                "draft_id": draft_id,
                "model": model,
                "request": request,
                "story": story,
                "raw": [raw],
                "result": revision.story,
                "objection": revision.objection,
            },
        )
        return revision

    # -- Human judgments -------------------------------------------------------
    def record_choice(self, subject: str, draft_id: str, story: str) -> None:
        """Log the draft a human chose as the image's story."""
        self.trace.append(subject, {"stage": "choose", "draft_id": draft_id, "story": story})

    def record_outcome(self, subject: str, outcome: str, story: str | None = None, **extra) -> None:
        """Log a human decision (``accepted``, ``discarded``, ...) for tuning."""
        self.trace.append(subject, {"stage": "outcome", "outcome": outcome, "story": story, **extra})
