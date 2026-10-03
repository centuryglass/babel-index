"""
Babel Index's collection memory: every Final story, tagged with its tropes,
payload and provenance, in the tile directory's ``collection_memory.json``.

    python -m babel_index_review.collection_memory DIR [--model MODEL] [--workers N] [--retag] [--no-sync] [--json] [--limit N]

A run first syncs memory with ``metadata.json``, then prints a report of
what the collection repeats (``story_engine.memory.analyze``):

- a Final tile whose story memory doesn't hold yet, or holds an older text
  of, is tagged with one model call (``--retag`` tags every one again);
- an entry whose tile is gone or no longer Final is dropped.

The first run backfills the whole collection. ``--no-sync`` reports on
memory as it stands, with no model calls. The review GUI tags a story when
it is marked Final and drops it when Final is cleared, so later runs only
catch up on edits made elsewhere.

The file is indexed by tile key::

    {"stories": {"00012.webp": {"story": "...", "tropes": [...], "payload": "...",
                                "seed": ..., "form": ..., "constraint": ...,
                                "model": "...", "tagged": "..."}}}

Seed, form and constraint come from the tile's chosen draft in its workspace
(``story_frame.TRACE_DIR``), and are null for a story the engine didn't
write. Writes go through ``core.update_json``, so the GUI and this script can
run at once.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict

from babel_index_review import core, parallel, story_frame
from story_engine.memory import MemoryEntry, analyze, format_report, tag_story
from story_engine.trace import TraceLog
from story_engine.workspace import Workspace, import_trace, now
from tag.describe_image import DEFAULT_MODEL

MEMORY_JSON = "collection_memory.json"


def memory_path(tile_dir: str) -> str:
    return os.path.join(tile_dir, MEMORY_JSON)


def load(tile_dir: str, strict: bool = False) -> dict[str, MemoryEntry]:
    """Every entry, by tile key. ``strict`` is ``core.load_json``'s."""
    stories = core.load_json(memory_path(tile_dir), strict).get("stories", {})
    return {key: MemoryEntry(**entry) for key, entry in stories.items()}


def _update(tile_dir: str, mutate) -> None:
    """``mutate(stories)`` on the stored ``{key: entry dict}`` map, under the file lock."""

    def apply(data: dict) -> dict:
        data.setdefault("stories", {})
        mutate(data["stories"])
        return data

    core.update_json(memory_path(tile_dir), apply)


def record(tile_dir: str, key: str, entry: MemoryEntry) -> None:
    _update(tile_dir, lambda stories: stories.__setitem__(key, asdict(entry)))


def forget(tile_dir: str, keys: list[str]) -> None:
    def drop(stories: dict) -> None:
        for key in keys:
            stories.pop(key, None)

    _update(tile_dir, drop)


def known_tropes(tile_dir: str) -> list[str]:
    """Trope labels memory already uses, for the tagger to reuse."""
    return sorted({trope for entry in load(tile_dir).values() for trope in entry.tropes})


def _workspace(tile_dir: str, key: str) -> Workspace | None:
    """The tile's workspace, read without writing one for a trace-only tile."""
    directory = os.path.join(tile_dir, story_frame.TRACE_DIR)
    subject = story_frame.subject_for(key)
    path = os.path.join(directory, f"{subject}.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as file:
            return Workspace.from_json(json.load(file))
    events = TraceLog(directory).events(subject)
    return import_trace(events) if events else None


def provenance(tile_dir: str, key: str, workspace: Workspace | None = None) -> dict:
    """``{"seed", "form", "constraint"}`` from the tile's chosen draft, each None when unknown.

    ``workspace`` is the tile's workspace when the caller has it loaded, so
    unsaved GUI edits count; otherwise it is read from disk.
    """
    workspace = workspace if workspace is not None else _workspace(tile_dir, key)
    draft = workspace.draft(workspace.chosen) if workspace else None
    if draft is None:
        return {"seed": None, "form": None, "constraint": None}
    pitch = workspace.pitch(draft.pitch_id)
    return {"seed": pitch.seed if pitch else None, "form": draft.form or None, "constraint": draft.constraint}


def tag(story: str, model: str, tropes: list[str], origin: dict) -> MemoryEntry:
    """Tag ``story`` into a new entry. Blocks on the network."""
    found, payload = tag_story(story, model, tropes)
    return MemoryEntry(story=story, tropes=found, payload=payload, model=model, tagged=now(), **origin)


def sync(tile_dir: str, model: str, workers: int, retag: bool = False) -> None:
    """Bring memory in line with the Final stories in ``metadata.json``.

    Stories are tagged in waves of ``workers``, each wave given the trope
    labels memory holds when it starts. A backfill starts from an empty
    vocabulary, and waves let later stories reuse the labels earlier ones
    introduced, which parallel calls given one shared list cannot.

    Both files are read strictly: a torn read of ``metadata.json`` taken as
    empty would drop every entry.
    """
    index = core.load_index(tile_dir, strict=True)
    final = {key: e["story"] for key, e in index.items() if e.get("final") and (e.get("story") or "").strip()}
    memory = load(tile_dir, strict=True)
    gone = [key for key in memory if key not in final]
    if gone:
        forget(tile_dir, gone)
        print(f"dropped {len(gone)} entries no longer Final", file=sys.stderr)
    todo = sorted(key for key, story in final.items() if retag or key not in memory or memory[key].story != story)
    if not todo:
        return
    size = parallel.resolve_workers(model, workers)
    print(f"tagging {len(todo)} stories with {model}", file=sys.stderr)
    failures = 0
    with ThreadPoolExecutor(max_workers=size) as pool:
        for start in range(0, len(todo), size):
            tropes = known_tropes(tile_dir)
            wave = {
                pool.submit(tag, final[key], model, tropes, provenance(tile_dir, key)): key
                for key in todo[start : start + size]
            }
            for future in as_completed(wave):
                key = wave[future]
                try:
                    record(tile_dir, key, future.result())
                    print(f"{key}: {', '.join(future.result().tropes)}", file=sys.stderr)
                except Exception as err:  # one bad reply shouldn't stop the backfill
                    failures += 1
                    print(f"{key} failed: {err}", file=sys.stderr)
    if failures:
        print(f"{failures} stories failed; run again to retry them", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("dir", help="Tile directory.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Tagging model (default {DEFAULT_MODEL}).")
    parser.add_argument("--workers", type=int, default=parallel.DEFAULT_WORKERS, help="Tagging calls in flight.")
    parser.add_argument("--retag", action="store_true", help="Tag every Final story again.")
    parser.add_argument("--no-sync", action="store_true", help="Report on memory as it is, with no model calls.")
    parser.add_argument("--json", action="store_true", help="Print the report as JSON.")
    parser.add_argument("--limit", type=int, default=25, help="Items per Markdown report section.")
    parser.add_argument("--min-stories", type=int, default=2, help="Stories a pattern needs to be reported.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not os.path.isdir(args.dir):
        print(f"{args.dir} not found", file=sys.stderr)
        return 1
    try:
        if not args.no_sync:
            sync(args.dir, args.model, args.workers, args.retag)
    except KeyboardInterrupt:
        print("\ninterrupted -- progress saved", file=sys.stderr)
        return 130
    report = analyze(list(load(args.dir).values()), args.min_stories)
    print(json.dumps(asdict(report), ensure_ascii=False, indent=1) if args.json else format_report(report, args.limit))
    return 0


if __name__ == "__main__":
    sys.exit(main())
