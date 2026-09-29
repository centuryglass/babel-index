"""
Print every reviewed tile's pitches and drafts in a tile directory as Markdown.

    python -m babel_index_review.story_critiques DIR [--out FILE]

Pitch notes, dropped pitches, drafts and the chosen one are recorded in the
review GUI and kept in each tile's workspace (``DIR/story_traces/<stem>.json``).
This collects them in one pass, to be distilled into pitch instructions. A
tile appears if it has any note or dropped pitch. Every pitch on it is
listed, since what drew no comment is also signal, along with its drafts.

Reading this imports a workspace from its trace the same way opening the
tile in the GUI does, so tiles reviewed before workspaces existed export too.
"""

from __future__ import annotations

import argparse
import os

from babel_index_review import core, story_frame


def report(tile_dir: str) -> str:
    store = story_frame.build_store(tile_dir)
    index = core.load_index(tile_dir)
    if not os.path.isdir(store.directory):
        return "No traces.\n"

    subjects = sorted(
        {os.path.splitext(name)[0] for name in os.listdir(store.directory) if name.endswith((".json", ".jsonl"))}
    )
    sections = []
    for subject in subjects:
        workspace = store.load(subject)
        if not any(p.note or not p.kept for p in workspace.pitches):
            continue
        key = next((k for k in index if story_frame.subject_for(k) == subject), None)
        keywords = ", ".join(core.keyword_texts(index[key])) if key else "?"
        lines = [f"## {key or subject}", f"Keywords: {keywords}"]
        if workspace.reading:
            lines.append(f"Enigma: {workspace.reading.enigma}")
        for number, pitch in enumerate(workspace.pitches, 1):
            verdict = "" if pitch.kept else " **(dropped)**"
            lines += ["", f"{number}. [{pitch.seed}] {pitch.pitch}{verdict}"]
            lines += [f"   - Hook: {pitch.hook}", f"   - Anchor: {pitch.anchor}"]
            lines.append(f"   - **Note:** {pitch.note}" if pitch.note else "   - (no note)")
            for draft in (d for d in workspace.drafts if d.pitch_id == pitch.id):
                star = " ★ chosen" if draft.id == workspace.chosen else ""
                dropped = " (dropped)" if draft.dropped else ""
                tags = draft.form + (f" + {draft.constraint}" if draft.constraint else "")
                body = draft.story.replace("\n", "\n     > ")
                lines.append(f"   - Draft ({tags}){star}{dropped}:\n     > {body}")
        sections.append("\n".join(lines))
    return "\n\n".join(sections) + "\n" if sections else "No reviewed tiles yet.\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Print every reviewed tile's pitches and drafts as Markdown.")
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
