"""
Alt-text generation for the babel-index project, via a vision-capable model.

For each tile, sends the image plus its seed keywords to the model (never the
story -- the story is presented right beside the image elsewhere, so alt text
describing the same thing again would just be noise for a screen-reader user)
and asks for accessibility alt text per ``core.default_alt_prompt``. Results
are written directly into ``metadata.json`` as each tile's ``alt`` field, saved
after every tile so an interrupted run (Ctrl+C included) never loses progress.

    python -m babel_index_review.alt_text DIR [--model MODEL] [--force] [--limit N]

By default, tiles that already have alt text are skipped; pass --force to
regenerate everyone. ``--model`` accepts anything ``tag.describe_image`` does
-- the default is Gemini Flash via OpenRouter (``tag.describe_image.DEFAULT_MODEL``),
which tested noticeably more accurate than the free local server on this
prompt; pass ``local:...`` for the local server instead, or a bare Claude model
id for the paid API.
"""

import argparse
import os
import sys

from babel_index_review import core, parallel
from tag.describe_image import DEFAULT_MODEL


def _tiles_needing_alt(tile_dir: str, index: dict, force: bool):
    """Yield (key, entry) for on-disk tiles lacking alt text (or all, if force)."""
    for key in sorted(index):
        entry = index[key]
        if not force and entry.get("alt"):
            continue
        if not os.path.exists(os.path.join(tile_dir, key)):
            continue
        yield key, entry


def run(tile_dir: str, model: str, force: bool, limit: int | None, workers: int) -> None:
    index = core.load_index(tile_dir)
    targets = list(_tiles_needing_alt(tile_dir, index, force))
    if limit is not None:
        targets = targets[:limit]
    workers = parallel.resolve_workers(model, workers)
    print(f"{len(targets)} tile(s) to go, {workers} worker(s)", file=sys.stderr)

    def worker_fn(image_path: str, entry: dict) -> str:
        prompt = core.default_alt_prompt(core.keyword_texts(entry))
        return core.generate_alt_text(image_path, prompt, model=model).strip()

    def apply_fn(index: dict, key: str, entry: dict, alt: str) -> None:
        index[key]["alt"] = alt
        print(f"{key} -> {alt}")

    parallel.run_parallel(
        tile_dir, targets, worker_fn=worker_fn, apply_fn=apply_fn, workers=workers
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("dir", help="Tile directory.")
    parser.add_argument(
        "--model", default=DEFAULT_MODEL, help="Model id (default: Gemini Flash via OpenRouter)."
    )
    parser.add_argument(
        "--force", action="store_true", help="Regenerate alt text even for tiles that already have it."
    )
    parser.add_argument("--limit", type=int, default=None, help="Stop after N tiles.")
    parser.add_argument(
        "--workers",
        type=int,
        default=parallel.DEFAULT_WORKERS,
        help=f"Concurrent requests (default: {parallel.DEFAULT_WORKERS}; "
        "forced to 1 for a local: model).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not os.path.isdir(args.dir):
        print(f"{args.dir} not found", file=sys.stderr)
        return 1
    try:
        run(args.dir, args.model, args.force, args.limit, args.workers)
    except KeyboardInterrupt:
        print("\ninterrupted -- progress saved", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
