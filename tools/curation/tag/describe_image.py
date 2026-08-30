#!/usr/bin/env python3
"""
Send an image (plus a prompt or a short conversation) to a vision-capable LLM
and get text back.

Entry points:
  - describe_image(image, prompt) -- one image, one prompt, one reply.
  - converse_about_image(image, turns) -- one image attached to a multi-turn
    conversation (initial prompt -> reply -> revision request -> ...), used for
    the babel-index story revision flow.
  - send_text(prompt) -- no image, plain text in, text out.

Both talk to Claude by default, while model ids prefixed with ``local:`` or
``openrouter:`` are routed instead to OpenAI-compatible servers (e.g. a llama.cpp
``llama-server`` hosting a local vision model). This lets the review GUI's model
dropdown offer a free, offline option alongside the Claude models. See
``LOCAL_API_BASE`` (override with ``BABEL_LOCAL_API_BASE``).

Behavior when this file is run directly (`python describe_image.py ...`):
  - If --out PATH is given, the response is written to that file.
  - Otherwise, the response is printed to stdout.

When imported, none of the CLI/stdout/file-writing behavior kicks in -- you
just get the return value.
"""

import argparse
import base64
import io
import json
import mimetypes
import os
import sys
from pathlib import Path
from typing import Sequence, Tuple

import anthropic
import requests

# Image formats the local OpenAI-compatible server (llama.cpp's stb_image
# decoder) can read. Anything else — notably webp, which the babel-index tiles
# use — is silently dropped by the server, so the local path transcodes it to
# PNG. Claude accepts webp natively and is unaffected.
_LOCAL_DECODABLE = {"image/png", "image/jpeg", "image/bmp", "image/gif"}

# OpenRouter uses the OpenAI chat-completions API. Model ids are stored as
# ``openrouter:<provider/model>`` so they are unambiguous in the GUI.
OPENROUTER_PREFIX = "openrouter:"
OPENROUTER_API_BASE = os.environ.get(
    "BABEL_OPENROUTER_API_BASE", "https://openrouter.ai/api/v1"
)
OPENROUTER_TIMEOUT = 300

# gemini-flash-latest is the default: it does an excellent job on the
# babel-index story prompt at a very low price. The others are here so callers
# (e.g. the review GUI's model dropdown can experiment. All are
# vision-capable. Keyed by the label shown in the UI.This static list is the
# fallback for `available_models()` when the live Models API query can't run
# (no network, no API key, older SDK, ...).
DEFAULT_MODEL = OPENROUTER_PREFIX + "~google/gemini-flash-latest"
MODEL = DEFAULT_MODEL  # kept for backwards compatibility
CLAUDE_MODELS = {
    "Sonnet 5": "claude-sonnet-5",
    "Opus 5": "claude-opus-5",
    "Opus 4.8": "claude-opus-4-8",
    "Haiku 4.5": "claude-haiku-4-5",
    "Fable 5": "claude-fable-5",
}

# Hand-maintained Claude API prices, in dollars per million tokens (input,
# output). Anthropic's Models API doesn't expose pricing, so there's no way to
# fetch this live -- it's a snapshot of https://platform.claude.com/docs/en/pricing
# and may go stale as prices change. See README's Setup section for the caveat.
CLAUDE_PRICING = {
    "claude-fable-5": (10.00, 50.00),
    "claude-opus-4-8": (5.00, 25.00),
    "claude-sonnet-5": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
}


def _price_suffix(input_per_mtok: float, output_per_mtok: float) -> str:
    def fmt(price: float) -> str:
        return f"{price:g}"

    return f" (${fmt(input_per_mtok)}/${fmt(output_per_mtok)} per 1M tok)"


# Prefix on every Anthropic API label in the dropdown, so it isn't confused
# with an OpenRouter entry for the same underlying Claude model.
ANTHROPIC_LABEL_PREFIX = "Anthropic API: "


def _with_claude_price(label: str, model_id: str) -> str:
    price = CLAUDE_PRICING.get(model_id)
    if price is None:
        return label
    return label + _price_suffix(*price)


