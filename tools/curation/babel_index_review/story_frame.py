"""
Babel Index's configuration for ``story_engine``: the frame, the payload and
form lists, and where traces go.

The payload and form lists are ``data/story_payloads.json`` and
``data/story_forms.json``, relative to the launch directory like every other
``data/`` default here. Traces go to ``story_traces/`` inside the tile
directory, one ``<tile stem>.jsonl`` per tile. The corpus scanner lists only
image files at a corpus root, so the subdirectory is ignored if that
directory is later served.
"""

from __future__ import annotations

import os

from babel_index_review.core import BASE_SCENE
from story_engine import Engine, Frame, TraceLog, load_options

PAYLOADS_PATH = os.path.join("data", "story_payloads.json")
FORMS_PATH = os.path.join("data", "story_forms.json")
TRACE_DIR = "story_traces"

SUBJECT = (
    "This image is one room of an infinite library: a single shelved wall, "
    "randomly selected from the space of all possible and impossible settings. "
    "Thousands of these rooms sit side by side on a pannable map."
)

PRESENTATION = (
    "Beside each image the reader sees a very short piece of fiction from "
    "inside that room's world, and the image's keywords listed separately."
)

VOICE = (
    "The story is fully diegetic. Write from inside the world, as someone to "
    "whom it is ordinary."
)

STYLE_RULES = [
    "Don't use em dashes.",
]


def build_frame() -> Frame:
    return Frame(
        subject=SUBJECT,
        base_scene=BASE_SCENE,
        presentation=PRESENTATION,
        voice=VOICE,
        payloads=load_options(PAYLOADS_PATH),
        forms=load_options(FORMS_PATH),
        style_rules=STYLE_RULES,
    )


def build_engine(tile_dir: str) -> Engine:
    return Engine(build_frame(), TraceLog(os.path.join(tile_dir, TRACE_DIR)))


def subject_for(key: str) -> str:
    """The trace subject for a tile key: its filename stem."""
    return os.path.splitext(key)[0]
