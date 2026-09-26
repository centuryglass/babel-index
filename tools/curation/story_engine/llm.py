"""
Structured model calls: ask for JSON, parse it, check its shape, retry once.

Calls route through ``tag.describe_image`` so every backend prefix works.
There is no provider-side JSON mode across those backends, so the reply is
parsed from text: a fenced block if present, else the outermost braces.
"""

from __future__ import annotations

import json
import re
from typing import Callable

from tag.describe_image import converse_about_image, converse_text

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


class ReplyError(ValueError):
    """The model's reply could not be parsed or failed validation."""


def parse_json(text: str) -> object:
    match = _FENCE_RE.search(text)
    body = match.group(1) if match else text
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end < start:
        raise ReplyError("no JSON object in the reply")
    try:
        return json.loads(body[start : end + 1])
    except json.JSONDecodeError as err:
        raise ReplyError(f"invalid JSON: {err}") from err


def ask(image: str | None, turns: list[tuple[str, str]], model: str) -> str:
    """One model call, with the image attached to the first user turn if given."""
    if image is None:
        return converse_text(turns, model=model)
    return converse_about_image(image, turns, model=model)


def ask_json(
    image: str | None,
    prompt: str,
    model: str,
    validate: Callable[[object], object],
    retries: int = 1,
) -> tuple[object, list[str]]:
    """Ask for JSON and return ``(validate(parsed), raw_replies)``.

    ``validate`` returns the cleaned value or raises ``ReplyError``. On a
    failure the error is sent back to the model in a follow-up turn, up to
    ``retries`` times, and the last error is raised. ``raw_replies`` holds
    every reply, for the trace.
    """
    turns = [("user", prompt)]
    raws: list[str] = []
    while True:
        raw = ask(image, turns, model)
        raws.append(raw)
        try:
            return validate(parse_json(raw)), raws
        except ReplyError as err:
            if len(raws) > retries:
                raise ReplyError(f"{err} (after {len(raws)} attempts)") from err
            turns += [
                ("assistant", raw),
                ("user", f"That reply could not be used: {err}. Reply again with only the corrected JSON object."),
            ]


def require_str(obj: dict, key: str, where: str) -> str:
    """``obj[key]`` as a stripped non-empty string, else ``ReplyError``."""
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ReplyError(f"{where}: {key!r} must be a non-empty string")
    return value.strip()


def require_str_list(obj: dict, key: str, where: str, allow_empty: bool = True) -> list[str]:
    value = obj.get(key)
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ReplyError(f"{where}: {key!r} must be a list of strings")
    cleaned = [v.strip() for v in value if v.strip()]
    if not cleaned and not allow_empty:
        raise ReplyError(f"{where}: {key!r} must not be empty")
    return cleaned