def _priced_claude_models(models: dict) -> dict:
    """Re-key a {label: model_id} dict with the Anthropic prefix and a price suffix."""
    return {
        _with_claude_price(ANTHROPIC_LABEL_PREFIX + label, model_id): model_id
        for label, model_id in models.items()
    }


# Fallback used when the OpenRouter Models API cannot be queried. Lists
# DEFAULT_MODEL itself first so it's always a real entry in the dropdown -
# not just the id _set_models tries to preselect - even before any live
# query has run.
STATIC_OPENROUTER_MODELS = {
    "OpenRouter / Gemini Flash (default)": DEFAULT_MODEL,
    "OpenRouter / Claude Sonnet 4": OPENROUTER_PREFIX + "anthropic/claude-sonnet-4",
    "OpenRouter / Gemini 2.5 Flash": OPENROUTER_PREFIX + "google/gemini-2.5-flash",
}

MAX_TOKENS = 4096

# Local OpenAI-compatible server (llama.cpp / vLLM / LM Studio / Ollama). Model
# ids for it are stored as ``local:<served-model-id>``; an empty tail (just
# ``local:``) lets a single-model llama-server pick whatever it has loaded.
LOCAL_PREFIX = "local:"
LOCAL_API_BASE = os.environ.get("BABEL_LOCAL_API_BASE", "http://localhost:9931/v1")
LOCAL_TIMEOUT = 300  # seconds; small quantized models on CPU can be slow

# Placeholder shown in the dropdown before/without a live query of the local
# server. `available_models()` replaces it with the real served id when reachable.
STATIC_LOCAL_MODELS = {"Local model": LOCAL_PREFIX}

# Token ids (Gemma3 tokenizer) covering the obvious em-dash spellings -- bare,
# space-prefixed, doubled/tripled, fused with adjacent punctuation -- found by
# probing the local server's /tokenize. Not an exhaustive vocab scan; applied
# as a hard ban (logit_bias -100) on every local-server call, since the story
# prompt's em-dash prohibition is otherwise routinely ignored.
_BANNED_EMDASH_TOKENS_PATH = os.path.join("data", "banned_emdash_tokens.json")


def _load_emdash_logit_bias(path: str = _BANNED_EMDASH_TOKENS_PATH) -> dict:
    try:
        with open(path, encoding="utf-8") as file:
            ids = json.load(file)
    except (OSError, json.JSONDecodeError):
        return {}
    return {token_id: -100 for token_id in ids if not token_id.startswith("_")}


_EMDASH_LOGIT_BIAS = _load_emdash_logit_bias()

# Kept for backwards compatibility: the full static fallback list (Claude +
# local placeholder) that the GUI seeds its dropdown with before refreshing.
MODELS = {
    **_priced_claude_models(CLAUDE_MODELS),
    **STATIC_LOCAL_MODELS,
    **STATIC_OPENROUTER_MODELS,
}


def _claude_models() -> dict:
    """Query the API for vision-capable Claude models as {label: model_id}.

    Since the story prompt attaches an image, only models that support image
    input are useful here; models whose capabilities report no vision are
    dropped. Any failure (no network, no key, or an SDK too old to report
    capabilities) falls back to the static `CLAUDE_MODELS` list.
    """
    try:
        client = anthropic.Anthropic()
        models = {}
        for model in client.models.list():
            caps = getattr(model, "capabilities", None)
            if caps is not None:
                try:
                    if not caps["image_input"]["supported"]:
                        continue
                except (KeyError, TypeError):
                    pass  # capabilities present but no vision info -> keep it
            label = getattr(model, "display_name", None) or model.id
            models[_with_claude_price(ANTHROPIC_LABEL_PREFIX + label, model.id)] = model.id
        return models or _priced_claude_models(CLAUDE_MODELS)
    except Exception:
        return _priced_claude_models(CLAUDE_MODELS)


def _local_label(model_id: str) -> str:
    """Turn a served model id (often a gguf path) into a friendly dropdown label."""
    name = os.path.basename(model_id) or model_id
    if name.lower().endswith(".gguf"):
        name = name[: -len(".gguf")]
    return f"{name} (local)"


