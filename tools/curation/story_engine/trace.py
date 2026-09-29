"""
Per-subject trace logs: one JSON Lines file per subject, one event per line.

Every model call appends an event holding its model, prompt, raw reply and
parsed result, so a bad story can be traced back to the call that went wrong
and replayed from there. Choices and outcomes are logged too, for
tuning. The log is append-only and write-only in normal use: review
state lives in the workspace (``workspace.py``), which reads a trace only to
import a subject reviewed before workspaces existed.
"""

from __future__ import annotations

import json
import os
import threading
import time


class TraceLog:
    """The trace directory. ``subject`` is a filename-safe id, e.g. a tile stem."""

    def __init__(self, directory: str):
        self.directory = directory
        # Model calls finish on parallel threads; a long event line could
        # otherwise interleave with another thread's.
        self._lock = threading.Lock()

    def path(self, subject: str) -> str:
        return os.path.join(self.directory, f"{subject}.jsonl")

    def append(self, subject: str, event: dict) -> dict:
        """Timestamp ``event`` and append it as one line. Returns the stored event."""
        os.makedirs(self.directory, exist_ok=True)
        stored = {"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **event}
        line = json.dumps(stored, ensure_ascii=False) + "\n"
        with self._lock, open(self.path(subject), "a", encoding="utf-8") as file:
            file.write(line)
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
