"""
A subject's review workspace: its reading, every pitch and draft, and the
chosen draft, in one JSON file rewritten on every change.

This is the review state a GUI shows and edits. Pitches and drafts carry ids
that never change, so a hand edit never loses a mark such as the chosen
draft. The list only grows by appending: pitching more adds pitches, and
redrafting adds a draft beside the old one.

The trace (``trace.py``) is a separate append-only log of model calls. The
one place a workspace reads it is ``import_trace``, for a subject reviewed
before workspaces existed.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import asdict, dataclass, field

from story_engine.engine import Pitch, Reading
from story_engine.trace import TraceLog


def new_id() -> str:
    return uuid.uuid4().hex[:10]


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


@dataclass
class PitchEntry:
    """A pitch on the list. ``source`` is the model that pitched it, or ``hand``."""

    id: str
    seed: str
    pitch: str
    hook: str
    anchor: str
    kept: bool = True
    note: str = ""
    source: str = ""
    created: str = ""

    def as_pitch(self) -> Pitch:
        return Pitch(self.seed, self.pitch, self.hook, self.anchor)


@dataclass
class DraftEntry:
    """A draft on the list.

    - ``pitch_id``: the pitch it was written from, or None for a hand-written
      draft. The pitch may since have been deleted.
    - ``prompt``: the writer's prompt, which a revision continues from. None
      for a hand-written draft.
    - ``history``: earlier versions, oldest first, each
      ``{"story", "reason", "time"}`` where ``reason`` says what replaced it.
    - ``objection``: the writer's reply to the last revision request when it
      explained the passage instead of changing it, as ``{"request", "reply"}``.
    """

    id: str
    pitch_id: str | None
    form: str
    constraint: str | None
    story: str
    prompt: str | None = None
    model: str = ""
    history: list[dict] = field(default_factory=list)
    objection: dict | None = None
    dropped: bool = False
    created: str = ""

    def replace_story(self, story: str, reason: str) -> None:
        """Set a new text, keeping the old one in ``history``."""
        if story == self.story:
            return
        self.history.append({"story": self.story, "reason": reason, "time": now()})
        self.story = story

    def last_request(self) -> str | None:
        """The request behind the latest revision, if the latest change was one."""
        if self.history and self.history[-1]["reason"].startswith("revise: "):
            return self.history[-1]["reason"][len("revise: "):]
        return None


@dataclass
class Workspace:
    reading: Reading | None = None
    pitches: list[PitchEntry] = field(default_factory=list)
    drafts: list[DraftEntry] = field(default_factory=list)
    chosen: str | None = None

    def pitch(self, pitch_id: str | None) -> PitchEntry | None:
        return next((p for p in self.pitches if p.id == pitch_id), None)

    def draft(self, draft_id: str | None) -> DraftEntry | None:
        return next((d for d in self.drafts if d.id == draft_id), None)

    def pitch_number(self, pitch_id: str | None) -> int | None:
        """A pitch's 1-based position on the list, as the GUI numbers it."""
        for i, p in enumerate(self.pitches):
            if p.id == pitch_id:
                return i + 1
        return None

    def draft_number(self, draft_id: str | None) -> int | None:
        for i, d in enumerate(self.drafts):
            if d.id == draft_id:
                return i + 1
        return None

    def undrafted_kept(self) -> list[PitchEntry]:
        drafted = {d.pitch_id for d in self.drafts}
        return [p for p in self.pitches if p.kept and p.id not in drafted]

    def to_json(self) -> dict:
        return {
            "reading": asdict(self.reading) if self.reading else None,
            "pitches": [asdict(p) for p in self.pitches],
            "drafts": [asdict(d) for d in self.drafts],
            "chosen": self.chosen,
        }

    @classmethod
    def from_json(cls, data: dict) -> "Workspace":
        reading = data.get("reading")
        return cls(
            reading=Reading(**reading) if reading else None,
            pitches=[PitchEntry(**p) for p in data.get("pitches", [])],
            drafts=[DraftEntry(**d) for d in data.get("drafts", [])],
            chosen=data.get("chosen"),
        )


class WorkspaceStore:
    """Workspaces as ``<directory>/<subject>.json``, beside the trace's ``.jsonl``.

    Not thread-safe: a GUI loads and saves on its main thread and applies
    finished model calls there.
    """

    def __init__(self, directory: str, trace: TraceLog | None = None):
        self.directory = directory
        self.trace = trace

    def path(self, subject: str) -> str:
        return os.path.join(self.directory, f"{subject}.json")

    def load(self, subject: str) -> Workspace:
        """The subject's workspace, imported from its trace if it has none yet."""
        path = self.path(subject)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as file:
                return Workspace.from_json(json.load(file))
        if self.trace is not None:
            workspace = import_trace(self.trace.events(subject))
            if workspace.pitches or workspace.drafts:
                self.save(subject, workspace)
            return workspace
        return Workspace()

    def save(self, subject: str, workspace: Workspace) -> None:
        """Write via a temp file and rename, so a crash never leaves half a file."""
        os.makedirs(self.directory, exist_ok=True)
        path = self.path(subject)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as file:
            json.dump(workspace.to_json(), file, ensure_ascii=False, indent=1)
        os.replace(tmp, path)


def import_trace(events: list[dict]) -> Workspace:
    """Rebuild a workspace from a trace written before workspaces existed.

    Pitch batches become one list, oldest first, and the newest batch's
    reading becomes the reading. Verdicts, pitch critiques (as notes), drafts,
    hand revisions logged as ``check`` events, and the latest choice carry
    over. Batches in the oldest pitch format (no reading) are skipped.
    """
    workspace = Workspace()
    pitches: dict[tuple[object, object], PitchEntry] = {}
    drafts: dict[tuple[object, object], DraftEntry] = {}
    for event in events:
        stage = event.get("stage")
        target = (event.get("run"), event.get("index"))
        if stage == "pitch":
            result = event.get("result")
            if not isinstance(result, dict) or "reading" not in result:
                continue
            try:
                workspace.reading = Reading(**result["reading"])
                batch = [Pitch(**p) for p in result["pitches"]]
            except (KeyError, TypeError):
                continue
            for i, p in enumerate(batch):
                entry = PitchEntry(new_id(), **asdict(p), source=event.get("model", ""), created=event.get("time", ""))
                pitches[(event.get("run"), i)] = entry
                workspace.pitches.append(entry)
        elif stage == "verdict" and target in pitches:
            pitches[target].kept = not event.get("rejected")
        elif stage == "critique" and target in pitches:
            pitches[target].note = event.get("text", "")
        elif stage == "write" and target in pitches:
            draft = DraftEntry(
                new_id(),
                pitches[target].id,
                event.get("form", ""),
                event.get("constraint"),
                event.get("result", ""),
                prompt=event.get("prompt"),
                model=event.get("model", ""),
                created=event.get("time", ""),
            )
            drafts[target] = draft
            workspace.drafts.append(draft)
        elif stage == "check" and target in drafts:
            if event.get("revision"):
                drafts[target].replace_story(event["revision"], "revise: " + " ".join(event.get("findings", [])))
            if event.get("result") == "dropped":
                drafts[target].dropped = True
        elif stage == "choose" and target in drafts:
            workspace.chosen = drafts[target].id
    return workspace
