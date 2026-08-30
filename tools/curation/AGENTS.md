# tools/curation

Notes for coding agents working in this subtree. Human-facing usage docs are
in [`README.md`](README.md). This directory's `CLAUDE.md` is a symlink to
this file, same convention as the repo root.

## What this is

Python/Qt tooling for curating a batch of generated tile images into the
`metadata.json` sidecar this project's corpus format expects: keyword
extraction from A1111 prompt metadata, story generation/review (desktop Qt app
and a mobile web fallback), alt text, sensitive-content tagging, and title
generation. Nothing here is imported by `packages/` - it produces the input
a corpus directory needs, it doesn't run alongside the app.

Migrated without any history from a personal scripts directory that also held
a lot of unrelated tools; only the files this subtree actually uses came
along.

## Layout

- `babel_index_review/`: the package. `core.py` is the shared logic (on-disk
  layout, keyword normalization, story prompt, Claude calls) that everything
  else builds on; the rest are entry points - see `README.md` for what each
  does and how to run it. `gui.py` + `__main__.py` are the desktop Qt review
  app; `mobile_app.py` is the LAN-servable alternative.
- `tag/describe_image.py`: model dispatch (Claude / OpenRouter / local
  OpenAI-compatible server) shared by every tool that calls a vision or text
  model. Not curation-specific; if this repo ever needs a second Python tool
  that talks to a model, this is what it should share too.
- `lib/image_metadata.py`, `util/metadata.py`: image metadata (A1111 params,
  EXIF/IPTC/XMP/PNG-text) read/write, and a standalone CLI over it.
- `data/`: `all_styles.txt` (a wildcard-file keyword source snapshot) and
  `keyword_map.json` (the categorized/rename result of a prior pass over it) -
  bundled so the tools don't reach outside this repo for their input data.
  `banned_emdash_tokens.json` is a Gemma3 tokenizer logit-bias list consumed
  by `tag/describe_image.py`'s local-server path.
- `requirements.txt`: trimmed to the packages this subtree actually imports
  (`Flask`, `Pillow`, `PySide6`, `anthropic`, `pyexiv2`, `requests`) - not
  copied from the source repo's much larger one.

## Conventions

- This is a separate ecosystem from the rest of the repo: plain Python 3,
  `pip install -r tools/curation/requirements.txt`, no npm/esbuild/TypeScript
  involved and no CI wiring. Nothing under `packages/` imports anything here.
- Every tool is run as `python -m babel_index_review.<name>` (or
  `python -m babel_index_review` for the GUI) from `tools/curation/` - that's
  what makes the bare `tag`/`lib`/`babel_index_review` imports resolve, and
  it's why a relative default like `keyword_map.json` or `data/keyword_map.json`
  means "relative to wherever you launched the command," not relative to the
  tile directory (`-d DIR`) being operated on.
- Model calls all route through `tag/describe_image.py`'s prefix convention
  (`local:`, `openrouter:`, bare Claude id) - see `README.md`'s Setup section
  for the env vars each backend reads. Don't add a second way to pick a model.
- No tests here (migrated as-is; the source repo didn't have any for this
  subtree either). If you add real logic - not just another thin CLI over
  `core.py` - consider whether it's worth a `node:test`-free `pytest`/`unittest`
  file rather than leaving it unverified.

## Things that will bite you

- **`keyword_map.py`'s source path used to be a hardcoded absolute path** into
  a sibling Stable Diffusion install on the original machine. It now defaults
  to the bundled `data/all_styles.txt` snapshot; override with
  `BABEL_KEYWORD_SOURCE` to point it at a live wildcard file instead of the
  snapshot when re-syncing.
- **`onnxruntime`/CLIP-embedding concerns from the rest of this repo don't
  apply here** - this subtree never touches `packages/`'s optional
  `@huggingface/transformers` dependency; it's a fully separate curation step
  that runs before a corpus exists, not part of serving one.
- **The desktop GUI (`babel_index_review.gui`) needs a real display** (Qt);
  it can't be smoke-tested headlessly the way the rest of this repo's e2e
  suite runs in CI. `mobile_app.py` is the one piece here servable/testable
  over plain HTTP.
