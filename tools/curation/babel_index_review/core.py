"""
Shared logic for the babel-index tile pipeline and its review GUI.

A "tile" is a Library-of-Babel bookshelf image generated from three style
keywords. This module owns everything the batch importer
(``babel_index_review.tile_process``) and the review GUI
(``babel_index_review.gui``) have in common:

  - the on-disk layout (``metadata.json`` beside the ``NNNNN.webp`` tiles),
  - keyword extraction from A1111 prompt metadata + normalization via
    ``keyword_map.json``,
  - the default story prompt, and
  - the Claude calls that generate and revise stories.

Metadata schema (``metadata.json``), keyed by webp filename::

    {
      "00001.webp": {
        "keywords": [{"text": "syrup", "type": "material"}, ...],
        "story": "…",          # None/absent until generated
        "alt": "…",            # None/absent until generated; accessibility alt text
        "title": "…",          # None/absent until generated; see babel_index_review.titles
        "final": true          # absent/false until the reviewer approves it
      },
      ...
    }
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import random
import shutil
import tempfile
from typing import Callable, Optional

from PIL import Image

from lib.image_metadata import (
    read_image_metadata,
    get_a1111_params,
    parse_a1111_params,
)
from tag.describe_image import describe_image, converse_about_image, DEFAULT_MODEL
from util.metadata import do_update as copy_metadata

INDEX_JSON = "metadata.json"
DEFAULT_KEYWORD_MAP = "data/keyword_map.json"

# The repo's demo corpus (packages/server's --images default), for the
# review GUI's --sample-update "save to samples" button. This file lives at
# tools/curation/babel_index_review/core.py, three levels below the repo root.
SAMPLE_CORPUS_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "assets", "corpus-sample")
)

# Fields worth carrying from a curated tile onto a hand-picked sample: the
# review workflow's own bookkeeping (final, sensitive_content_tags,
# needs_inpainting) and the upload tool's content hash don't belong on it.
SAMPLE_FIELDS = ("keywords", "story", "title", "alt")

# Sensitive-content tag vocabulary shared by the review GUI and the
# batch tagger (babel_index_review.sensitive_tags). The GUI omits the key
# when a human clears every tag by hand; the batch tagger instead writes an
# explicit "sensitive_content_tags": [] for a tile it checked and found
# clean, so a later run without --retag knows not to check it again. Either
# way, a consumer should treat a missing key and an empty array the same.
SENSITIVE_TAGS = [
    "gore",
    "body-horror",
    "horror",
    "death",
    "insects/arthropods",
    "trypophobia",
]

WEBP_QUALITY = 80
WEBP_METHOD = 6


# ---------------------------------------------------------------------------
# Story prompt
# ---------------------------------------------------------------------------
QUESTIONS = [
    ("Tell us about the building this room exists within.", 1.0),
    ("Why are these books here?", 1.0),
    ("What's written in these books?", 1.0),
    ("Tell us about the person or group that controls this room.", 1.0),
    ("What's the last conversation anyone had in here?", 1.0),
    ("What should you do when you enter the room?", 1.0),
    ("What's with the decor?", 1.0),
    ("What's the most interesting thing you could learn from reading here?", 1.0),
    ("What life-changing idea is only found in these pages?", 1.0),
    ("Who'd burn this place down if they could?", 0.2),
    ("What would the world lose if these volumes were destroyed?", 0.2),
    ("What's the worst book in the collection?", 1.0),
    ("What did this room replace?", 1.0),
    ("What's directly on the other side of that wall?", 1.0),
    ("Who was the last person refused entry, and what were they told?", 1.2),
    ("What's the rule everyone here breaks anyway?", 1.0),
    ("What happens if you take one?", 0.2),
    ("How does a person end up working in this room?", 1.0),
    ("What's missing from this room?", 1.0),
    ("What is this room called on the building's floor plan?", 1.0),
    ("What would be carried out of here first in a fire?", 0.2),
    ("What's the oldest object in here, and what's the newest?", 0.5),
    ("Where did the furniture come from?", 1.0),
    ("What does this room cost to keep, and who pays?", 1.0),
    ("What complaint has been filed about this room?", 1.0),
    ("What's scheduled to happen here next?", 1.0),
    ("What would a stranger get wrong about this place?", 1.0),
    ("How is this room different at night?", 1.0),
    ("What should you never do here?", 0.35),
]

def sample_questions(k=4):
    """Weighted sample without replacement."""
    pool = list(QUESTIONS)
    picked = []
    for _ in range(min(k, len(pool))):
        q = random.choices(pool, weights=[w for _, w in pool])[0]
        pool.remove(q)
        picked.append(q[0])
    return picked


def default_prompt(keywords: list[str], k=4) -> str:
    """Return the default initial story prompt for a tile's keyword list.

    This is what the GUI resets the prompt field to whenever a tile is
    selected, and what the batch importer uses when bulk-generating stories.
    """
    questions = sample_questions(k)
    asked = "\n".join(f"- {q}" for q in questions)
 
    return (
        "This bookshelf was randomly selected from the space of all possible and "
        "impossible settings. Answer ONE of the following questions about it, in a "
        "few sentences:\n"
        f"{asked}\n"
        "Choose whichever question is most interesting for this particular image and "
        "isn't already answered by the image alone, and do not address the others. "
        "Ensure the response is self-contained and fully understandable on its own "
        "without explicitly repeating, quoting, or paraphrasing the question.\n"
        "Your answer is fully diegetic and will be presented as fiction. Write from "
        "inside the world, as someone to whom this is ordinary.\n"
        "Do not describe the image; it will be displayed beside your answer, so "
        "describing it is redundant. Explaining things is not redundant and is "
        "encouraged: what something is for, why it's like that, what it means here. "
        "Prefer facts about the world the room sits in over an inventory of the room, "
        "but always ensure your response connects to the most interesting part of the image.\n"
        f"Further context: this image was seeded from keywords {', '.join(keywords)}. Take tone "
        "and texture from them, but avoid naming them in your answer, and do not use "
        "any names they contain. The keywords are shown to the reader separately. "
        "Keep it short: there's a hard limit of 150 words. That's a budget, not a target, "
        " and most responses should be far shorter."
        "Avoid the emdash: proper use of it is no longer a quality writing "
        "signifier, now it just reads as uncurated AI output."
        "\n\nThis will be part of a huge dataset, and certain patterns have emerged "
        "often enough to become cliche. Please do not perpetuate them. The"
        " list:"
        "\n - \"Take one and the gap doesn't stay empty.\": even the subversions of "
        "this one have started to form patterns, like you can somehow tell it's a tired, "
        "well-worn trope in the dataset even without seeing it."
        "\n - \"it's not decorative, it's\": this substring and ones like it recur "
        "endlessly, and in 99.9 percent of cases I've seen, replacing it with \"is\""
        " is a dramatic improvement."
        "\n - \"bought by the yard\": Fake/junk books that are there just for "
        "decoration, used as the hook."
        "\n - The thing above the shelf being a clever machine that tracks the inventory."
        "\n - \"the books are paint/dye/fabric/material samples\": We've "
        "got a lot of those already, don't add another unless it's especially clever."
        "\n - Tedious business/industrial/bureaucratic minutia that doesn't tie into anything unexpected"
        "\n - Humidity/light need to be just right or the spines crack/ink fades"
        "\n - Books that are only there to serve as ballast/counterbalance/support/some other form of convenient mass"
        "\n - The books being terribly fragile, dissolving/melting/crumbling/etc. without some special procedure."
        "\n - Stories where burning the books would revert land property rights"
        "\n - The phrase \"in truth,\"."
        "\n - Text you can only read under a special light"
        "\n - Characters named Vane or Vance")




# ---------------------------------------------------------------------------
# Alt text prompt
# ---------------------------------------------------------------------------
# Every tile is a variation on the same recurring setting. Two failure modes
# pull in opposite directions: re-enumerating that setting on every tile wastes
# a screen-reader user's time, but describing a tile as a *delta* from it
# ("the lamp is replaced with...", "the columns are absent") is meaningless to
# a reader who hears only this one tile and was never shown the baseline. The
# prompt threads between them: name the setting once so the model can keep its
# fixed details brief, but require every sentence to describe what is actually
# present, never a change to an unseen original.
BASE_SCENE = (
    "a wooden bookcase against a dark wood wall, its shelves lined with rows of "
    "identical tidy books, a round wall-mounted lamp centered above it, and a "
    "wooden column on each side"
)


def default_alt_prompt(keywords: list[str]) -> str:
    """Return the default alt-text prompt for a tile's keyword list."""
    return (
        "Write alt text for this image, for a screen-reader user who will hear "
        "only your description of this one tile and has no other context.\n\n"
        "This tile is one of a large series that all share the same recurring "
        f"setting: {BASE_SCENE}. Because that setting repeats across the whole "
        "series, do NOT re-enumerate its fixed details (how many shelves, that "
        "the books are tidy and identical, the side columns) -- a light touch is "
        "enough to ground the reader, e.g. \"a shelved library wall\" or \"the "
        "bookcase.\" Spend your words instead on what makes THIS tile distinctive: "
        "its style, and anything added, altered, or unusual.\n\n"
        "Critical: describe what is actually present, exactly as it appears. The "
        "reader has never seen the base setting, so NEVER phrase anything as a "
        "change to it. Do not use \"replaced,\" \"instead of,\" \"no longer,\" "
        "\"absent,\" \"missing,\" \"used to,\" \"now a,\" \"has become,\" or "
        "\"where the X was.\" If a clock sits above the bookcase, write \"a clock "
        "sits above the bookcase\" -- not \"a clock instead of a lamp.\" If there "
        "is no lamp, simply don't mention a lamp. Every sentence should read as a "
        "plain description of this image on its own, never a comparison to another.\n\n"
        "Before you write, look closely at the whole frame, corner to corner: the "
        "foreground, the space beside and around the bookcase, and the "
        "architecture itself (ceiling, walls, floor, the shape of the shelf "
        "openings) -- not just the shelf contents. These tiles often add things "
        "with no equivalent in the base setting: furniture, figures, props, "
        "unusual fixtures above the shelf, or architecture doing something "
        "structurally strange (a warped or rolled ceiling, reshaped openings). "
        "When something like that is present it is usually the most important "
        "thing to describe; name concretely what it is rather than folding it "
        "into a vague texture/lighting note.\n\n"
        "Structure: lead with a brief style/medium description (a dozen words or "
        "fewer -- e.g. \"muted watercolor\" or \"cel-shaded, high contrast\"), "
        "then, only if there's something notable beyond style, a short note on "
        "content or a striking detail. Always keep the bookcase itself in view: "
        "the reader should be able to tell this is a shelved library wall, even "
        "when the distinctive elements are elsewhere in the frame. The seed "
        f"keywords for this tile were {', '.join(keywords)} -- they're shown to "
        "the reader elsewhere, so don't restate them as words, just let them "
        "inform what you see.\n\n"
        "If something is genuinely ambiguous or hard to make out, say so rather "
        "than silently picking a reading, and don't invent detail you can't see. "
        "This applies especially to text: if writing in the image isn't clearly "
        "legible as real words, say it's garbled or illegible -- do not transcribe "
        "or invent wording, and do not invent a story or identity for "
        "figures/objects you can't resolve. A confident, specific, wrong "
        "description is worse than an honest, vague one.\n\n"
        "Hard limit of 200 words. That's a budget, not a target -- most tiles are "
        "simple variations and should be far shorter, one or two sentences. Only "
        "spend real length on a tile that actually has enough going on to need "
        "it. Plain, concrete, no evaluative language (\"beautiful,\" "
        "\"stunning\"), no \"image of\" / \"a picture of.\" Reply with the alt "
        "text itself and nothing else: no preamble, no markdown, no quotation "
        "marks."
    )


