"""
Batch importer for the babel-index project.

## Elsewhere / manual
- I generate a batch of tiling images based on Library of Babel walls, each
  seeded with three style keywords from a limited set.
- I dig through the outputs and copy my favourites into a working directory.

## This script (run from the repo root)

    python -m babel_index_review.tile_process DIR

  Ingest every loose ``.png`` in DIR:
    - keywords are extracted from the A1111 prompt and normalized via
      ``keyword_map.json``,
    - the image is re-encoded as ``NNNNN.webp`` under the next free index,
    - the filename -> keyword mapping is written to ``metadata.json``.

    python -m babel_index_review.tile_process DIR --generate-stories

  Additionally send each tile that still lacks a story to Claude and store the
  reply in ``metadata.json``. Tiles that already have a story are left alone,
  so this is safe to re-run and picks up where it left off.

Story *review and revision* is a separate Qt app; see
``babel_index_review`` (run ``python -m babel_index_review DIR``).
"""

import argparse
import os
import sys

from babel_index_review import core


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch importer for the babel-index project.")
    parser.add_argument("dir", help="Directory to scan.")
    parser.add_argument(
        "--map",
        default=core.DEFAULT_KEYWORD_MAP,
        help=f"Keyword map JSON (default: {core.DEFAULT_KEYWORD_MAP}).",
    )
    parser.add_argument(
        "--generate-stories",
        action="store_true",
        help="Also generate a story (via Claude) for any tile lacking one.",
    )
    return parser.parse_args()


def generate_missing_stories(tile_dir: str, index: dict) -> None:
    """Fill in a Claude-generated story for every tile that lacks one."""
    for key in sorted(index):
        entry = index[key]
        webp_path = os.path.join(tile_dir, key)
        if entry.get("story") is not None or not os.path.exists(webp_path):
            continue
        prompt = core.default_prompt(core.keyword_texts(entry))
        story = core.generate_story(webp_path, prompt)
        print(f"{key}: {story}")
        entry["story"] = story
        core.save_index(tile_dir, index)


def main() -> int:
    args = parse_args()
    if not os.path.isdir(args.dir):
        print(f"{args.dir} not found")
        return 1

    keyword_map = core.load_keyword_map(args.map)
    index = core.ingest_tiles(args.dir, keyword_map)

    if args.generate_stories:
        generate_missing_stories(args.dir, index)

    return 0


if __name__ == "__main__":
    sys.exit(main())