def _openrouter_label(model: dict) -> str:
    """Build a friendly label for an OpenRouter model catalog entry, with price."""
    label = model.get("name") or model.get("id", "unknown")
    pricing = model.get("pricing") or {}
    try:
        prompt_price = float(pricing["prompt"]) * 1_000_000
        completion_price = float(pricing["completion"]) * 1_000_000
    except (KeyError, TypeError, ValueError):
        return label
    return label + _price_suffix(prompt_price, completion_price)


def openrouter_models(
    base: str = OPENROUTER_API_BASE, timeout: float = 5
) -> dict:
    """Query OpenRouter for vision-capable models as {label: 'openrouter:<id>'}.

    Returns {} if the API is unavailable or the key is missing, so callers can
    fall back to the static placeholder models.
    """
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        return {}

    try:
        resp = requests.get(
            f"{base}/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
        )
        resp.raise_for_status()
        entries = resp.json().get("data", [])
        out = {}
        for entry in entries:
            model_id = entry.get("id")
            input_modalities = entry.get("architecture", {}).get(
                "input_modalities", []
            )
            if model_id and "image" in input_modalities:
                out[_openrouter_label(entry)] = OPENROUTER_PREFIX + model_id
        return out
    except Exception:
        return {}


def local_models(base: str = LOCAL_API_BASE, timeout: float = 3) -> dict:
    """Query the local server's ``/models`` for {label: 'local:<id>'} entries.

    Returns {} if the server is unreachable, so callers can fall back to the
    static placeholder (or simply omit the local option).
    """
    try:
        resp = requests.get(f"{base}/models", timeout=timeout)
        resp.raise_for_status()
        entries = resp.json().get("data", [])
        out = {}
        for entry in entries:
            model_id = entry.get("id")
            if model_id:
                out[_local_label(model_id)] = LOCAL_PREFIX + model_id
        return out
    except Exception:
        return {}


def available_models() -> dict:
    """All selectable models as {label: model_id}: live Claude + live local.

    Falls back to static lists per-source so a failure on one side (no API key,
    or the local server being down) never hides the other.
    """
    return {
        **_claude_models(),
        **(local_models() or dict(STATIC_LOCAL_MODELS)),
        **(
            openrouter_models()
            or dict(STATIC_OPENROUTER_MODELS)
        ),
    }


def _image_block(image_path: str) -> dict:
    """Build a base64 image content block for the messages API."""
    path = Path(image_path)
    media_type = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    image_data = base64.standard_b64encode(path.read_bytes()).decode("utf-8")
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": image_data},
    }


def _send(messages: list, model: str = DEFAULT_MODEL) -> str:
    """Send prepared messages to the model and return the concatenated text.

    Messages are built in Anthropic content-block form; a ``local:`` model id is
    routed to the OpenAI-compatible local server instead of the Claude API.
    """
    if model.startswith(LOCAL_PREFIX):
        return _send_local(messages, model[len(LOCAL_PREFIX):])
    if model.startswith(OPENROUTER_PREFIX):
        return _send_openrouter(messages, model[len(OPENROUTER_PREFIX):])
    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
    message = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        messages=messages,
    )
    return "".join(block.text for block in message.content if block.type == "text")


def _local_image_data(media_type: str, data: str) -> tuple[str, str]:
    """Return (media_type, base64) the local server can decode, transcoding if not.

    The local decoder can't read webp (etc.), so re-encode such images to PNG.
    """
    if media_type in _LOCAL_DECODABLE:
        return media_type, data
    from PIL import Image  # local import: only needed for the transcode path

    img = Image.open(io.BytesIO(base64.standard_b64decode(data))).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "image/png", base64.standard_b64encode(buf.getvalue()).decode("utf-8")


def _to_openai_content(block: dict) -> dict:
    """Convert one Anthropic content block to its OpenAI chat-completions form."""
    if block["type"] == "image":
        src = block["source"]
        media_type, data = _local_image_data(src["media_type"], src["data"])
        url = f"data:{media_type};base64,{data}"
        return {"type": "image_url", "image_url": {"url": url}}
    return {"type": "text", "text": block["text"]}


