"""
Lint rules: plain-text writing rules, each with an optional deterministic
check, derived from collection memory or written by hand.

A rule's ``description`` is an instruction a writer can follow ("Don't use
the name Vane or Vance"). Its ``check`` is data, one of a fixed set of kinds,
so a rule a model wrote can be audited at a glance:

- ``{"kind": "words", "words": [...], "case_sensitive": false}``: fails when
  the story uses any listed word or phrase as a whole word.
- ``{"kind": "regex", "pattern": "...", "ignore_case": false}``: fails when
  the pattern matches anywhere.
- ``{"kind": "opener", "openers": [...]}``: fails when the story's first
  words are one of these.
- ``{"kind": "word_count", "max": N}``: fails over ``N`` words, counted the
  way the engine's validators count them.

A rule with no check is allowed. It reaches the writer's prompt, and the
LLM critique once that exists, but ``lint`` skips it.

``source`` says who owns a rule. ``derive`` (a model reading the memory
report) replaces only ``llm`` rules; a ``hand`` rule stays until the
maintainer removes it. Editing an ``llm`` rule by hand makes it ``hand``.
The descriptions of ``llm`` rules the maintainer removed are kept as
``dismissed`` and shown to the next derivation, so a deleted rule doesn't
come straight back.

Storage is the caller's (``babel_index_review.story_rules``). Nothing here
gives the writer another story's text: the deriving model reads counts and
short fragments from the report, and the writer reads only descriptions.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from functools import lru_cache

from story_engine import llm
from story_engine.llm import ReplyError, require_str
from story_engine.memory import words

CHECK_KINDS = ("words", "regex", "opener", "word_count")
DERIVE_LIMIT = 20  # rules one derivation may return
DESCRIPTION_WORDS = 40


@dataclass
class Rule:
    """One rule. ``check`` is None or a dict ``validate_check`` accepts."""

    id: str
    description: str
    check: dict | None = None
    source: str = "hand"
    model: str = ""
    created: str = ""


@dataclass
class RuleSet:
    rules: list[Rule] = field(default_factory=list)
    dismissed: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {"rules": [asdict(r) for r in self.rules], "dismissed": list(self.dismissed)}

    @classmethod
    def from_json(cls, data: dict) -> "RuleSet":
        return cls(
            rules=[Rule(**r) for r in data.get("rules", [])],
            dismissed=list(data.get("dismissed", [])),
        )

    def hand(self) -> list[Rule]:
        return [r for r in self.rules if r.source == "hand"]

    def with_derived(self, derived: list[Rule]) -> "RuleSet":
        """Every hand rule, then ``derived`` in place of the old ``llm`` rules."""
        return RuleSet(self.hand() + derived, list(self.dismissed))

    def descriptions(self) -> list[str]:
        """Every rule's description, for the writer's prompt."""
        return [r.description for r in self.rules]


@dataclass
class Failure:
    """A failed check: the rule, and what in the story tripped it."""

    rule: Rule
    found: str


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def _str_list(check: dict, key: str) -> list[str]:
    value = check.get(key)
    if not isinstance(value, list) or not value or not all(isinstance(v, str) and v.strip() for v in value):
        raise ValueError(f"{check.get('kind')} check needs a non-empty {key!r} list of strings")
    return [v.strip() for v in value]


def validate_check(check: object) -> dict | None:
    """``check`` cleaned, or ValueError naming what is wrong. None stays None."""
    if check is None:
        return None
    if not isinstance(check, dict):
        raise ValueError("a check is a JSON object or null")
    kind = check.get("kind")
    if kind == "words":
        return {"kind": kind, "words": _str_list(check, "words"), "case_sensitive": bool(check.get("case_sensitive"))}
    if kind == "regex":
        pattern = check.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            raise ValueError("regex check needs a non-empty 'pattern'")
        try:
            re.compile(pattern)
        except re.error as err:
            raise ValueError(f"regex check: {err}") from err
        return {"kind": kind, "pattern": pattern, "ignore_case": bool(check.get("ignore_case"))}
    if kind == "opener":
        openers = [" ".join(words(o)) for o in _str_list(check, "openers")]
        if not all(openers):
            raise ValueError("opener check: every opener needs at least one word")
        return {"kind": kind, "openers": openers}
    if kind == "word_count":
        limit = check.get("max")
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ValueError("word_count check needs a positive integer 'max'")
        return {"kind": kind, "max": limit}
    raise ValueError(f"unknown check kind {kind!r}; expected one of {', '.join(CHECK_KINDS)}")


@lru_cache(maxsize=4096)
def _phrase_re(phrase: str, case_sensitive: bool) -> re.Pattern:
    body = r"\s+".join(re.escape(part) for part in phrase.split())
    return re.compile(rf"(?<![\w']){body}(?![\w'])", 0 if case_sensitive else re.IGNORECASE)


def run_check(check: dict, story: str) -> str | None:
    """What in ``story`` fails ``check``, or None when it passes."""
    kind = check["kind"]
    if kind == "words":
        found = [w for w in check["words"] if _phrase_re(w, check.get("case_sensitive", False)).search(story)]
        return ", ".join(found) or None
    if kind == "regex":
        match = re.search(check["pattern"], story, re.IGNORECASE if check.get("ignore_case") else 0)
        return repr(match.group()) if match else None
    if kind == "opener":
        opening = words(story)
        for opener in check["openers"]:
            tokens = opener.split()
            if opening[: len(tokens)] == tokens:
                return opener
        return None
    if kind == "word_count":
        count = len(story.split())
        return f"{count} words" if count > check["max"] else None
    raise ValueError(f"unknown check kind {kind!r}")


def describe_check(check: dict | None) -> str:
    """A one-line summary of ``check``, for a table or tooltip."""
    if check is None:
        return "no check"
    kind = check["kind"]
    if kind == "words":
        case = ", case-sensitive" if check.get("case_sensitive") else ""
        return f"words{case}: {', '.join(check['words'])}"
    if kind == "regex":
        return f"regex{' (any case)' if check.get('ignore_case') else ''}: {check['pattern']}"
    if kind == "opener":
        return f"opener: {', '.join(check['openers'])}"
    return f"at most {check['max']} words"


def lint(story: str, rules: list[Rule]) -> list[Failure]:
    """Every rule with a check that ``story`` fails, in rule order."""
    failures = []
    for rule in rules:
        if rule.check is not None:
            found = run_check(rule.check, story)
            if found is not None:
                failures.append(Failure(rule, found))
    return failures


def hits(rules: list[Rule], stories: list[str]) -> dict[str, int]:
    """How many of ``stories`` each checked rule fails, by rule id."""
    return {
        rule.id: sum(1 for story in stories if run_check(rule.check, story) is not None)
        for rule in rules
        if rule.check is not None
    }


# ---------------------------------------------------------------------------
# Deriving rules from memory
# ---------------------------------------------------------------------------
_CHECK_SPEC = (
    "A check is null, or one of these JSON objects:\n"
    '- {"kind": "words", "words": ["...", ...], "case_sensitive": false}: fails when a story '
    "uses any listed word or phrase as a whole word. Set case_sensitive for a name that is "
    'also an ordinary word ("Vane", "vane").\n'
    '- {"kind": "opener", "openers": ["...", ...]}: fails when a story opens with one of '
    "these word sequences. Case and punctuation are ignored.\n"
    '- {"kind": "regex", "pattern": "...", "ignore_case": false}: a Python regular '
    "expression that fails a story wherever it matches. Use it only when words or opener "
    "can't express the pattern.\n"
    '- {"kind": "word_count", "max": N}: fails a story over N words.'
)


def derive_prompt(report: str, rules: RuleSet) -> str:
    """The prompt that turns a memory report into rules.

    ``report`` is ``memory.format_report``'s Markdown. The hand rules and the
    dismissed descriptions in ``rules`` are listed so the model neither
    restates nor revives them.
    """
    hand = rules.hand()
    kept = (
        "The editor's own rules, which stay as they are. Don't restate them:\n"
        + "\n".join(f"- {r.description} ({describe_check(r.check)})" for r in hand)
        + "\n\n"
        if hand
        else ""
    )
    dismissed = (
        "Rules the editor has already removed. Don't propose them again, in these or other words:\n"
        + "\n".join(f"- {d}" for d in rules.dismissed)
        + "\n\n"
        if rules.dismissed
        else ""
    )
    return (
        "You help an editor keep a growing collection of very short stories varied. "
        "Each new story is drafted by a model that never reads the collection, so it "
        "falls back on the same habits: the same stock phrases, openers, names and "
        "devices, story after story. Below is a report counting the patterns the "
        "collection's accepted stories share. Turn it into lint rules for new drafts.\n\n"
        f"<report>\n{report.strip()}\n</report>\n\n"
        "Each rule has:\n"
        '- "description": one short instruction, given word for word to the writer of '
        "every new draft. Name a phrase in a few words at most and never quote a "
        "passage: an example vivid enough to picture is an example a writer copies.\n"
        '- "check": a deterministic test for the rule, or null when no simple test '
        "fits. A rule with no check still reaches the writer.\n\n"
        f"{_CHECK_SPEC}\n\n"
        "What earns a rule:\n"
        "- A phrase, opener or construction whose count shows a habit, not ordinary "
        "English. Compare it with the number of stories: a phrase in a tenth of them "
        "is a tic, and a common turn of phrase in a few is not.\n"
        "- A character name that recurs across unrelated stories, or a pair of names "
        "one letter apart. The names list is found by capitalization, so it also holds "
        "institutions, places, months and titles: ban only names a writer reaches for "
        "by reflex.\n"
        "- A device or trope that a large share of the collection runs on. Phrase it "
        "as asking for a different angle when the device appears, not a ban on a "
        "genre, and give it no check.\n"
        "- One rule per pattern family: list a phrase's variants in one check.\n\n"
        "Keep the list short, at most "
        f"{DERIVE_LIMIT} rules, strongest patterns first. Every rule costs the writer "
        "attention, and a check that fails most good drafts is noise.\n\n"
        + kept
        + dismissed
        + 'Reply with only a JSON object: {"rules": [{"description": "...", "check": {...} or null}, ...]}'
    )


def _derive_validator(data: object) -> list[tuple[str, dict | None]]:
    if not isinstance(data, dict) or not isinstance(data.get("rules"), list):
        raise ReplyError('expected a JSON object with a "rules" list')
    if len(data["rules"]) > DERIVE_LIMIT:
        raise ReplyError(f"{len(data['rules'])} rules, over the limit of {DERIVE_LIMIT}")
    out = []
    problems = []
    for i, item in enumerate(data["rules"]):
        where = f"rules[{i}]"
        if not isinstance(item, dict):
            raise ReplyError(f"{where} must be an object")
        description = require_str(item, "description", where)
        if len(description.split()) > DESCRIPTION_WORDS:
            problems.append(f"{where}.description has {len(description.split())} words, over {DESCRIPTION_WORDS}")
        try:
            check = validate_check(item.get("check"))
        except ValueError as err:
            problems.append(f"{where}.check: {err}")
            continue
        out.append((description, check))
    if problems:
        raise ReplyError("; ".join(problems))
    return out


def parse_derived(data: object) -> list[tuple[str, dict | None]]:
    """A derivation reply, already parsed from JSON, as ``(description, check)`` pairs.

    Raises ``ReplyError``. For a reply that came from outside ``derive``,
    such as a Claude Code session given ``derive_prompt``.
    """
    return _derive_validator(data)


def derive(report: str, rules: RuleSet, model: str) -> list[tuple[str, dict | None]]:
    """``(description, check)`` pairs for the ``llm`` rules. Blocks on the network."""
    pairs, _raws = llm.ask_json(None, derive_prompt(report, rules), model, _derive_validator, retries=2)
    return pairs
