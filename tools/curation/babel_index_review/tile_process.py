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

from babel_index_review import core, parallel


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
    parser.add_argument(
        "--workers",
        type=int,
        default=parallel.DEFAULT_WORKERS,
        help=f"Concurrent story requests (default: {parallel.DEFAULT_WORKERS}; "
        "forced to 1 for a local: model).",
    )
    return parser.parse_args()


def _tiles_needing_stories(tile_dir: str, index: dict):
    """Yield (key, entry) for on-disk tiles that still lack a story."""
    for key in sorted(index):
        entry = index[key]
        if entry.get("story") is not None:
            continue
        if not os.path.exists(os.path.join(tile_dir, key)):
            continue
        yield key, entry


def generate_missing_stories(tile_dir: str, index: dict, workers: int = 1) -> None:
    """Fill in a Claude-generated story for every tile that lacks one."""
    targets = list(_tiles_needing_stories(tile_dir, index))
    workers = parallel.resolve_workers(core.DEFAULT_MODEL, workers)

    def worker_fn(webp_path: str, entry: dict) -> str:
        prompt = core.default_prompt(core.keyword_texts(entry))
        return core.generate_story(webp_path, prompt)

    def apply_fn(index: dict, key: str, entry: dict, story: str) -> None:
        index[key]["story"] = story
        print(f"{key}: {story}")

    parallel.run_parallel(
        tile_dir, targets, worker_fn=worker_fn, apply_fn=apply_fn, workers=workers
    )


def main() -> int:
    args = parse_args()
    if not os.path.isdir(args.dir):
        print(f"{args.dir} not found")
        return 1

    keyword_map = core.load_keyword_map(args.map)
    index = core.ingest_tiles(args.dir, keyword_map)

    if args.generate_stories:
        generate_missing_stories(args.dir, index, args.workers)

    return 0


if __name__ == "__main__":
    sys.exit(main())
