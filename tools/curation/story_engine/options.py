"""
Weighted option lists: the payloads a pitch can carry and the forms a story
can take.

Each list is a JSON file of ``{"name", "description", "weight"}`` entries, so
the maintainer can add an entry or retune a weight without touching code. A
weight is relative, not a share: an entry at 2 is drawn twice as often as one
at 1, and an entry at 0 is never drawn but can still be chosen by hand.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass


@dataclass(frozen=True)
class Option:
    name: str
    description: str
    weight: float = 1.0


def load_options(path: str) -> list[Option]:
    """Read an option list, rejecting duplicate names and negative weights."""
    with open(path, encoding="utf-8") as file:
        raw = json.load(file)
    options = []
    seen = set()
    for item in raw:
        option = Option(item["name"], item["description"], float(item.get("weight", 1.0)))
        if option.name in seen:
            raise ValueError(f"{path}: duplicate option {option.name!r}")
        if option.weight < 0:
            raise ValueError(f"{path}: {option.name!r} has a negative weight")
        seen.add(option.name)
        options.append(option)
    return options


def draw(options: list[Option], k: int, rng: random.Random | None = None) -> list[Option]:
    """Draw up to ``k`` distinct options by weight, without replacement.

    Returns fewer than ``k`` when fewer options have a positive weight.
    """
    rng = rng or random.Random()
    pool = [option for option in options if option.weight > 0]
    picked = []
    while pool and len(picked) < k:
        option = rng.choices(pool, weights=[o.weight for o in pool])[0]
        pool.remove(option)
        picked.append(option)
    return picked


def by_name(options: list[Option], name: str) -> Option:
    for option in options:
        if option.name == name:
            return option
    raise KeyError(name)
