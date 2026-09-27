"""
Print every reviewed pitch batch in a tile directory as Markdown.

    python -m babel_index_review.story_critiques DIR [--out FILE]

Critiques, rejections and chosen drafts are recorded in the review GUI and
stored in ``DIR/story_traces/``. This collects them with the batch they
belong to, so they can be read in one pass and distilled into pitch
instructions. A batch appears if it has any critique, batch note or
rejection. Every pitch in it is listed, since what drew no comment is also
signal, along with any drafts.

Pitch fields are printed as stored, so batches from older pitch formats
still export.
"""

from __future__ import annotations

import argparse
import os

from babel_index_review import core, story_frame
from story_engine import TraceLog


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
        events = trace.events(subject)
        chosen = {(e.get("run"), e.get("story")) for e in events if e.get("stage") == "choose"}
        for event in events:
            if event.get("stage") != "pitch":
                continue
            run = event["run"]
            result = event.get("result")
            if isinstance(result, dict):
                reading, pitches = result.get("reading", {}), result.get("pitches", [])
            else:
                reading, pitches = {}, result or []
            critiques = engine.critiques(subject, run)
            rejected = engine.rejected(subject, run)
            if not critiques and not rejected:
                continue
            lines = [f"## {key or subject}, batch {run} ({event.get('model')})", f"Keywords: {keywords}"]
            if reading.get("enigma"):
                lines.append(f"Enigma: {reading['enigma']}")
            if None in critiques:
                lines.append(f"**Batch note:** {critiques[None]}")
            drafts = engine.drafts(subject, run)
            for i, pitch in enumerate(pitches):
                fields = list(pitch.items())
                head = f"[{fields[0][1]}] {fields[1][1]}" if len(fields) > 1 else str(pitch)
                verdict = " **(rejected)**" if i in rejected else ""
                lines += ["", f"{i + 1}. {head}{verdict}"]
                lines += [f"   - {k.capitalize()}: {v}" for k, v in fields[2:]]
                lines.append(f"   - **Critique:** {critiques[i]}" if i in critiques else "   - (no critique)")
                for draft in (d for d in drafts if d.index == i):
                    star = " ★ chosen" if (run, draft.story) in chosen else ""
                    tags = draft.form + (f" + {draft.constraint}" if draft.constraint else "")
                    body = draft.story.replace("\n", "\n     > ")
                    lines.append(f"   - Draft ({tags}){star}:\n     > {body}")
            sections.append("\n".join(lines))
    return "\n\n".join(sections) + "\n" if sections else "No reviewed batches yet.\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Print every reviewed pitch batch as Markdown.")
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
