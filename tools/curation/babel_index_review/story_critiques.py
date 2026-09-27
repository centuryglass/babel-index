"""
Print every critiqued pitch batch in a tile directory as Markdown.

    python -m babel_index_review.story_critiques DIR [--out FILE]

Critiques are written in the review GUI's Pitches panel and stored as
``critique`` events in ``DIR/story_traces/``. This collects them with the
batch they belong to, so the critiques can be read in one pass and distilled
into pitch instructions. A batch appears if it has any critique or batch
note; its uncritiqued pitches are listed too, since what drew no comment is
also signal.
"""

from __future__ import annotations

import argparse
import os

from babel_index_review import core, story_frame
from story_engine import PitchBatch, TraceLog


def report(tile_dir: str) -> str:
    trace = TraceLog(os.path.join(tile_dir, story_frame.TRACE_DIR))
    engine = story_frame.build_engine(tile_dir)
    index = core.load_index(tile_dir)
    if not os.path.isdir(trace.directory):
        return "No traces.\n"

    sections = []
    for name in sorted(os.listdir(trace.directory)):
        if not name.endswith(".jsonl"):
            continue
        subject = name[: -len(".jsonl")]
        key = next((k for k in index if story_frame.subject_for(k) == subject), None)
        keywords = ", ".join(core.keyword_texts(index[key])) if key else "?"
        for event in trace.events(subject):
            if event.get("stage") != "pitch":
                continue
            batch = PitchBatch.from_event(event)
            if batch is None:
                continue
            critiques = engine.critiques(subject, batch.run)
            if not critiques:
                continue
            lines = [
                f"## {key or subject}, batch {batch.run} ({event.get('model')})",
                f"Keywords: {keywords}",
                f"Enigma: {batch.reading.enigma}",
            ]
            if None in critiques:
                lines.append(f"**Batch note:** {critiques[None]}")
            for i, pitch in enumerate(batch.pitches):
                lines += [
                    "",
                    f"{i + 1}. [{pitch.payload}] {pitch.premise}",
                    f"   - Turn: {pitch.turn}",
                    f"   - Anchor: {pitch.anchor}",
                    f"   - **Critique:** {critiques[i]}" if i in critiques else "   - (no critique)",
                ]
            sections.append("\n".join(lines))
    return "\n\n".join(sections) + "\n" if sections else "No critiques yet.\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Print every critiqued pitch batch as Markdown.")
    parser.add_argument("dir", help="Tile directory holding metadata.json and story_traces/.")
    parser.add_argument("--out", help="Write to this file instead of stdout.")
    args = parser.parse_args()
    text = report(args.dir)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as file:
            file.write(text)
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
