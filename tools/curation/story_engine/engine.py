"""
The staged story engine: read the image, pitch premises, write one.

Each stage is a separate model call with a narrow job, so no single prompt
has to invent, choose and write at once. The stages:

1. ``read``: notes on the image (its enigma, what departs from the base
   scene, which keywords show). Cached per subject in the trace log.
2. ``pitch``: one-line premises, one per payload drawn by weight. Each
   carries a ``turn``, the event, revelation or idea the reader gets.
3. Selection happens outside the engine (the review GUI, for now).
4. ``write``: the story, from one pitch and a form drawn by weight.

Everything project-specific lives in the ``Frame``, so the engine carries
no knowledge of Babel Index. The writer never sees other stories: feeding it
the corpus makes it copy the corpus's patterns.
"""

from __future__ import annotations

import random
from dataclasses import asdict, dataclass, field

from story_engine import llm
from story_engine.llm import ReplyError, require_str, require_str_list
from story_engine.options import Option, by_name, draw
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
    - ``pitch_limits``: word caps on each pitch field, enforced by the
      validator. A model stretches a sentence limit indefinitely, but a
      counted cap comes back with the exact overrun and gets fixed on retry.
    """

    subject: str
    base_scene: str
    presentation: str
    voice: str
    payloads: list[Option]
    forms: list[Option]
    word_limit: int = 150
    pitch_count: int = 6
    pitch_limits: dict[str, int] = field(
        default_factory=lambda: {"premise": 20, "turn": 20, "anchor": 12}
    )
    style_rules: list[str] = field(default_factory=list)


@dataclass
class Reading:
    enigma: str
    differences: list[str]
    details: list[str]
    visible_keywords: list[str]
    intersections: list[dict]

    def as_notes(self) -> str:
        """The reading as plain bullet notes for a later prompt."""
        lines = [f"- Enigma: {self.enigma}"]
        lines += [f"- Departs from the base scene: {d}" for d in self.differences]
        lines += [f"- Detail: {d}" for d in self.details]
        shown = ", ".join(self.visible_keywords) or "none clearly"
        lines.append(f"- Keywords visible in the image: {shown}")
        lines += [
            f"- Intersection ({', '.join(i['keywords'])}): {i['idea']}" for i in self.intersections
        ]
        return "\n".join(lines)


@dataclass
class Pitch:
    payload: str
    premise: str
    anchor: str
    turn: str


@dataclass
class PitchBatch:
    run: str
    pitches: list[Pitch]


# ---------------------------------------------------------------------------
# Validators: raw parsed JSON -> dataclasses, or ReplyError
# ---------------------------------------------------------------------------
def _validate_reading(data: object) -> Reading:
    if not isinstance(data, dict):
        raise ReplyError("expected a JSON object")
    intersections = data.get("intersections", [])
    if not isinstance(intersections, list):
        raise ReplyError("'intersections' must be a list")
    cleaned = []
    for i, item in enumerate(intersections):
        if not isinstance(item, dict):
            raise ReplyError(f"intersections[{i}] must be an object")
        cleaned.append(
            {
                "keywords": require_str_list(item, "keywords", f"intersections[{i}]", allow_empty=False),
                "idea": require_str(item, "idea", f"intersections[{i}]"),
            }
        )
    return Reading(
        enigma=require_str(data, "enigma", "reading"),
        differences=require_str_list(data, "differences", "reading"),
        details=require_str_list(data, "details", "reading"),
        visible_keywords=require_str_list(data, "visible_keywords", "reading"),
        intersections=cleaned,
    )


def _pitch_validator(payloads: list[Option], limits: dict[str, int]):
    names = {option.name.casefold(): option.name for option in payloads}

    def validate(data: object) -> list[Pitch]:
        if not isinstance(data, dict) or not isinstance(data.get("pitches"), list):
            raise ReplyError("expected {\"pitches\": [...]}")
        pitches = []
        overruns = []
        for i, item in enumerate(data["pitches"]):
            where = f"pitches[{i}]"
            if not isinstance(item, dict):
                raise ReplyError(f"{where} must be an object")
            payload = require_str(item, "payload", where)
            if payload.casefold() not in names:
                raise ReplyError(f"{where}: payload {payload!r} is not one of {sorted(names.values())}")
            fields = {key: require_str(item, key, where) for key in ("premise", "anchor", "turn")}
            for key, text in fields.items():
                count, cap = len(text.split()), limits.get(key)
                if cap is not None and count > cap:
                    overruns.append(f"{where}.{key} has {count} words, over the cap of {cap}")
            pitches.append(Pitch(payload=names[payload.casefold()], **fields))
        if overruns:
            raise ReplyError(
                "; ".join(overruns)
                + ". Cut each of these down to its core concept; don't just compress the wording"
            )
        if not pitches:
            raise ReplyError("no pitches")
        return pitches

    return validate


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
def _bullets(options: list[Option]) -> str:
    return "\n".join(f"- {option.name}: {option.description}" for option in options)


def read_prompt(frame: Frame, keywords: list[str]) -> str:
    return (
        f"{frame.subject}\n\n"
        "Study this image and take notes for a writer who will build a short "
        "story on it. You are not writing the story.\n\n"
        f"Every image in the series shares a base scene: {frame.base_scene}. "
        f"This one was generated from the keywords: {', '.join(keywords)}.\n\n"
        "Reply with a JSON object with these fields:\n"
        '- "enigma": the single most unexplained thing in the frame, the detail a '
        "curious viewer would most want explained. One concrete sentence. If "
        "nothing is strange, pick the detail that raises the most questions.\n"
        '- "differences": what this image adds to the base scene or where it '
        "departs from it. Concrete, most striking first, at most six.\n"
        '- "details": other specific visible things a writer could build on: '
        "objects, marks, materials, figures, light. At most six.\n"
        '- "visible_keywords": the keywords that visibly shaped the image. '
        "Keywords often have little visible effect; list only ones you can point to.\n"
        '- "intersections": one or two pairings of keywords, or of a keyword and '
        "a visible detail, whose collision suggests something neither suggests "
        'alone. Each is {"keywords": [...], "idea": "one sentence"}.\n\n'
        "Describe only what is there. If text or a figure is illegible or "
        "ambiguous, say so rather than inventing it. Reply with only the JSON object."
    )


def pitch_prompt(frame: Frame, keywords: list[str], reading: Reading, payloads: list[Option]) -> str:
    limits = frame.pitch_limits

    def cap(key: str) -> str:
        return f" At most {limits[key]} words." if key in limits else ""

    return (
        f"{frame.subject}\n{frame.presentation}\n\n"
        f"Notes on this image:\n{reading.as_notes()}\n"
        f"Keywords: {', '.join(keywords)}\n\n"
        f"Pitch {len(payloads)} premises for a very short story, at most "
        f"{frame.word_limit} words, to go with this image: one pitch for each "
        "payload below. A payload is what the reader gets out of the story.\n"
        f"{_bullets(payloads)}\n\n"
        "Each pitch is a JSON object:\n"
        '- "payload": the name of the payload it was written for.\n'
        '- "premise": the core concept, the one thing the story is built on.'
        f"{cap('premise')}\n"
        '- "anchor": the image detail or keyword intersection the premise grows '
        f"from, named plainly.{cap('anchor')}\n"
        '- "turn": what the reader walks away with: an event, a revelation, or '
        f"an idea. Not a mood, an atmosphere or a description.{cap('turn')}\n\n"
        "A pitch is a concept, not a draft. Keep only what the hook needs to "
        "work: no setting, no names, no sensory texture, no backstory, no "
        "second idea. The writer adds texture later. If a detail could be "
        "removed and the hook would still land, remove it. The word caps are "
        "counted, and a pitch over its cap is rejected.\n\n"
        "What makes a good pitch:\n"
        "- The turn is the point. If you can't state a turn that would make a "
        "reader sit up, the premise isn't ready.\n"
        "- A premise can hinge on a mechanism, a rule or a procedure, but then "
        "the turn has to show why it exists, or how it works, in a way worth "
        "knowing. A rule that exists only to carry a penalty gives the reader nothing.\n"
        "- The premise depends on its anchor. If it could move to a different "
        "image unchanged, it isn't anchored.\n"
        "- The story need not be about this room or its books. It can be about "
        "anyone or anything, as long as it grows out of the image.\n"
        "- A reader grasps the premise in one pass.\n"
        "- The pitches differ from each other in subject and in shape, not just in payload.\n\n"
        'Reply with only a JSON object: {"pitches": [...]}.'
    )


def write_prompt(frame: Frame, keywords: list[str], reading: Reading, pitch: Pitch, form: Option) -> str:
    rules = [
        "The turn lands within the first two sentences. What follows builds on it; nothing delays it.",
        "Keep the story light to read. A passing detail is welcome when it costs "
        "the reader nothing: an unexplained name that hints at a larger world, "
        "an image that adds rhythm. What to avoid is density: a reader should "
        "never have to hold several new particulars at once to follow the turn. "
        "When a sentence stacks up details, keep the one that matters most and cut the rest.",
        frame.voice,
        "Don't describe the image. It is shown beside the story.",
        f"The image was generated from the keywords {', '.join(keywords)}. Take tone "
        "and texture from them, but don't name them and don't use any names they "
        "contain. The reader sees them separately.",
        f"Hard limit of {frame.word_limit} words. That's a budget, not a target.",
        *frame.style_rules,
    ]
    return (
        f"{frame.subject}\n{frame.presentation}\n\n"
        f"Notes on this image:\n{reading.as_notes()}\n\n"
        "Write the story from this pitch:\n"
        f"- Premise: {pitch.premise}\n"
        f"- Turn: {pitch.turn}\n"
        f"- Anchor: {pitch.anchor}\n"
        f"- Payload: {pitch.payload}\n\n"
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
    to the model. Every method blocks on the network, so a GUI calls them
    off its main thread. Only the trace file is written; where an accepted
    story is stored is the caller's business.
    """

    def __init__(self, frame: Frame, trace: TraceLog, rng: random.Random | None = None):
        self.frame = frame
        self.trace = trace
        self.rng = rng or random.Random()

    def cached_reading(self, subject: str) -> Reading | None:
        event = self.trace.latest(subject, "read")
        if event is None:
            return None
        return Reading(**event["result"])

    def read(self, subject: str, image: str, keywords: list[str], model: str, refresh: bool = False) -> Reading:
        """The cached reading, or a fresh one when there is none or ``refresh`` is set."""
        if not refresh:
            cached = self.cached_reading(subject)
            if cached is not None:
                return cached
        prompt = read_prompt(self.frame, keywords)
        reading, raws = llm.ask_json(image, prompt, model, _validate_reading)
        self.trace.append(
            subject,
            {"stage": "read", "model": model, "prompt": prompt, "raw": raws, "result": asdict(reading)},
        )
        return reading

    def pitch(self, subject: str, image: str, keywords: list[str], model: str) -> PitchBatch:
        """A fresh batch of pitches, reading the image first if it isn't cached."""
        reading = self.read(subject, image, keywords, model)
        payloads = draw(self.frame.payloads, self.frame.pitch_count, self.rng)
        prompt = pitch_prompt(self.frame, keywords, reading, payloads)
        validate = _pitch_validator(self.frame.payloads, self.frame.pitch_limits)
        pitches, raws = llm.ask_json(image, prompt, model, validate, retries=2)
        run = new_run_id()
        self.trace.append(
            subject,
            {
                "stage": "pitch",
                "run": run,
                "model": model,
                "assigned_payloads": [option.name for option in payloads],
                "prompt": prompt,
                "raw": raws,
                "result": [asdict(p) for p in pitches],
            },
        )
        return PitchBatch(run, pitches)

    def draw_form(self) -> Option:
        return draw(self.frame.forms, 1, self.rng)[0]

    def write(
        self,
        subject: str,
        image: str,
        keywords: list[str],
        run: str,
        pitch: Pitch,
        model: str,
        form: str | None = None,
    ) -> tuple[str, str]:
        """Write a story from ``pitch``. Returns ``(story, form_name)``.

        ``form`` names a form to use; ``None`` draws one by weight.
        """
        reading = self.read(subject, image, keywords, model)
        chosen = by_name(self.frame.forms, form) if form else self.draw_form()
        prompt = write_prompt(self.frame, keywords, reading, pitch, chosen)
        raw = llm.ask(image, [("user", prompt)], model)
        story = _clean_story(raw)
        self.trace.append(
            subject,
            {
                "stage": "write",
                "run": run,
                "model": model,
                "pitch": asdict(pitch),
                "form": chosen.name,
                "form_drawn": form is None,
                "prompt": prompt,
                "raw": [raw],
                "result": story,
            },
        )
        return story, chosen.name

    def record_outcome(self, subject: str, outcome: str, story: str | None = None, **extra) -> None:
        """Log a human decision (``accepted``, ``discarded``, ...) for calibration."""
        self.trace.append(subject, {"stage": "outcome", "outcome": outcome, "story": story, **extra})
