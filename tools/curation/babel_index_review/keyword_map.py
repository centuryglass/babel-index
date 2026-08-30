"""
Interactive keyword categorizer/renamer -- builds ``keyword_map.json`` for the
babel-index project.

    python -m babel_index_review.keyword_map

Reads style keywords one per line from ``keyword_path`` (a wildcard file,
``data/all_styles.txt`` by default -- a snapshot pulled from a local SD
install's dynamic-prompts wildcards; override with ``BABEL_KEYWORD_SOURCE`` to
re-sync against a live wildcard file instead), skips any already present in
``keyword_map.json``, and for each remaining one prompts for a single-character
category pick (or 'r' to rename it first, looping back to ask for the category
again). Progress is only written to ``keyword_map.json`` at the end, but
Ctrl+C/Ctrl+D during the prompt breaks out of the loop cleanly first so what's
been picked so far is still saved rather than lost.
"""

import json
import os
import sys
from pathlib import Path

# Helper for cross-platform single character input
def get_char():
    try:
        import msvcrt
        return msvcrt.getch().decode('utf-8', 'ignore')
    except ImportError:
        import tty
        import termios
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)
        try:
            tty.setraw(sys.stdin.fileno())
            ch = sys.stdin.read(1)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
        return ch

_DEFAULT_KEYWORD_PATH = Path(__file__).resolve().parent.parent / "data" / "all_styles.txt"
keyword_path = os.environ.get("BABEL_KEYWORD_SOURCE", str(_DEFAULT_KEYWORD_PATH))
map_file = 'keyword_map.json'

categories = [
    'descriptive',
    'medium/material',
    'technique/process',
    'movement/style',
    'artist',
    'genre/aesthetic',
    'setting/environment',
    'object/subject',
    'lighting/optical',
    'era/cultural',
    'technology',
    'LoRA model',
    'other'
]


def main() -> None:
    category_prompt = ', '.join([f"{name} ({i})" for i, name in enumerate(categories)])
    category_prompt += " or (r)ename"
    print(category_prompt)

    # Load keyword file to lines, trimming \n
    keywords = []
    if os.path.exists(keyword_path):
        with open(keyword_path, 'r', encoding='utf-8') as f:
            keywords = [line.strip() for line in f if line.strip()]
    else:
        print(f"Warning: Keyword file not found at {keyword_path}")

    # Load existing map file as keyword_map, or init keyword_map as empty dict
    keyword_map = {}
    if os.path.exists(map_file):
        with open(map_file, 'r', encoding='utf-8') as f:
            try:
                keyword_map = json.load(f)
            except json.JSONDecodeError:
                keyword_map = {}

    print("\nPress Ctrl+C at any time to save progress and exit.")

    # For each keyword line:
    try:
        for keyword in keywords:
            # if it exists in the keyword_map already, skip it
            if keyword in keyword_map:
                continue

            rename = None

            while True:
                # display f"{keyword}: select {category_prompt}"
                print(f"\n{keyword}: select {category_prompt}: ", end='', flush=True)

                # accept single input character inpt (preferably not requiring enter)
                inpt = get_char()

                # Handle Ctrl+C (ETX) and Ctrl+D (EOT) explicitly for raw tty inputs
                if inpt in ('\x03', '\x04'):
                    print("\nExiting early...")
                    raise KeyboardInterrupt

                print(inpt) # Echo the character to the terminal
                inpt = inpt.lower()

                # if inpt is 'r':
                if inpt == 'r':
                    # rename = user line input
                    rename = input(f"Rename '{keyword}' to: ").strip()
                    # Loop back to ask for category again, retaining the rename value
                    continue

                # if inpt is int between 0 and len(categories) -1 inclusive:
                if inpt.isdigit() and 0 <= int(inpt) < len(categories):
                    category = categories[int(inpt)]
                    data = { 'category': category }
                    if rename is not None:
                        data['rename'] = rename
                    keyword_map[keyword] = data
                else:
                    print(f"skipping {keyword} for now")

                # Break the while loop to move to the next keyword
                break

    except KeyboardInterrupt:
        pass

    # write keyword_map to map_file with indentation=2
    with open(map_file, 'w', encoding='utf-8') as f:
        json.dump(keyword_map, f, indent=2)

    print(f"\nSaved {len(keyword_map)} entries to {map_file}")


if __name__ == "__main__":
    main()