# ---------------------------------------------------------------------------
# metadata.json load / save
# ---------------------------------------------------------------------------
def index_path(tile_dir: str) -> str:
    return os.path.join(tile_dir, INDEX_JSON)


def load_index(tile_dir: str, strict: bool = False) -> dict:
    """Load ``metadata.json`` from ``tile_dir``.

    Returns {} for an absent file. A malformed file (e.g. a partial read of a
    concurrent write, or genuine corruption) raises ``json.JSONDecodeError``
    when ``strict`` is set, so a caller can tell "no metadata" apart from
    "couldn't read the metadata" and avoid acting on an empty result; the
    default stays tolerant, printing and returning {} for the batch callers
    that just want best-effort.
    """
    path = index_path(tile_dir)
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as file:
        try:
            return json.load(file)
        except json.JSONDecodeError as err:
            if strict:
                raise
            print(f"Failed to load {path}: {err}")
            return {}


def save_index(tile_dir: str, index: dict) -> None:
    """Write ``index`` back to ``metadata.json`` (pretty, UTF-8 preserved).

    The write is atomic: it lands in a temp file in the same directory and is
    then ``os.replace``d over the target, so a concurrent reader (another tool,
    or the GUI's file watcher) always sees either the whole old file or the
    whole new one, never a truncated file mid-write. An in-place ``open(...,
    "w")`` would expose a zero-byte window that reads back as
    ``Expecting value: line 1 column 1``.
    """
    path = index_path(tile_dir)
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".metadata.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(index, file, ensure_ascii=False, indent=2)
            file.flush()
            os.fsync(file.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


@contextlib.contextmanager
def _index_lock(tile_dir: str):
    """Hold an exclusive lock on ``metadata.json.lock`` for the block's duration.

    Only serializes access between cooperating processes that go through this
    lock (i.e. ``update_index`` below) - it doesn't protect ``load_index``/
    ``save_index`` called directly, which is why those two stay as the plain,
    unlocked primitives everything already uses for a single in-memory run.
    """
    lock_path = index_path(tile_dir) + ".lock"
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def update_index(tile_dir: str, mutate_fn: Callable[[dict], dict]) -> dict:
    """Read-modify-write ``metadata.json`` under an exclusive lock.

    Re-reads the file fresh (picking up anything another process just wrote)
    before calling ``mutate_fn(fresh_index) -> fresh_index`` and saving the
    result, so two processes touching the same ``metadata.json`` at once
    (two batch scripts, or a script alongside the GUI) merge rather than
    blindly overwrite each other's unrelated changes. Returns the saved index.
    """
    with _index_lock(tile_dir):
        index = mutate_fn(load_index(tile_dir))
        save_index(tile_dir, index)
        return index


def load_keyword_map(path: str = DEFAULT_KEYWORD_MAP) -> dict:
    with open(path, encoding="utf-8") as file:
        return json.load(file)


# ---------------------------------------------------------------------------
# Keyword extraction / normalization
# ---------------------------------------------------------------------------
def raw_keywords(img_path: str) -> list[str]:
    """Return the comma-separated keywords from a tile's A1111 prompt.

    The generator wraps the three style keywords in the first parenthesised
    group of the prompt, e.g. ``(syrup, engraving, Funk art)``.
    """
    params = get_a1111_params(read_image_metadata(img_path))
    if params is None:
        raise RuntimeError(f"No A1111 metadata in {img_path}")
    prompt = parse_a1111_params(params)[0]
    match = re.search(r"\(([^()]+)\)", prompt)
    if match is None:
        raise RuntimeError(f"No parenthesised keywords in {img_path}")
    return [kw.strip() for kw in match.group(1).split(",") if kw.strip()]


def normalize_keywords(keywords: list[str], keyword_map: dict) -> list[dict]:
    """Map raw keywords to ``{"text", "type"}`` entries via ``keyword_map``.

    Keywords absent from the map are dropped (as in the original importer).
    The category is read from the *original* key; ``text`` uses the ``rename``
    value when one is present.
    """
    result = []
    for kw in keywords:
        entry = keyword_map.get(kw)
        if entry is None:
            continue
        result.append({"text": entry.get("rename", kw), "type": entry["category"]})
    return result


def keyword_texts(meta_entry: dict) -> list[str]:
    """Pull the plain keyword strings out of a metadata entry."""
    return [kw["text"] for kw in meta_entry.get("keywords", [])]


# ---------------------------------------------------------------------------
# Tile ingest (png -> indexed webp)
# ---------------------------------------------------------------------------
def webp_name(i: int) -> str:
    return f"{i:05}.webp"


def next_free_index(tile_dir: str, index: dict, start: int = 0) -> int:
    """First index whose webp name is free in both the index and on disk."""
    i = start
    while webp_name(i) in index or os.path.exists(os.path.join(tile_dir, webp_name(i))):
        i += 1
    return i


def ingest_tiles(tile_dir: str, keyword_map: dict, index: Optional[dict] = None) -> dict:
    """Convert every loose ``.png`` in ``tile_dir`` to an indexed ``.webp``.

    Each png's keywords are extracted and normalized, the image is re-encoded
    as webp under the next free ``NNNNN.webp`` name, and the mapping is added to
    ``index`` (loaded from disk if not supplied). The index is saved after each
    tile so an interruption never loses work. Returns the updated index.
    """
    if index is None:
        index = load_index(tile_dir)

    pngs = sorted(
        os.path.join(tile_dir, f)
        for f in os.listdir(tile_dir)
        if f.lower().endswith(".png")
    )

    idx = 0
    for tile_path in pngs:
        keywords = normalize_keywords(raw_keywords(tile_path), keyword_map)
        idx = next_free_index(tile_dir, index, idx)
        key = webp_name(idx)
        index[key] = {"keywords": keywords}
        with Image.open(tile_path) as img:
            img.save(
                os.path.join(tile_dir, key),
                format="webp",
                quality=WEBP_QUALITY,
                method=WEBP_METHOD,
            )
        copy_metadata(tile_path, os.path.join(tile_dir, key), skip_confirm=True)
        save_index(tile_dir, index)
        print(f"ingested {os.path.basename(tile_path)} -> {key}")
        os.remove(tile_path)
    return index


# ---------------------------------------------------------------------------
# Sample corpus updates (review GUI's --sample-update button)
# ---------------------------------------------------------------------------
def _next_sample_name(sample_dir: str, index: dict, ext: str) -> str:
    """First free zero-padded ``NNN<ext>`` name, matching the corpus's width.

    The sample corpus predates this tool's 5-digit ``NNNNN.webp`` ingest
    naming and uses 3-digit stems (``001.jpg``); a new tile keeps whatever
    width is already there (read from the first numeric stem found) so it
    doesn't stick out, falling back to 3 for an empty corpus.
    """
    width = 3
    stems = {os.path.splitext(name)[0] for name in os.listdir(sample_dir)} if os.path.isdir(
        sample_dir
    ) else set()
    for name in index:
        stem = os.path.splitext(name)[0]
        stems.add(stem)
        if stem.isdigit():
            width = len(stem)
    i = 1
    while True:
        stem = f"{i:0{width}}"
        if stem not in stems:
            return f"{stem}{ext}"
        i += 1


def add_to_sample_corpus(
    src_tile_dir: str, key: str, entry: dict, sample_dir: str = SAMPLE_CORPUS_DIR
) -> str:
    """Copy tile ``key`` and a subset of its metadata into the sample corpus.

    No locking and no pyramid/embedding regeneration -- this is a manual,
    occasional curation action on a small demo corpus, not something run
    concurrently with anything else touching it. Returns the new filename.
    """
    os.makedirs(sample_dir, exist_ok=True)
    index = load_index(sample_dir)
    ext = os.path.splitext(key)[1]
    name = _next_sample_name(sample_dir, index, ext)
    shutil.copyfile(os.path.join(src_tile_dir, key), os.path.join(sample_dir, name))
    index[name] = {field: entry[field] for field in SAMPLE_FIELDS if entry.get(field) is not None}
    save_index(sample_dir, index)
    return name


# ---------------------------------------------------------------------------
# Story generation (Claude)
# ---------------------------------------------------------------------------
def generate_story(webp_path: str, prompt: str, model: str = DEFAULT_MODEL) -> str:
    """Generate a fresh story for a tile from a single prompt."""
    return describe_image(webp_path, prompt, model=model)


def generate_alt_text(webp_path: str, prompt: str, model: str = DEFAULT_MODEL) -> str:
    """Generate accessibility alt text for a tile from a single prompt."""
    return describe_image(webp_path, prompt, model=model)


def revise_story(
    webp_path: str,
    prompt: str,
    story: str,
    revision_request: str,
    model: str = DEFAULT_MODEL,
) -> str:
    """Revise an existing story via a prompt -> story -> revision exchange."""
    return converse_about_image(
        webp_path,
        [("user", prompt), ("assistant", story), ("user", revision_request)],
        model=model,
    )
