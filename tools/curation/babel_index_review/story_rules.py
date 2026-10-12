"""
Babel Index's lint rules (``story_engine.rules``), kept in the tile
directory's ``story_rules.json``.

    python -m babel_index_review.story_rules DIR list
    python -m babel_index_review.story_rules DIR derive [--model MODEL]
    python -m babel_index_review.story_rules DIR prompt
    python -m babel_index_review.story_rules DIR apply REPLY.json [--model LABEL]

- ``list`` prints every rule with how many Final stories its check fails.
- ``derive`` asks a model to rewrite the ``llm`` rules from collection
  memory's report, and saves them beside the hand rules.
- ``prompt`` prints that request instead, for a Claude Code session to
  answer; ``apply`` reads the session's JSON reply and saves it as
  ``derive`` would.

The review GUI's **Story engine > Lint rules** window does the same, and
edits rules by hand. Rules belong to the collection they were derived from,
so they live in its tile directory. A directory without a rules file starts
from ``story_frame.default_rules``.

Derivation reads memory, so run ``collection_memory`` first: a story memory
hasn't tagged is invisible to it.
"""

from __future__ import annotations

import argparse
import os
import sys

from babel_index_review import collection_memory, core, story_frame
from story_engine.llm import parse_json
from story_engine.memory import analyze, format_report
from story_engine.rules import Rule, RuleSet, derive, derive_prompt, describe_check, hits, parse_derived
from story_engine.workspace import new_id, now
from tag.describe_image import DEFAULT_MODEL

RULES_JSON = "story_rules.json"
REPORT_LIMIT = 40  # items per report section shown to the deriving model


def rules_path(tile_dir: str) -> str:
    return os.path.join(tile_dir, RULES_JSON)


def load(tile_dir: str, strict: bool = False) -> RuleSet:
    """The directory's rules, or the defaults when it has no rules file. ``strict`` is ``core.load_json``'s."""
    path = rules_path(tile_dir)
    if not os.path.exists(path):
        return RuleSet(story_frame.default_rules())
    return RuleSet.from_json(core.load_json(path, strict))


def save(tile_dir: str, rules: RuleSet) -> None:
    core.update_json(rules_path(tile_dir), lambda _old: rules.to_json())


def final_stories(tile_dir: str) -> dict[str, str]:
    """Every Final story, by tile key."""
    return {k: e["story"] for k, e in core.load_index(tile_dir).items() if e.get("final") and (e.get("story") or "").strip()}


def memory_report(tile_dir: str) -> str:
    """Collection memory's report, as the deriving model reads it."""
    return format_report(analyze(list(collection_memory.load(tile_dir).values())), REPORT_LIMIT)


def as_rules(pairs: list[tuple[str, dict | None]], model: str) -> list[Rule]:
    stamp = now()
    return [Rule(new_id(), description, check, "llm", model, stamp) for description, check in pairs]


def derive_rules(tile_dir: str, rules: RuleSet, model: str) -> list[Rule]:
    """New ``llm`` rules from memory, for ``RuleSet.with_derived``. Blocks on the network."""
    return as_rules(derive(memory_report(tile_dir), rules, model), model)


def format_rules(rules: RuleSet, counts: dict[str, int], stories: int) -> str:
    lines = []
    for rule in rules.rules:
        hit = f", fails {counts[rule.id]} of {stories} Final stories" if rule.id in counts else ""
        lines.append(f"- [{rule.source}] {rule.description}\n  {describe_check(rule.check)}{hit}")
    return "\n".join(lines) or "No rules."


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("dir", help="Tile directory.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="Print every rule and how many Final stories it fails.")
    derive_parser = commands.add_parser("derive", help="Rewrite the llm rules from collection memory.")
    derive_parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Deriving model (default {DEFAULT_MODEL}).")
    commands.add_parser("prompt", help="Print the derivation prompt, for a Claude Code session.")
    apply_parser = commands.add_parser("apply", help="Save a derivation reply as the llm rules.")
    apply_parser.add_argument("reply", help="File holding the reply's JSON object, fenced or bare.")
    apply_parser.add_argument("--model", default="claude-code", help="Label recorded as the rules' model.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not os.path.isdir(args.dir):
        print(f"{args.dir} not found", file=sys.stderr)
        return 1
    rules = load(args.dir, strict=True)
    if args.command == "prompt":
        print(derive_prompt(memory_report(args.dir), rules))
        return 0
    if args.command == "derive":
        rules = rules.with_derived(derive_rules(args.dir, rules, args.model))
        save(args.dir, rules)
    elif args.command == "apply":
        with open(args.reply, encoding="utf-8") as file:
            pairs = parse_derived(parse_json(file.read()))
        rules = rules.with_derived(as_rules(pairs, args.model))
        save(args.dir, rules)
    stories = final_stories(args.dir)
    print(format_rules(rules, hits(rules.rules, list(stories.values())), len(stories)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
