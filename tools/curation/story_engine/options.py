"""
Weighted option lists: the seeds a pitch grows from, the forms a story can
take, and the occasional odd constraint.

Each list is a JSON file the maintainer edits by hand, so adding an entry or
retuning a weight needs no code change. A weight is relative, not a share:
an entry at 2 is drawn twice as often as one at 1, and an entry at 0 is
never drawn but can still be chosen by hand.

Two file shapes:
- a plain list of ``{"name", "description", "weight"}`` entries (forms,
  constraints);
- ``{"kinds": {kind: weight}, "options": [... each with a "kind" ...]}``
  (seeds). A draw picks a kind by its weight first, then an entry within it,
  so a long list of one kind doesn't crowd out a short list of another.

``save_options`` writes either shape back in the layout the files are
edited in, one entry per line, so a save changes only the lines that changed.
"""

from __future__ import annotations

import json
import os
import random
from dataclasses import dataclass, replace


@dataclass(frozen=True)
class Option:
    name: str
    description: str
    weight: float = 1.0
    kind: str = ""


@dataclass
class OptionSet:
    options: list[Option]
    kind_weights: dict[str, float]

    def draw(self, k: int, rng: random.Random | None = None, exclude: set[str] | None = None) -> list[Option]:
        """Draw up to ``k`` distinct options, by kind weight then option weight.

        Options named in ``exclude`` are skipped. Returns fewer than ``k``
        when fewer options are left with a positive weight.
        """
        rng = rng or random.Random()
        exclude = exclude or set()
        pool = [
            o for o in self.options
            if o.weight > 0 and self.kind_weights.get(o.kind, 0) > 0 and o.name not in exclude
        ]
        picked = []
        while pool and len(picked) < k:
            kinds = sorted({o.kind for o in pool})
            kind = rng.choices(kinds, weights=[self.kind_weights[kd] for kd in kinds])[0]
            in_kind = [o for o in pool if o.kind == kind]
            option = rng.choices(in_kind, weights=[o.weight for o in in_kind])[0]
            pool.remove(option)
            picked.append(option)
        return picked

    def with_weights(self, weights: dict[str, float], kind_weights: dict[str, float] | None = None) -> "OptionSet":
        """A copy with the named options (and kinds) reweighted; others are unchanged."""
        return OptionSet(
            [replace(o, weight=weights.get(o.name, o.weight)) for o in self.options],
            {**self.kind_weights, **(kind_weights or {})},
        )

    def by_name(self, name: str) -> Option:
        for option in self.options:
            if option.name == name:
                return option
        raise KeyError(name)


def load_options(path: str) -> OptionSet:
    """Read either file shape, rejecting duplicate names and negative weights."""
    with open(path, encoding="utf-8") as file:
        raw = json.load(file)
    if isinstance(raw, list):
        items, kind_weights = raw, {"": 1.0}
    else:
        items = raw["options"]
        kind_weights = {kind: float(w) for kind, w in raw["kinds"].items()}
    options = []
    seen = set()
    for item in items:
        option = Option(
            item["name"], item["description"], float(item.get("weight", 1.0)), item.get("kind", "")
        )
        if option.name in seen:
            raise ValueError(f"{path}: duplicate option {option.name!r}")
        if option.weight < 0:
            raise ValueError(f"{path}: {option.name!r} has a negative weight")
        if option.kind not in kind_weights:
            raise ValueError(f"{path}: {option.name!r} has unknown kind {option.kind!r}")
        seen.add(option.name)
        options.append(option)
    return OptionSet(options, kind_weights)


def _number(value: float) -> str:
    return str(int(value)) if value == int(value) else repr(float(value))


def save_options(path: str, option_set: OptionSet) -> None:
    """Write ``option_set`` to ``path`` in the shape ``load_options`` reads.

    A set whose only kind is ``""`` is a plain list; any other is the
    ``{"kinds", "options"}`` shape. Goes through a temp file and a rename, so
    a crash never leaves half a file.
    """
    dump = json.dumps
    plain = set(option_set.kind_weights) == {""}

    def line(o: Option) -> str:
        kind = "" if plain else f'"kind": {dump(o.kind)}, '
        return (
            f'{{{kind}"name": {dump(o.name, ensure_ascii=False)}, '
            f'"description": {dump(o.description, ensure_ascii=False)}, "weight": {_number(o.weight)}}}'
        )

    indent = "  " if plain else "    "
    rows = []
    for i, o in enumerate(option_set.options):
        last = i == len(option_set.options) - 1
        rows.append(indent + line(o) + ("" if last else ","))
        if not last and option_set.options[i + 1].kind != o.kind:
            rows.append("")  # a blank line between kinds
    body = "\n".join(rows)
    if plain:
        text = f"[\n{body}\n]\n"
    else:
        kinds = ",\n".join(f"    {dump(k)}: {_number(w)}" for k, w in option_set.kind_weights.items())
        text = f'{{\n  "kinds": {{\n{kinds}\n  }},\n  "options": [\n{body}\n  ]\n}}\n'
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as file:
        file.write(text)
    os.replace(tmp, path)
