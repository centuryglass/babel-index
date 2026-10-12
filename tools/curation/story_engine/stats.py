"""
Weight report: how often each seed, seed kind, form and constraint led to a
story the maintainer kept, for tuning the weights in ``options.py``.

``tally`` reads finished review state only: each subject's workspace and
trace events. A draft is *accepted* when its latest ``outcome`` event
(``engine.record_outcome``) is ``accepted``, so a story marked Final and
later cleared stops counting. A draft is *chosen* when the workspace holds it
as the choice or a ``choose`` or ``outcome`` event names it.

Rows count different things by list:
- a seed (and seed kind) counts pitches: ``used`` is every pitch, ``kept``
  those that survived pitch review, ``drafted`` those with a draft;
- a form or constraint counts drafts: ``used`` is every draft.

Both then count the drafts of that row that were ``chosen``, ``accepted``,
``discarded`` and, of the accepted, ``edited`` by hand after being chosen.
A pitch with several drafts counts once in ``drafted`` but each draft counts
in ``chosen`` and ``accepted``.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from story_engine.options import OptionSet
from story_engine.workspace import Workspace

NO_CONSTRAINT = "(no constraint)"


@dataclass
class Row:
    name: str
    used: int = 0
    kept: int | None = None
    drafted: int | None = None
    chosen: int = 0
    accepted: int = 0
    discarded: int = 0
    edited: int = 0

    def rate(self, count: int | None, of: int | None = None) -> float | None:
        """``count`` over ``of`` (default ``used``), or None when nothing was counted."""
        total = self.used if of is None else of
        return None if count is None or not total else count / total


@dataclass
class Report:
    seeds: list[Row]
    kinds: list[Row]
    forms: list[Row]
    constraints: list[Row]
    subjects: int = 0


def _decisions(events: list[dict]) -> tuple[dict[str, dict], set[str]]:
    """The latest outcome event per draft id, and the draft ids a choose or outcome names."""
    outcomes: dict[str, dict] = {}
    chosen: set[str] = set()
    for event in events:
        draft_id = event.get("draft_id")
        if not draft_id:
            continue
        if event.get("stage") == "outcome":
            outcomes[draft_id] = event
            chosen.add(draft_id)
        elif event.get("stage") == "choose":
            chosen.add(draft_id)
    return outcomes, chosen


def _count_draft(row: Row, chosen: bool, outcome: dict | None) -> None:
    row.chosen += chosen
    if outcome is None:
        return
    if outcome.get("outcome") == "accepted":
        row.accepted += 1
        row.edited += bool(outcome.get("edited"))
    elif outcome.get("outcome") == "discarded":
        row.discarded += 1


def tally(
    subjects: Iterable[tuple[Workspace, list[dict]]],
    seeds: OptionSet,
    forms: OptionSet,
    constraints: OptionSet | None,
) -> Report:
    """Count every subject's pitches and drafts against the current lists.

    Each row lists an entry of the given sets, in list order, including
    entries nothing has used yet. Pitches and drafts naming an entry no
    longer in a list are not counted.
    """
    seed_rows = {o.name: Row(o.name, kept=0, drafted=0) for o in seeds.options}
    kind_rows = {k: Row(k, kept=0, drafted=0) for k in seeds.kind_weights}
    form_rows = {o.name: Row(o.name) for o in forms.options}
    constraint_rows = {NO_CONSTRAINT: Row(NO_CONSTRAINT)}
    constraint_rows.update({o.name: Row(o.name) for o in (constraints.options if constraints else [])})
    count = 0
    for workspace, events in subjects:
        count += 1
        outcomes, chosen_ids = _decisions(events)
        if workspace.chosen:
            chosen_ids.add(workspace.chosen)
        drafts_by_pitch: dict[str | None, list] = {}
        for draft in workspace.drafts:
            drafts_by_pitch.setdefault(draft.pitch_id, []).append(draft)
            is_chosen = draft.id in chosen_ids
            outcome = outcomes.get(draft.id)
            if draft.form in form_rows:
                form_rows[draft.form].used += 1
                _count_draft(form_rows[draft.form], is_chosen, outcome)
            constraint_row = constraint_rows.get(draft.constraint or NO_CONSTRAINT)
            if constraint_row is not None:
                constraint_row.used += 1
                _count_draft(constraint_row, is_chosen, outcome)
        for pitch in workspace.pitches:
            if pitch.seed not in seed_rows:
                continue
            kind = seeds.by_name(pitch.seed).kind
            rows = [seed_rows[pitch.seed]] + ([kind_rows[kind]] if kind in kind_rows else [])
            drafts = drafts_by_pitch.get(pitch.id, [])
            for row in rows:
                row.used += 1
                row.kept += pitch.kept
                row.drafted += bool(drafts)
                for draft in drafts:
                    _count_draft(row, draft.id in chosen_ids, outcomes.get(draft.id))
    return Report(
        list(seed_rows.values()),
        list(kind_rows.values()),
        list(form_rows.values()),
        list(constraint_rows.values()),
        count,
    )
