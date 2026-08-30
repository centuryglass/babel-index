"""
Sensitive-content tagging for the babel-index project, via the local vision model.

For each tile with a story, sends the image plus its story to a local
llama.cpp server and asks which of the fixed ``core.SENSITIVE_TAGS`` vocabulary
apply, if any. The model must answer with a JSON array drawn only from that
list (or an empty array); if it invents a tag, returns malformed JSON, or
otherwise breaks the contract, it's told why and asked to try again, in the
same conversation, until it produces something valid.

    python -m babel_index_review.sensitive_tags DIR [--model MODEL] [--all] [--retag]

Valid results are written straight to ``metadata.json`` as each tile finishes,
so an interrupted run (Ctrl+C included) never loses prior progress. By default
tiles that already have a ``sensitive_content_tags`` key (including an
explicit empty list from a prior "none apply" verdict) are skipped; pass
--retag to re-run everything instead.

By default only tiles marked ``"final"`` are considered -- pass --all to also
tag tiles that merely have a story. ``--model`` accepts anything
``tag.describe_image`` does (``local:...`` for the local server, which is the
default; a bare Claude model id to use the paid API instead).
"""

import argparse
import json
import os
import sys

from babel_index_review import core
from tag.describe_image import LOCAL_PREFIX, converse_about_image

DEFAULT_MODEL = LOCAL_PREFIX  # empty tail: single-model llama-server picks its loaded model
MAX_ATTEMPTS = 6

_TAG_SET = set(core.SENSITIVE_TAGS)


def _tiles_to_tag(tile_dir: str, index: dict, include_all: bool, retag: bool):
    """Yield (key, entry) for tiles with a story (or 'final' unless --all)."""
    for key in sorted(index):
        entry = index[key]
        if not entry.get("story"):
            continue
        if not include_all and not entry.get("final"):
            continue
        if not retag and "sensitive_content_tags" in entry:
            continue
        if not os.path.exists(os.path.join(tile_dir, key)):
            continue
        yield key, entry


def _extract_json_array(raw: str) -> str:
    """Pull the last ``[...]`` substring out of a reply.

    The prompt asks the model to reason per-tag before answering, so the array
    is the last thing in the reply, not the first -- and the reasoning lines
    may themselves contain stray brackets. Anchoring on the final ``]`` and its
    nearest preceding ``[`` finds the actual answer regardless.
    """
    end = raw.rfind("]")
    if end == -1:
        return raw
    start = raw.rfind("[", 0, end)
    if start == -1:
        return raw
    return raw[start : end + 1]


def _parse_tags(raw: str) -> tuple[list[str] | None, str | None]:
    """Parse and validate a reply against the tag vocabulary.

    Returns (tags, error). Exactly one of the two is None.
    """
    text = _extract_json_array(raw.strip())
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None, (
            "I couldn't find a valid JSON array as the last line of that reply. "
            'End your response with just the array on its own line, e.g. ["gore"] '
            "or [] -- nothing after it."
        )
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        return None, (
            "The last line needs to be a JSON array of strings (or an empty "
            "array), with nothing after it."
        )
    unknown = sorted({item for item in parsed if item not in _TAG_SET})
    if unknown:
        allowed = ", ".join(core.SENSITIVE_TAGS)
        return None, (
            f"{unknown!r} {'is not a valid tag' if len(unknown) == 1 else 'are not valid tags'}. "
            f"Choose only from: {allowed}. Redo the final array with only tags from that list."
        )
    # De-dupe while preserving the model's ordering.
    seen = []
    for item in parsed:
        if item not in seen:
            seen.append(item)
    return seen, None


