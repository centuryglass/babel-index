# Curation tools

Python/Qt tools for turning a batch of generated tile images into the
`metadata.json` this project's corpus format expects: keyword extraction,
story generation and review, alt text, title generation, and sensitive-content
tagging. These are offline curation tools that run against a working tile
directory before it becomes (or updates) a corpus under `--images`/`assets/` -
nothing here is imported by `packages/`.

Migrated from a personal scripts repo; see `AGENTS.md` in this directory for
the coding-agent-facing notes (layout, conventions, gotchas).

## Setup

```sh
pip install -r tools/curation/requirements.txt
```

Vision/text model calls go through `tag/describe_image.py`, which picks a
backend from the model id's prefix:

- A bare Claude model id (e.g. `claude-opus-4-1`). Reads `ANTHROPIC_API_KEY`
  from the environment.
- `openrouter:<provider/model>` - OpenAI-compatible chat completions via
  OpenRouter. Reads `OPENROUTER_API_KEY`. Every batch tool's default model
  (`tag.describe_image.DEFAULT_MODEL`, currently
  `openrouter:~google/gemini-flash-latest`) uses this path.
- `local:<model>` (or bare `local:` to let a single-model server pick) - an
  OpenAI-compatible local server, e.g. `llama.cpp`'s `llama-server`, at
  `http://localhost:9931/v1` by default (override with `BABEL_LOCAL_API_BASE`).
  Pass `--model local:...` to any tool to use this instead of the default.

The GUI's model dropdown shows a per-million-token price in parentheses after
each label. OpenRouter's prices come live from its `/models` endpoint.
Claude's do not - Anthropic's Models API has no pricing field, so
`tag/describe_image.py`'s `CLAUDE_PRICING` is a hand-maintained snapshot of
[platform.claude.com/docs/en/pricing](https://platform.claude.com/docs/en/pricing)
and may be out of date; treat it as approximate and check the pricing page for
the current numbers.

Everything below is run as `python -m babel_index_review.<tool>` from
`tools/curation/`, against a tile directory `DIR` holding `NNNNN.webp` files
plus a `metadata.json` sidecar (see `babel_index_review/core.py`'s module
docstring for the exact schema). `DIR` is always the first positional
argument, never a flag.

## The tools

**Import a batch**

```sh
python -m babel_index_review.tile_process DIR [--map MAP] [--generate-stories] [--workers N]
```

Ingests every loose `.png` in `DIR`: extracts keywords from the A1111 prompt
metadata (normalized via a keyword map JSON - defaults to the bundled
`data/keyword_map.json`; pass `--map` to use a different one), re-encodes
each as `NNNNN.webp` under the next free index, and records the mapping in
`metadata.json`. `--generate-stories` additionally asks the model for a
story on every tile that still lacks one, `--workers N` many at a time
(default 6; see "Parallel requests" below).

**Review and revise stories (desktop)**

```sh
python -m babel_index_review DIR [--content-review flagged|unflagged]
```

The full Qt review GUI: browse tiles in a grid, generate/revise/finalize
stories, generate alt text, and set sensitive-content tags by hand. See
`babel_index_review/gui.py`'s module docstring for the panel layout.

**Review from a phone**

```sh
python -m babel_index_review.mobile_app DIR [--host 0.0.0.0] [--port 8000]
```

A minimal mobile-friendly web GUI over the same `metadata.json` - paging,
autosaving story edits, generate/clear/mark-final - for reviewing on a LAN
device without the desktop app. No model picker; always uses
`tag.describe_image.DEFAULT_MODEL`.

**Alt text**

```sh
python -m babel_index_review.alt_text DIR [--model MODEL] [--force] [--limit N] [--workers N]
```

Generates accessibility alt text from the image + seed keywords (not the
story, to avoid describing the same tile twice for a screen reader).

**Sensitive-content tagging**

```sh
python -m babel_index_review.sensitive_tags DIR [--model MODEL] [--all] [--retag] [--workers N]
```

Asks a local vision model which tags from `core.SENSITIVE_TAGS` apply, if any,
retrying until the reply is a valid JSON array drawn only from that list.

**Titles**

```sh
python -m babel_index_review.titles DIR [--model MODEL] [--all] [--workers N]
```

Generates a short, unique title per finalized tile from its image + story
(never the seed keywords), writing each into `metadata.json`'s `title` field
as it goes. Also editable directly in the review GUI. Uniqueness holds even
with `--workers` above 1: a title claimed by one in-flight tile is
immediately unavailable to every other, so two tiles can never land on the
same title.

**Parallel requests**

`tile_process.py --generate-stories`, `alt_text.py`, `sensitive_tags.py`, and
`titles.py` all accept `--workers N` (default 6), running up to `N` model
calls at once instead of one at a time - a real speedup against a remote
model (`openrouter:...`, a bare Claude id), since each call spends most of
its time waiting on the network. A `local:` model is always forced to 1
regardless of `--workers`, since a single-model `llama-server` can't usefully
serve concurrent requests. Every tile's result is still written to
`metadata.json` one at a time by a single thread as it completes, so an
interrupted run (Ctrl+C included) loses nothing beyond whatever was still
in flight at that moment - same guarantee as the old serial loop, just
faster. `metadata.json` reads and writes are also now safe across
*processes*: running two of these tools (or one alongside the GUI) against
the same `DIR` at once no longer risks one process's save silently
overwriting another's.

**Story generation via Claude Code subagents (no API billing)**

```sh
python -m babel_index_review.subagent_stories DIR worklist [--limit N] [--out worklist.json]
# ... run inside a Claude Code session: spawn one subagent per tile, each
# reading the image and returning a story, collected into {key: story} ...
python -m babel_index_review.subagent_stories DIR apply --results results.json
```

An alternative to `tile_process.py --generate-stories` that costs nothing
beyond a Claude Code subscription instead of billing the Anthropic API
directly. See `babel_index_review/subagent_stories.py`'s module docstring for
the split between what this script does and what the Claude Code session
orchestrating it must do.

**Keyword categorization**

```sh
python -m babel_index_review.keyword_map
```

Interactive terminal prompt: walks `data/all_styles.txt` (a wildcard-file
snapshot; override the source with `BABEL_KEYWORD_SOURCE`) one keyword at a
time, categorizing or renaming each into the bundled `data/keyword_map.json`
- already the categorized result of a prior pass over ~2200 keywords, so
most of what you'd run this against has already been done and this only
prompts for what's new.

**Metadata inspection (standalone, no tile dir needed)**

```sh
python util/metadata.py img.png                    # pretty-print
python util/metadata.py img.png -out img.json       # dump to JSON
python util/metadata.py -formats                    # what's readable/writable
python util/metadata.py -update in_file out_file     # transplant metadata
```

A thin CLI over `lib/image_metadata.py`, useful for debugging what a tile's
A1111/EXIF/IPTC/XMP metadata actually contains independent of the rest of
this pipeline.
