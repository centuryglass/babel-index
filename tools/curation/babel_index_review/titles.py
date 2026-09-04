"""
Title generation for the babel-index project, via a vision-capable model.

For each finalized tile, sends the image plus its story (never the seed
keywords, so the title comes from the narrative rather than the prompt) to
the model and asks for a short title. Uniqueness and length are enforced by
talking back: if the model's answer collides with a title already in use, or
breaks the word-count/length limits, it's told why and asked to try again, in
the same conversation, until it produces something valid.

    python -m babel_index_review.titles DIR [--model MODEL] [--all]

Results are written directly into metadata.json's "title" field, one tile at
a time and saved after each, so an interrupted run (Ctrl+C included) never
loses prior progress. On launch, any tile that already has a title is
skipped.

By default only tiles marked ``"final"`` in metadata.json are titled -- pass
--all to also title tiles that merely have a story. ``--model`` accepts
anything ``tag.describe_image`` does -- the default is
``tag.describe_image.DEFAULT_MODEL``; pass ``local:...`` for the local server
instead, or a bare Claude model id for the paid API.
"""

import argparse
import os
import sys

from babel_index_review import core, parallel
from babel_index_review.parallel import SharedTitleSet
from tag.describe_image import DEFAULT_MODEL, converse_about_image

MIN_WORDS = 1
MAX_WORDS = 3
MAX_CHARS = 30
MAX_ATTEMPTS = 6


def _tiles_to_title(tile_dir: str, index: dict, include_all: bool):
    """Yield (key, entry) for untitled tiles with a story (or 'final' unless --all)."""
    for key in sorted(index):
        entry = index[key]
        if not entry.get("story"):
            continue
        if entry.get("title"):
            continue
        if not include_all and not entry.get("final"):
            continue
        if not os.path.exists(os.path.join(tile_dir, key)):
            continue
        yield key, entry


def _clean_title(raw: str) -> str:
    title = raw.strip().strip("\"'").strip()
    title = title.splitlines()[0] if title else title
    return title.rstrip(".").strip()


def _validation_error(title: str, used_titles: SharedTitleSet) -> str | None:
    """Return a feedback message if `title` is invalid, else None."""
    if not title:
        return "That was empty. Reply with only the title, 1 to 3 words."
    word_count = len(title.split())
    if not (MIN_WORDS <= word_count <= MAX_WORDS):
        return (
            f'"{title}" is {word_count} word(s); I need {MIN_WORDS} to {MAX_WORDS} words. '
            "Try again -- respond with only the title."
        )
    if len(title) > MAX_CHARS:
        return (
            f'"{title}" is {len(title)} characters, over the {MAX_CHARS}-character limit. '
            "Try again with something shorter -- respond with only the title."
        )
    if used_titles.contains(title.casefold()):
        return (
            f'"{title}" is already the title of another tile. Propose a different one -- '
            "respond with only the title."
        )
    return None


def propose_title(
    image_path: str, story: str, used_titles: SharedTitleSet, model: str, key: str | None = None
) -> str | None:
    """Ask the model for a unique 1-3 word title, retrying on rule violations.

    A title that passes validation is claimed via ``used_titles.try_reserve``
    before being returned -- if another worker claimed it first (a race
    between two concurrent tiles proposing the same free title), that's
    treated exactly like any other rule violation: tell the model why and
    ask again in the same conversation.

    Every rejected reply (rule violation or duplicate) is logged to stdout,
    tagged with `key` if given, so a run's failure modes are visible without
    re-running with extra verbosity.

    Returns None if no valid, successfully claimed title emerged within
    MAX_ATTEMPTS.
    """
    label = key or image_path
    prompt = (
        "Here is a bookshelf tile from an impossible library, along with a short "
        f"story written about it:\n\n\"{story}\"\n\n"
        f"Propose a title for this piece: {MIN_WORDS} to {MAX_WORDS} words, evocative, "
        f"no more than {MAX_CHARS} characters. Respond with only the title text, nothing else."
    )
    turns = [("user", prompt)]
    for _ in range(MAX_ATTEMPTS):
        reply = converse_about_image(image_path, turns, model=model)
        title = _clean_title(reply)
        turns.append(("assistant", reply))
        error = _validation_error(title, used_titles)
        if error is None:
            if used_titles.try_reserve(title.casefold()):
                return title
            error = (
                f'"{title}" was just claimed by another tile. Propose a different one -- '
                "respond with only the title."
            )
        print(f"{label}: rejected {title!r} -- {error}")
        turns.append(("user", error))
    return None


def run(tile_dir: str, model: str, include_all: bool, workers: int) -> None:
    index = core.load_index(tile_dir)
    existing_titles = {
        entry["title"].casefold() for entry in index.values() if entry.get("title")
    }
    used_titles = SharedTitleSet(existing_titles)

    targets = list(_tiles_to_title(tile_dir, index, include_all))
    workers = parallel.resolve_workers(model, workers)
    print(
        f"{len(existing_titles)} title(s) already recorded, {len(targets)} to go, "
        f"{workers} worker(s)",
        file=sys.stderr,
    )

    def worker_fn(image_path: str, entry: dict) -> str | None:
        return propose_title(
            image_path, entry["story"], used_titles, model, key=os.path.basename(image_path)
        )

    def apply_fn(index: dict, key: str, entry: dict, title: str | None) -> None:
        if title is None:
            print(f"skip {key}: no valid title after {MAX_ATTEMPTS} attempts", file=sys.stderr)
            return
        index[key]["title"] = title
        print(f"{key} -> {title}")

    parallel.run_parallel(
        tile_dir, targets, worker_fn=worker_fn, apply_fn=apply_fn, workers=workers
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("dir", help="Tile directory.")
    parser.add_argument(
        "--model", default=DEFAULT_MODEL, help=f"Model id (default: {DEFAULT_MODEL})."
    )
    parser.add_argument(
        "--all", action="store_true", help="Title tiles with a story even if not marked final."
    )
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
        run(args.dir, args.model, args.all, args.workers)
    except KeyboardInterrupt:
        print("\ninterrupted -- progress saved", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