def propose_tags(image_path: str, story: str, model: str) -> list[str] | None:
    """Ask the model which sensitive-content tags apply, retrying on violations.

    Returns None if no valid answer emerged within MAX_ATTEMPTS.
    """
    allowed = ", ".join(core.SENSITIVE_TAGS)
    prompt = (
        "This is one tile from a large dataset of surreal bookshelf-library images, "
        "each paired with a short piece of weird/dark-academia flash fiction. The "
        "whole dataset is intentionally uncanny, melancholy, and strange -- that "
        "tone is the baseline, not a warning sign. Most tiles, including moody or "
        "gothic-looking ones, deserve ZERO tags. You are looking for the rare tile "
        "that is actually graphic or disturbing, using ONLY this fixed tag list: "
        f"{allowed}.\n\n"
        f"The image/story pair:\n\n\"{story}\"\n\n"
        "Strict definitions -- a tag applies ONLY if the described condition is "
        "literally, visibly true in THIS SPECIFIC image or story, not just "
        "consistent with a dark mood:\n"
        "- gore: blood, mutilation, dismemberment, or open wounds are explicitly "
        "shown or described.\n"
        "- body-horror: a body is depicted as grotesquely deformed, fused, or "
        "transformed in a visceral, unsettling way.\n"
        "- horror: a monster, ghost, or scene built specifically to frighten is "
        "depicted or vividly described -- not just gothic decor, candlelight, "
        "shadows, cobwebs, skeletal motifs as ornamentation, or a melancholy/"
        "uncanny tone.\n"
        "- death: an actual corpse, dead body, or an on-page killing is the "
        "visible/described subject -- not history, absence, silence, or things "
        "being lost/forgotten/abandoned.\n"
        "- insects/arthropods: real insects, spiders, or other arthropods are a "
        "visible, prominent subject of the IMAGE itself.\n"
        "- trypophobia: the IMAGE itself shows a dense cluster of small holes, "
        "bumps, or pores as a prominent visual element -- not book spines, shelf "
        "slats, or normal architectural repetition.\n\n"
        "First, for each of the 6 tags, write one short line: the tag name, then "
        'either "no" or a direct quote/description of the specific evidence in '
        "THIS image/story that justifies it. Do not stretch a quote to fit -- if "
        'you have to explain why something "counts as" the tag, the answer is no.\n\n'
        "Then, on the final line by itself, write the JSON array of only the tags "
        "you found real evidence for (exact spelling from the list above), or [] "
        "if none. The array must be the last line, with no other text after it."
    )
    turns = [("user", prompt)]
    for _ in range(MAX_ATTEMPTS):
        reply = converse_about_image(image_path, turns, model=model)
        turns.append(("assistant", reply))
        tags, error = _parse_tags(reply)
        if error is None:
            return tags
        turns.append(("user", error))
    return None


def run(tile_dir: str, model: str, include_all: bool, retag: bool) -> None:
    index = core.load_index(tile_dir)
    targets = list(_tiles_to_tag(tile_dir, index, include_all, retag))
    print(f"{len(targets)} tile(s) to check", file=sys.stderr)

    for key, entry in targets:
        image_path = os.path.join(tile_dir, key)
        tags = propose_tags(image_path, entry["story"], model)
        if tags is None:
            print(f"skip {key}: no valid answer after {MAX_ATTEMPTS} attempts", file=sys.stderr)
            continue
        if tags:
            entry["sensitive_content_tags"] = tags
        else:
            entry.pop("sensitive_content_tags", None)
        core.save_index(tile_dir, index)
        print(f"{key} -> {tags or '(none)'}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("dir", help="Tile directory.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model id (default: local server).")
    parser.add_argument(
        "--all", action="store_true", help="Check tiles with a story even if not marked final."
    )
    parser.add_argument(
        "--retag", action="store_true", help="Re-check tiles that already have a verdict."
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not os.path.isdir(args.dir):
        print(f"{args.dir} not found", file=sys.stderr)
        return 1
    try:
        run(args.dir, args.model, args.all, args.retag)
    except KeyboardInterrupt:
        print("\ninterrupted -- progress saved", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
