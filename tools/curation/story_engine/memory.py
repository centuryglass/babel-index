"""
Collection memory: what the accepted stories have in common, for spotting
patterns the collection repeats.

Two parts, both free of storage:

- ``tag_story`` asks a model for a story's tropes and payload. It is given
  the trope labels already in use, so labels recur across the collection and
  can be counted, but never another story's text.
- ``analyze`` counts patterns over every remembered story: tropes, seeds,
  forms and constraints, repeated openers, n-grams shared between stories,
  and names reused or near-duplicated.

The caller keeps the entries (``babel_index_review.collection_memory``).
Nothing here is shown to the writer: ``engine.py``'s principle that the
writer never reads past stories holds for memory too. Lint rules derived
from memory are #414's next step.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from story_engine import llm
from story_engine.llm import ReplyError, require_str, require_str_list

TROPE_LIMIT = 4
TROPE_WORDS = 5
PAYLOAD_WORDS = 25


@dataclass
class MemoryEntry:
    """One accepted story as memory holds it.

    ``seed``, ``form`` and ``constraint`` come from the draft the story was
    chosen from, and are None for a story the engine didn't write.
    ``story`` is the text that was tagged; a story whose current text
    differs is stale and gets re-tagged.
    """

    story: str
    tropes: list[str]
    payload: str
    seed: str | None = None
    form: str | None = None
    constraint: str | None = None
    model: str = ""
    tagged: str = ""


@dataclass
class Report:
    """``analyze``'s counts. Each list is ``(item, count)``, most frequent first."""

    stories: int
    tropes: list[tuple[str, int]]
    seeds: list[tuple[str, int]]
    forms: list[tuple[str, int]]
    constraints: list[tuple[str, int]]
    openers: list[tuple[str, int]]
    ngrams: list[tuple[str, int]]
    names: list[tuple[str, int]]
    similar_names: list[tuple[str, str]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Tagging
# ---------------------------------------------------------------------------
def tag_prompt(story: str, known_tropes: list[str]) -> str:
    known = (
        "Trope labels already used for other stories in the collection. Reuse "
        "one wherever it fits, so stories that share a device share a label; "
        "add a new label only for a device none of them names:\n"
        + "\n".join(f"- {trope}" for trope in known_tropes)
        + "\n\n"
        if known_tropes
        else ""
    )
    return (
        "You are cataloguing very short stories in a collection, to find the "
        "devices and shapes it leans on too often. Here is one story:\n\n"
        f"<story>\n{story.strip()}\n</story>\n\n"
        "Tag it:\n"
        f'- "tropes": 1 to {TROPE_LIMIT} labels for the recognizable storytelling '
        "devices it runs on: the premise type, the kind of turn, the narrative "
        "stance, a stock character. Name each the way you'd name it in a list "
        "of tropes, generically, so another story using the same device would "
        f'get the same label ("bureaucratic absurdity", "rule with a hidden '
        f'cost", "letter of complaint"). Lowercase, at most {TROPE_WORDS} words '
        "each. Don't use names or details unique to this story.\n"
        f'- "payload": in one sentence of at most {PAYLOAD_WORDS} words, what a '
        "reader takes away from it: the joke, the turn, the image, the idea or "
        "the feeling the story exists to deliver.\n\n"
        + known
        + 'Reply with only a JSON object: {"tropes": [...], "payload": "..."}'
    )


def _tag_validator(data: object) -> tuple[list[str], str]:
    if not isinstance(data, dict):
        raise ReplyError("expected a JSON object")
    tropes = [t.casefold() for t in require_str_list(data, "tropes", "reply", allow_empty=False)]
    if len(tropes) > TROPE_LIMIT:
        raise ReplyError(f"{len(tropes)} tropes, over the limit of {TROPE_LIMIT}")
    long = [t for t in tropes if len(t.split()) > TROPE_WORDS]
    if long:
        raise ReplyError(f"trope labels over {TROPE_WORDS} words: {long}")
    payload = require_str(data, "payload", "reply")
    if len(payload.split()) > PAYLOAD_WORDS:
        raise ReplyError(f"payload has {len(payload.split())} words, over the cap of {PAYLOAD_WORDS}")
    return list(dict.fromkeys(tropes)), payload


def tag_story(story: str, model: str, known_tropes: list[str]) -> tuple[list[str], str]:
    """``(tropes, payload)`` for ``story``. Blocks on the network."""
    (tropes, payload), _raws = llm.ask_json(None, tag_prompt(story, known_tropes), model, _tag_validator, retries=2)
    return tropes, payload


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------
_WORD_RE = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")
_SENTENCE_RE = re.compile(r"(?<=[.!?])[\"')\]]*\s+|\n+")
_NAME_RE = re.compile(r"\b[A-Z][a-z]+(?:'[a-z]+)?\b")
# An honorific's period would end the sentence and hide the name after it.
_HONORIFIC_RE = re.compile(r"\b(Mr|Mrs|Ms|Dr|St)\.")

# Words an n-gram needs more than to count as a pattern: "one of the" recurs
# in any collection and says nothing about this one.
STOPWORDS = frozenset(
    """a about all an and any are as at be been but by can could did do does down for from had
    has have he her his i if in into is it its just me more most my no not of off on only or our
    out over she so than that the their them then there they this to up very was we were what
    when where which who will with would you your""".split()
)

# Capitalized words that are rarely names, for when they open a clause
# after a colon or a quote.
_NOT_NAMES = frozenset(
    """The A An And But Or So If When Then There This That These Those It Its He She They We You I
    His Her Their Our Your My No Not Every Each All Some One Two Three Nobody Everyone Someone
    Monday Tuesday Wednesday Thursday Friday Saturday Sunday Mr Mrs Ms Dr St""".split()
)


def words(text: str) -> list[str]:
    return _WORD_RE.findall(text.casefold())


def _story_counts(items_per_story: list[set[str]]) -> Counter:
    """How many stories each item appears in."""
    counts: Counter = Counter()
    for items in items_per_story:
        counts.update(items)
    return counts


def _repeated(counts: Counter, min_stories: int) -> list[tuple[str, int]]:
    return sorted(((k, n) for k, n in counts.items() if n >= min_stories), key=lambda kv: (-kv[1], kv[0]))


def openers(stories: list[str], length: int = 3, min_stories: int = 2) -> list[tuple[str, int]]:
    """Opening word sequences, up to ``length`` words, that ``min_stories`` or more stories share.

    A shorter opener is listed only when it is shared by more stories than
    each longer opener that extends it, so "the first" is not listed beside
    "the first rule" when the same stories account for both.
    """
    counts: Counter = Counter()
    for story in stories:
        opening = words(story)[:length]
        counts.update(" ".join(opening[:n]) for n in range(2, len(opening) + 1))
    return _drop_subsumed(_repeated(counts, min_stories), prefix_only=True)


def ngrams(stories: list[str], sizes: range = range(3, 6), min_stories: int = 2) -> list[tuple[str, int]]:
    """Word n-grams shared by ``min_stories`` or more stories, ignoring all-stopword ones.

    An n-gram inside a longer listed one with the same count is dropped.
    """
    per_story = []
    for story in stories:
        tokens = words(story)
        grams = set()
        for n in sizes:
            for i in range(len(tokens) - n + 1):
                gram = tokens[i : i + n]
                if not all(w in STOPWORDS for w in gram):
                    grams.add(" ".join(gram))
        per_story.append(grams)
    return _drop_subsumed(_repeated(_story_counts(per_story), min_stories), prefix_only=False)


def _drop_subsumed(items: list[tuple[str, int]], prefix_only: bool) -> list[tuple[str, int]]:
    kept = []
    for text, count in items:
        padded = f" {text} "
        subsumed = any(
            other_count >= count
            and other != text
            and (f" {other} ".startswith(padded) if prefix_only else padded in f" {other} ")
            for other, other_count in items
        )
        if not subsumed:
            kept.append((text, count))
    return kept


def names(stories: list[str]) -> list[set[str]]:
    """Each story's likely proper names: capitalized words that don't open a sentence."""
    out = []
    for story in stories:
        found = set()
        for sentence in _SENTENCE_RE.split(_HONORIFIC_RE.sub(r"\1", story.strip())):
            sentence = sentence.lstrip("\"'([ ")
            for match in _NAME_RE.finditer(sentence):
                if match.start() > 0 and match.group() not in _NOT_NAMES:
                    found.add(match.group())
        out.append(found)
    return out


def _edit_distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def similar_names(all_names: set[str], max_distance: int = 1, min_length: int = 4) -> list[tuple[str, str]]:
    """Pairs of different names one edit apart ("Vane", "Vance"), shorter names ignored."""
    ordered = sorted(n for n in all_names if len(n) >= min_length)
    return [
        (a, b)
        for i, a in enumerate(ordered)
        for b in ordered[i + 1 :]
        if abs(len(a) - len(b)) <= max_distance and _edit_distance(a.casefold(), b.casefold()) <= max_distance
    ]


def _tally(values: list[str | None]) -> list[tuple[str, int]]:
    counts = Counter(v for v in values if v)
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def analyze(entries: list[MemoryEntry], min_stories: int = 2) -> Report:
    """Count patterns across ``entries``.

    Openers, n-grams and names list only what ``min_stories`` or more stories
    share; similar names are listed even when each is used once.
    """
    stories = [e.story for e in entries]
    story_names = names(stories)
    return Report(
        stories=len(entries),
        tropes=_tally([t for e in entries for t in e.tropes]),
        seeds=_tally([e.seed for e in entries]),
        forms=_tally([e.form for e in entries]),
        constraints=_tally([e.constraint for e in entries]),
        openers=openers(stories, min_stories=min_stories),
        ngrams=ngrams(stories, min_stories=min_stories),
        names=_repeated(_story_counts(story_names), min_stories),
        similar_names=similar_names(set().union(*story_names) if story_names else set()),
    )


def format_report(report: Report, limit: int = 25) -> str:
    """The report as Markdown, each list cut to its ``limit`` most frequent items."""

    def section(title: str, items: list[tuple[str, int]], unit: str = "stories") -> str:
        if not items:
            return f"## {title}\n\nNone.\n"
        rows = "\n".join(f"- {item} ({count})" for item, count in items[:limit])
        more = f"\n- ...and {len(items) - limit} more" if len(items) > limit else ""
        return f"## {title} ({unit})\n\n{rows}{more}\n"

    pairs = "\n".join(f"- {a} / {b}" for a, b in report.similar_names) or "None."
    return "\n".join(
        [
            f"# Collection memory\n\n{report.stories} stories.\n",
            section("Tropes", report.tropes),
            section("Seeds", report.seeds),
            section("Forms", report.forms),
            section("Constraints", report.constraints),
            section("Repeated openers", report.openers),
            section("Shared n-grams", report.ngrams),
            section("Reused names", report.names),
            f"## Similar names\n\n{pairs}\n",
        ]
    )
