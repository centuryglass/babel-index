"""
Per-subject trace logs: one JSON Lines file per subject, one event per line.

Every stage appends an event holding its model, prompt, raw reply and parsed
result, so a bad story can be traced back to the stage that went wrong and
replayed from there. The log is append-only and is also the cache: the image
reading is reused by finding the subject's latest ``read`` event.

Events share a ``run`` id per pitch batch, so a batch's pitches, the drafts
written from them, and the outcome can be grouped back together.
"""

from __future__ import annotations

import json
import os
import time
import uuid


def new_run_id() -> str:
    return uuid.uuid4().hex[:12]


class TraceLog:
    """The trace directory. ``subject`` is a filename-safe id, e.g. a tile stem."""

    def __init__(self, directory: str):
        self.directory = directory

    def path(self, subject: str) -> str:
        return os.path.join(self.directory, f"{subject}.jsonl")

    def append(self, subject: str, event: dict) -> dict:
        """Timestamp ``event`` and append it as one line. Returns the stored event."""
        os.makedirs(self.directory, exist_ok=True)
        stored = {"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **event}
        with open(self.path(subject), "a", encoding="utf-8") as file:
            file.write(json.dumps(stored, ensure_ascii=False) + "\n")
        return stored

    def events(self, subject: str) -> list[dict]:
        """Every event for ``subject``, oldest first. Skips a torn final line."""
        path = self.path(subject)
        if not os.path.exists(path):
            return []
        out = []
        with open(path, encoding="utf-8") as file:
            for line in file:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return out

    def latest(self, subject: str, stage: str) -> dict | None:
        for event in reversed(self.events(subject)):
            if event.get("stage") == stage:
                return event
        return None
