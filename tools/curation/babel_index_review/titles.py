"""
Title generation for the babel-index project, via the local vision model.

For each finalized tile, sends the image plus its story (never the seed
keywords, so the title comes from the narrative rather than the prompt) to a
local llama.cpp server and asks for a short title. Uniqueness and length are
enforced by talking back: if the model's answer collides with a title already
in use, or breaks the word-count/length limits, it's told why and asked to try
again, in the same conversation, until it produces something valid.

    python -m babel_index_review.titles DIR [--out FILE] [--model MODEL] [--all]

Results are appended to ``babel_titles.csv`` (in ``DIR`` by default) one line
at a time as ``original_filename,title``, flushed after every row, so an
interrupted run (Ctrl+C included) never loses prior progress. On launch, any
filename already present in that CSV is skipped.

By default only tiles marked ``"final"`` in metadata.json are titled -- pass
--all to also title tiles that merely have a story. ``--model`` accepts
anything ``tag.describe_image`` does (``local:...`` for the local server,
which is the default; a bare Claude model id to use the paid API instead).
"""

import argparse
import csv
import os
import sys

from babel_index_review import core
from tag.describe_image import LOCAL_PREFIX, converse_about_image

DEFAULT_MODEL = LOCAL_PREFIX  # empty tail: single-model llama-server picks its loaded model
CSV_NAME = "babel_titles.csv"
MIN_WORDS = 1
MAX_WORDS = 3
MAX_CHARS = 30
MAX_ATTEMPTS = 6


def _tiles_to_title(tile_dir: str, index: dict, include_all: bool):
    """Yield (key, entry) for tiles with a story (or 'final' unless --all)."""
    for key in sorted(index):
        entry = index[key]
        if not entry.get("story"):
            continue
        if not include_all and not entry.get("final"):
            continue
        if not os.path.exists(os.path.join(tile_dir, key)):
            continue
        yield key, entry


def load_existing_titles(csv_path: str) -> dict:
    """Return {filename: title} from a prior run's CSV, or {} if absent."""
    if not os.path.exists(csv_path):
        return {}
    done = {}
    with open(csv_path, newline="", encoding="utf-8") as file:
        for row in csv.reader(file):
            if len(row) >= 2:
                done[row[0]] = row[1]
    return done


def _clean_title(raw: str) -> str:
    title = raw.strip().strip("\"'").strip()
    title = title.splitlines()[0] if title else title
    return title.rstrip(".").strip()


def _validation_error(title: str, used_titles: set) -> str | None:
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
    if title.casefold() in used_titles:
        return (
            f'"{title}" is already the title of another tile. Propose a different one -- '
            "respond with only the title."
        )
    return None


def propose_title(image_path: str, story: str, used_titles: set, model: str) -> str | None:
    """Ask the model for a unique 1-3 word title, retrying on rule violations.

    Returns None if no valid title emerged within MAX_ATTEMPTS.
    """
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
            return title
        turns.append(("user", error))
    return None


def run(tile_dir: str, csv_path: str, model: str, include_all: bool) -> None:
    index = core.load_index(tile_dir)
    done = load_existing_titles(csv_path)
    used_titles = {t.casefold() for t in done.values()}

    targets = [
        (key, entry)
        for key, entry in _tiles_to_title(tile_dir, index, include_all)
        if key not in done
    ]
    print(f"{len(done)} title(s) already recorded, {len(targets)} to go", file=sys.stderr)

    with open(csv_path, "a", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        for key, entry in targets:
            image_path = os.path.join(tile_dir, key)
            title = propose_title(image_path, entry["story"], used_titles, model)
            if title is None:
                print(f"skip {key}: no valid title after {MAX_ATTEMPTS} attempts", file=sys.stderr)
                continue
            writer.writerow([key, title])
            file.flush()
            used_titles.add(title.casefold())
            print(f"{key} -> {title}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("dir", help="Tile directory.")
    parser.add_argument("--out", default=None, help=f"CSV path (default: DIR/{CSV_NAME}).")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model id (default: local server).")
    parser.add_argument(
        "--all", action="store_true", help="Title tiles with a story even if not marked final."
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not os.path.isdir(args.dir):
        print(f"{args.dir} not found", file=sys.stderr)
        return 1
    csv_path = args.out or os.path.join(args.dir, CSV_NAME)
    try:
        run(args.dir, csv_path, args.model, args.all)
    except KeyboardInterrupt:
        print("\ninterrupted -- progress saved", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
