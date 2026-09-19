"""
Title generation for the babel-index project, via a vision-capable model.

For each finalized tile, sends the image plus its story (never the seed
keywords, so the title comes from the narrative rather than the prompt) to
the model and asks for a short title. Uniqueness and length are enforced by
talking back: if the model's answer collides with a title already in use, or
breaks the word-count/length limits, it's told why and asked to try again, in
the same conversation, until it produces something valid.

"Collides" is near-match, not just exact: two titles collide if they're equal
after casefolding and dropping "a"/"an"/"the", or if that normalized form is
within NEAR_MATCH_MAX_DISTANCE edit-distance of one already claimed -- see
TitleRegistry. A corpus that already has near-duplicate titles from before
this rule existed is left alone; ``run`` only warns about them at startup, it
never rewrites an existing title.

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
import threading
from typing import Iterable

from babel_index_review import core, parallel
from tag.describe_image import DEFAULT_MODEL, converse_about_image

MIN_WORDS = 1
MAX_WORDS = 3
MAX_CHARS = 30
MAX_ATTEMPTS = 6

ARTICLES = {"a", "an", "the"}
NEAR_MATCH_MAX_DISTANCE = 2


def _normalize_for_matching(title: str) -> str:
    """Fold a title down to the form near-duplicate comparison treats as canonical.

    Case-insensitive, with "a"/"an"/"the" dropped as interchangeable filler
    words, so "The Main Ledger" and "A Main Ledger" compare identically.
    """
    words = [w for w in title.casefold().split() if w not in ARTICLES]
    return " ".join(words)


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[-1]


def _is_near_duplicate(norm_a: str, norm_b: str) -> bool:
    return _levenshtein(norm_a, norm_b) <= NEAR_MATCH_MAX_DISTANCE


class TitleRegistry:
    """Tracks claimed titles and flags near-duplicates, not just exact repeats.

    Two titles collide under `_is_near_duplicate` on their normalized forms
    (see `_normalize_for_matching`). Reservation is atomic under one lock, so
    two concurrent workers proposing near-duplicate titles ("The Main
    Ledger" / "The Plain Ledger") can't both win -- the same race
    `parallel.SharedTitleSet` guards against for exact titles.
    """

    def __init__(self, seed_titles: Iterable[str] = ()):
        self._lock = threading.Lock()
        self._claimed: list[tuple[str, str]] = [
            (_normalize_for_matching(title), title) for title in seed_titles
        ]
        self._seed_count = len(self._claimed)

    def conflict(self, title: str) -> str | None:
        """Return the already-claimed title `title` collides with, or None."""
        norm = _normalize_for_matching(title)
        with self._lock:
            for existing_norm, existing_title in self._claimed:
                if _is_near_duplicate(norm, existing_norm):
                    return existing_title
        return None

    def try_reserve(self, title: str) -> str | None:
        """Atomically claim `title` if nothing already claimed collides with it.

        Returns None on success, or the colliding already-claimed title.
        """
        norm = _normalize_for_matching(title)
        with self._lock:
            for existing_norm, existing_title in self._claimed:
                if _is_near_duplicate(norm, existing_norm):
                    return existing_title
            self._claimed.append((norm, title))
        return None

    def pre_existing_conflicts(self) -> list[tuple[str, str]]:
        """Pairs of seeded titles that already violate the near-match rule.

        Only compares the titles present at construction -- newly reserved
        titles can't collide with each other without one of them having been
        rejected first, so there's nothing further to report here.
        """
        seed = self._claimed[: self._seed_count]
        conflicts = []
        for i, (norm_a, title_a) in enumerate(seed):
            for norm_b, title_b in seed[i + 1 :]:
                if _is_near_duplicate(norm_a, norm_b):
                    conflicts.append((title_a, title_b))
        return conflicts


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


def _validation_error(title: str, used_titles: TitleRegistry) -> str | None:
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
    conflict = used_titles.conflict(title)
    if conflict is not None:
        return (
            f'"{title}" is too close to the existing title "{conflict}" (case, '
            '"a"/"an"/"the", and 1-2 character changes don\'t count as different). Propose '
            "something more distinct -- respond with only the title."
        )
    return None


def propose_title(
    image_path: str, story: str, used_titles: TitleRegistry, model: str, key: str | None = None
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
            conflict = used_titles.try_reserve(title)
            if conflict is None:
                return title
            error = (
                f'"{title}" was just claimed by another tile (too close to "{conflict}"). '
                "Propose a different one -- respond with only the title."
            )
        print(f"{label}: rejected {title!r} -- {error}")
        turns.append(("user", error))
    return None


def run(tile_dir: str, model: str, include_all: bool, workers: int) -> None:
    index = core.load_index(tile_dir)
    filename_index = {}
    for key in index:
        if index[key].get("title"):
            filename_index[index[key]["title"]] = key
    existing_titles = [entry["title"] for entry in index.values() if entry.get("title")]
    used_titles = TitleRegistry(existing_titles)

    conflicts = used_titles.pre_existing_conflicts()
    if conflicts:
        print(
            f"warning: {len(conflicts)} pre-existing near-duplicate title pair(s) "
            "(left as-is):",
            file=sys.stderr,
        )
        for title_a, title_b in conflicts:
            print(f"  {filename_index[title_a]}:{title_a!r} ~ {filename_index[title_b]}:{title_b!r}", file=sys.stderr)

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
