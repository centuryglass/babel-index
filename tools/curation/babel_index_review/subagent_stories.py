"""
Subagent-driven story generation for the babel-index project.

This is the no-API-cost alternative to ``babel_index_review.tile_process
--generate-stories``. That path calls Claude through ``anthropic.Anthropic()``
with your API key (billed per tile). This path instead hands the work to Claude
Code *subagents*, which run under the Claude Code subscription -- so generating
hundreds of stories costs nothing beyond the subscription you already pay for.

A subagent can only be spawned by the Claude Code harness, not by a plain Python
process, so the actual orchestration (spawning one subagent per tile, each of
which ``Read``s the tile image and writes a story) happens *inside a Claude Code
session*. This script owns the two deterministic halves of that loop:

    # 1. Emit the work: {key, image, prompt} for every tile lacking a story.
    python -m babel_index_review.subagent_stories DIR worklist [--limit N] [--out FILE]

    # 2. Merge the stories the subagents produced back into metadata.json.
    python -m babel_index_review.subagent_stories DIR apply --results RESULTS.json

``worklist`` builds each tile's prompt with ``core.default_prompt`` (the same
prompt the paid path uses, including its random per-tile question sampling), so
variation across the dataset is preserved. ``apply`` writes only tiles that
still exist and still lack a story, so both halves are safe to re-run and pick
up where they left off.

The Claude Code session in between does, per tile: spawn a subagent (via the
Agent tool, ``model: opus``) with the tile's ``prompt`` plus its ``image`` path,
tell it to Read the image and reply with the story text only, collect the reply
into a ``{key: story}`` map, and hand that map to ``apply``. Run subagents in
parallel batches for throughput; ``apply`` is the single serialized writer, so
concurrent subagents never race on ``metadata.json``.
"""

import argparse
import json
import os
import sys

from babel_index_review import core


def _tiles_needing_stories(tile_dir: str, index: dict):
    """Yield (key, entry) for tiles that exist on disk and lack a story."""
    for key in sorted(index):
        entry = index[key]
        if entry.get("story") is not None:
            continue
        if not os.path.exists(os.path.join(tile_dir, key)):
            continue
        yield key, entry


def cmd_worklist(args: argparse.Namespace) -> int:
    index = core.load_index(args.dir)
    tasks = []
    for key, entry in _tiles_needing_stories(args.dir, index):
        tasks.append(
            {
                "key": key,
                "image": os.path.abspath(os.path.join(args.dir, key)),
                "prompt": core.default_prompt(core.keyword_texts(entry)),
            }
        )
        if args.limit and len(tasks) >= args.limit:
            break

    text = json.dumps(tasks, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as file:
            file.write(text)
        print(f"wrote {len(tasks)} task(s) to {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


def cmd_apply(args: argparse.Namespace) -> int:
    with open(args.results, encoding="utf-8") as file:
        results = json.load(file)

    index = core.load_index(args.dir)
    written, skipped = 0, 0
    for key, story in results.items():
        entry = index.get(key)
        if entry is None:
            print(f"skip {key}: not in index", file=sys.stderr)
            skipped += 1
            continue
        if entry.get("story") is not None:
            print(f"skip {key}: already has a story", file=sys.stderr)
            skipped += 1
            continue
        if not story or not story.strip():
            print(f"skip {key}: empty story", file=sys.stderr)
            skipped += 1
            continue
        entry["story"] = story.strip()
        written += 1

    core.save_index(args.dir, index)
    print(f"applied {written} story(ies), skipped {skipped}", file=sys.stderr)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("dir", help="Tile directory.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    wl = sub.add_parser("worklist", help="Emit {key, image, prompt} for tiles lacking a story.")
    wl.add_argument("--limit", type=int, default=0, help="Cap the number of tasks (0 = no cap).")
    wl.add_argument("--out", default=None, help="Write JSON here instead of stdout.")
    wl.set_defaults(func=cmd_worklist)

    ap = sub.add_parser("apply", help="Merge a {key: story} JSON into metadata.json.")
    ap.add_argument("--results", required=True, help="JSON file mapping tile key -> story.")
    ap.set_defaults(func=cmd_apply)

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not os.path.isdir(args.dir):
        print(f"{args.dir} not found", file=sys.stderr)
        return 1
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