def _send_openrouter(
    messages: list,
    model: str,
    base: str = OPENROUTER_API_BASE,
) -> str:
    """Send messages to OpenRouter's OpenAI-compatible chat API."""
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENROUTER_API_KEY is not set; cannot use an OpenRouter model"
        )

    payload = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": [
            {
                "role": m["role"],
                "content": [_to_openai_content(b) for b in m["content"]],
            }
            for m in messages
        ],
    }
    resp = requests.post(
        f"{base}/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=OPENROUTER_TIMEOUT,
    )
    resp.raise_for_status()
    choice = resp.json()["choices"][0]
    content = (choice["message"].get("content") or "").strip()
    if not content:
        reason = choice.get("finish_reason")
        raise RuntimeError(
            f"OpenRouter returned no content (finish_reason={reason})"
        )
    return content


def _send_local(messages: list, model: str, base: str = LOCAL_API_BASE) -> str:
    """Send messages to a local OpenAI-compatible server and return the text.

    ``model`` may be empty, in which case a single-model llama-server uses
    whatever it has loaded.
    """
    payload = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": [
            {"role": m["role"], "content": [_to_openai_content(b) for b in m["content"]]}
            for m in messages
        ],
    }
    if _EMDASH_LOGIT_BIAS:
        payload["logit_bias"] = _EMDASH_LOGIT_BIAS
    resp = requests.post(
        f"{base}/chat/completions", json=payload, timeout=LOCAL_TIMEOUT
    )
    resp.raise_for_status()
    choice = resp.json()["choices"][0]
    content = (choice["message"].get("content") or "").strip()
    if not content:
        # A reasoning model can burn the whole token budget inside its
        # <think> channel and emit no answer (finish_reason "length"), or
        # leave the answer stranded in reasoning_content. Either way the
        # visible content is empty; surface it instead of returning "".
        reason = choice.get("finish_reason")
        reasoning = choice["message"].get("reasoning_content") or ""
        detail = f"finish_reason={reason}"
        if reason == "length":
            detail += (
                f"; the model used its entire {MAX_TOKENS}-token budget"
                f" ({len(reasoning)} chars of hidden reasoning) without"
                " producing an answer. Disable reasoning or raise the budget."
            )
        elif reasoning:
            detail += f"; the answer may be stuck in a {len(reasoning)}-char reasoning block"
        raise RuntimeError(f"local model returned no content ({detail})")
    return content


def send_text(prompt: str, model: str = DEFAULT_MODEL) -> str:
    """Send a plain text prompt (no image) and return the model's reply."""
    return _send([{"role": "user", "content": [{"type": "text", "text": prompt}]}], model=model)


def describe_image(
    image_path: str,
    prompt: str = "Describe this image in one paragraph.",
    model: str = DEFAULT_MODEL,
) -> str:
    """
    Send `image_path` and `prompt` to `model` and return the model's text
    response as a string. Defaults to Claude Sonnet 5.
    """
    return converse_about_image(image_path, [("user", prompt)], model=model)


def converse_about_image(
    image_path: str,
    turns: Sequence[Tuple[str, str]],
    model: str = DEFAULT_MODEL,
) -> str:
    """
    Continue a conversation about a single image and return Claude's next reply.

    `turns` is a sequence of (role, text) pairs, where role is "user" or
    "assistant". The image is attached to the first user turn. The final turn
    must be a user turn (Claude replies to it). This lets callers replay an
    initial prompt -> prior reply -> revision request exchange in one shot.
    """
    if not turns:
        raise ValueError("converse_about_image requires at least one turn")

    messages = []
    image_attached = False
    for role, text in turns:
        content = [{"type": "text", "text": text}]
        if role == "user" and not image_attached:
            content.insert(0, _image_block(image_path))
            image_attached = True
        messages.append({"role": role, "content": content})
    return _send(messages, model=model)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Describe an image using Claude Sonnet 5.")
    parser.add_argument("image", help="Path to the image file.")
    parser.add_argument(
        "-p",
        "--prompt",
        default="Describe this image in one paragraph.",
        help="Prompt to send along with the image.",
    )
    parser.add_argument(
        "-o",
        "--out",
        default=None,
        help="If given, write the response to this file instead of printing it.",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    result = describe_image(args.image, args.prompt)

    if args.out:
        Path(args.out).write_text(result, encoding="utf-8")
        print(f"Wrote response to {args.out}", file=sys.stderr)
    else:
        print(result)


if __name__ == "__main__":
    main()
