"""
The staged story engine: pitch premises, then write one.

Each stage is a separate model call with a narrow job, so no single prompt
has to invent, choose and write at once. The stages:

1. ``pitch``: a short reading of the image (its enigma, what the pitches
   build on) and one premise per payload drawn by weight. Each premise
   carries a ``turn``, the event, revelation or idea the reader gets.
2. Selection happens outside the engine (the review GUI, for now).
3. ``write``: the story, from one pitch, its batch's reading, and a form
   drawn by weight.

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
    """What the pitcher saw in the image, passed on to the writer."""

    enigma: str
    notes: list[str]

    def as_notes(self) -> str:
        return "\n".join([f"- Enigma: {self.enigma}", *(f"- {note}" for note in self.notes)])


@dataclass
class Pitch:
    payload: str
    premise: str
    anchor: str
    turn: str


@dataclass
class PitchBatch:
    run: str
    reading: Reading
    pitches: list[Pitch]

    @classmethod
    def from_event(cls, event: dict) -> "PitchBatch | None":
        """Rebuild a batch from its trace event, or None for an unreadable one."""
        result = event.get("result")
        if not isinstance(result, dict):
            return None
        return cls(
            run=event["run"],
            reading=Reading(**result["reading"]),
            pitches=[Pitch(**p) for p in result["pitches"]],
        )


# ---------------------------------------------------------------------------
# Validator: raw parsed JSON -> (Reading, [Pitch]), or ReplyError
# ---------------------------------------------------------------------------
def _pitch_validator(payloads: list[Option], limits: dict[str, int]):
    names = {option.name.casefold(): option.name for option in payloads}

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
        return reading, pitches

    return validate


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
def _bullets(options: list[Option]) -> str:
    return "\n".join(f"- {option.name}: {option.description}" for option in options)


def pitch_prompt(frame: Frame, keywords: list[str], payloads: list[Option]) -> str:
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
        "visibly shaped the image (often few do), and any pairing of keywords, "
        "or of a keyword and a visible detail, whose collision suggests "
        "something neither suggests alone. Describe only what is there; if text "
        "or a figure is illegible or ambiguous, don't invent it.\n\n"
        f"Then pitch {len(payloads)} premises for a very short story, at most "
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
        "Reply with only a JSON object:\n"
        '{"reading": {"enigma": "one sentence", "notes": ["a few short notes on '
        'what the pitches build on: departures from the base scene, visible '
        'keywords, intersections"]}, "pitches": [...]}\n'
        "The reading is passed to the writer, so keep it to what's visible and useful."
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

    def latest_batch(self, subject: str) -> PitchBatch | None:
        event = self.trace.latest(subject, "pitch")
        return PitchBatch.from_event(event) if event else None

    def pitch(self, subject: str, image: str, keywords: list[str], model: str) -> PitchBatch:
        """A fresh reading and batch of pitches."""
        payloads = draw(self.frame.payloads, self.frame.pitch_count, self.rng)
        prompt = pitch_prompt(self.frame, keywords, payloads)
        validate = _pitch_validator(self.frame.payloads, self.frame.pitch_limits)
        (reading, pitches), raws = llm.ask_json(image, prompt, model, validate, retries=2)
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
                "result": {"reading": asdict(reading), "pitches": [asdict(p) for p in pitches]},
            },
        )
        return PitchBatch(run, reading, pitches)

    def draw_form(self) -> Option:
        return draw(self.frame.forms, 1, self.rng)[0]

    def write(
        self,
        subject: str,
        image: str,
        keywords: list[str],
        batch: PitchBatch,
        pitch: Pitch,
        model: str,
        form: str | None = None,
    ) -> tuple[str, str]:
        """Write a story from ``pitch`` in ``batch``. Returns ``(story, form_name)``.

        ``form`` names a form to use; ``None`` draws one by weight.
        """
        chosen = by_name(self.frame.forms, form) if form else self.draw_form()
        prompt = write_prompt(self.frame, keywords, batch.reading, pitch, chosen)
        raw = llm.ask(image, [("user", prompt)], model)
        story = _clean_story(raw)
        self.trace.append(
            subject,
            {
                "stage": "write",
                "run": batch.run,
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

    def record_critique(self, subject: str, run: str, index: int | None, text: str) -> None:
        """Log a human critique of pitch ``index`` in batch ``run``.

        ``index`` None is a note on the whole batch. A later critique of the
        same target replaces an earlier one, and empty text clears it.
        """
        self.trace.append(subject, {"stage": "critique", "run": run, "index": index, "text": text})

    def critiques(self, subject: str, run: str) -> dict[int | None, str]:
        """The current critique text per pitch index (None for the batch) in ``run``."""
        out: dict[int | None, str] = {}
        for event in self.trace.events(subject):
            if event.get("stage") == "critique" and event.get("run") == run:
                if event["text"]:
                    out[event["index"]] = event["text"]
                else:
                    out.pop(event["index"], None)
        return out

    def record_outcome(self, subject: str, outcome: str, story: str | None = None, **extra) -> None:
        """Log a human decision (``accepted``, ``discarded``, ...) for calibration."""
        self.trace.append(subject, {"stage": "outcome", "outcome": outcome, "story": story, **extra})
