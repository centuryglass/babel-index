"""
Model-written explanations of style keywords, kept as a quick reference.

The review GUI asks a model what it knows about one of a tile's keywords (an
artist, a medium, a movement) and stores the answer in the tile directory's
``llm_tag_descriptions.json``, indexed ``[keyword text][model id]``::

    {"Funk art": {"openrouter:some/model": {"text": "...", "created": "..."}}}

The explanations are for the curator only: nothing feeds them into a story
prompt. Comparing models is the point, so each model keeps its own entry and
a re-explain replaces only that one. Writes go through ``core.update_json``,
so explanations finishing in parallel (or in a second GUI) merge.
"""

from __future__ import annotations

import os

from babel_index_review import core
from story_engine.workspace import now
from tag.describe_image import converse_text

DESCRIPTIONS_JSON = "llm_tag_descriptions.json"

PROMPT = """\
You are a quick reference for someone curating AI-generated images. Each image \
was generated from a few style keywords, and a story is later written about it.

The keyword is "{keyword}" (category: {kind}).

In two short paragraphs, under 150 words in all, say what you know about it: \
who or what it is, its period and place, and the visual traits, themes or \
history an artist or writer would associate with it.

If you don't recognize the keyword, or only half recognize it, say so plainly \
in a sentence or two and stop. Don't invent details to fill the space.

Reply in plain prose: no headings, lists or markdown."""


def descriptions_path(tile_dir: str) -> str:
    return os.path.join(tile_dir, DESCRIPTIONS_JSON)


def load(tile_dir: str, strict: bool = False) -> dict:
    """Every stored explanation, ``{keyword: {model id: {"text", "created"}}}``."""
    return core.load_json(descriptions_path(tile_dir), strict)


def explain(keyword: str, kind: str, model: str) -> str:
    """Ask ``model`` what it knows about ``keyword``. Blocking; run it off the GUI thread."""
    text = converse_text([("user", PROMPT.format(keyword=keyword, kind=kind or "unknown"))], model=model)
    text = text.strip()
    if not text:
        raise ValueError(f"{model} returned an empty explanation")
    return text


def record(tile_dir: str, keyword: str, model: str, text: str) -> dict:
    """Store ``model``'s explanation of ``keyword``, merging with disk; returns the saved store."""

    def mutate(store: dict) -> dict:
        store.setdefault(keyword, {})[model] = {"text": text, "created": now()}
        return store

    return core.update_json(descriptions_path(tile_dir), mutate)


def preferred(explanations: dict, active_model: str | None) -> tuple[str, dict] | None:
    """The one explanation a tooltip shows: ``active_model``'s, else the first by model id."""
    if not explanations:
        return None
    if active_model is not None and active_model in explanations:
        return active_model, explanations[active_model]
    model = min(explanations, key=str.casefold)
    return model, explanations[model]
