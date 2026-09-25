"""Voice-command parsing for streaming dictation.

Phrases match case- and punctuation-insensitively on whole words. A phrase setting may list
comma-separated alternatives ("send it, sunday"). Phrases of 10+ letters also match loosely
("start a new reply", "star new replay"); shorter ones must match exactly, so a slip like
"spend it" never sends. Short commands (`send`, `stop`) only count at the end of a phrase so they
can still be said mid-sentence; `clear` and start phrases count anywhere, and what follows them in
the same phrase is kept.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

FUZZY_MIN_LETTERS = 10
FUZZY_RATIO = 0.85

END_COMMANDS = ("send", "stop")
COMMAND_NAMES = (*END_COMMANDS, "clear")


def _words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", s.lower())


def _join(tokens: list[str]) -> str:
    return " ".join(tokens)


def _lead(text: str) -> str:
    """Remainder after a phrase: drop leading punctuation and start it as a sentence."""
    text = text.lstrip(" ,;:-.!?")
    return text[:1].upper() + text[1:]


def alternatives(phrase: str) -> list[str]:
    return [p.strip() for p in phrase.split(",") if _words(p)]


def _find_one(text: str, phrase: str, last: bool, fuzzy: bool) -> tuple[int, str, str] | None:
    """(start word index, before, after) of the first/last occurrence of one phrase in `text`.
    Exact matches win; loose ones are tried only when there is none."""
    want = _words(phrase)
    tokens = text.split()
    flat: list[tuple[str, int, bool, bool]] = []  # word, token index, first word of token, last word of token
    for i, tok in enumerate(tokens):
        ws = _words(tok)
        flat += [(w, i, j == 0, j == len(ws) - 1) for j, w in enumerate(ws)]
    target = "".join(want)

    def scan(sizes: list[int], ok) -> tuple[int, str, str] | None:
        hits = []
        for n in sizes:
            for s in range(max(0, len(flat) - n + 1)):
                window = flat[s : s + n]
                if n and window[0][2] and window[-1][3] and ok([w for w, *_ in window]):
                    hits.append((s, _join(tokens[: window[0][1]]), _join(tokens[window[-1][1] + 1 :])))
        if not hits:
            return None
        return max(hits, key=lambda h: h[0]) if last else min(hits, key=lambda h: h[0])

    exact = scan([len(want)], lambda got: got == want)
    if exact or not fuzzy or len(target) < FUZZY_MIN_LETTERS:
        return exact
    return scan([len(want) - 1, len(want), len(want) + 1],
                lambda got: SequenceMatcher(None, "".join(got), target).ratio() >= FUZZY_RATIO)


def find_phrase(text: str, phrase: str, *, last: bool = False, fuzzy: bool = True) -> tuple[str, str] | None:
    """Split `text` around the first (or last) occurrence of `phrase` or an alternative: (before, after)."""
    hits = [h for p in alternatives(phrase) if (h := _find_one(text, p, last, fuzzy)) is not None]
    if not hits:
        return None
    best = max(hits, key=lambda h: h[0]) if last else min(hits, key=lambda h: h[0])
    return best[1], best[2]


def strip_command(text: str, commands: dict[str, str]) -> tuple[str, str | None]:
    """Remove a command phrase from the end of `text`: (remaining text, command name or None)."""
    for name, phrase in commands.items():
        hit = find_phrase(text, phrase, last=True)
        if hit is not None and not _words(hit[1]):
            return hit[0].rstrip(" ,;:-"), name
    return text, None


@dataclass(frozen=True)
class Parsed:
    before: tuple[str, ...]
    """Commands to apply before inserting `text` (`start`, `clear`)."""
    text: str
    after: str | None
    """Command to apply after inserting `text` (`send`, `stop`)."""
    waiting: bool
    """Whether the session waits for a start phrase after this phrase."""
    carry: str = ""
    """While still waiting: this phrase, so a start phrase split by a pause matches next time."""


def _find_start(text: str, start: tuple[str, ...]) -> tuple[str, str] | None:
    hits = [h for p in start if (h := find_phrase(text, p)) is not None]
    return min(hits, key=lambda h: len(h[0])) if hits else None  # the earliest start phrase


def parse(text: str, commands: dict[str, str], start: tuple[str, ...], waiting: bool, carry: str = "") -> Parsed:
    """Interpret one final phrase. While `waiting`, nothing is inserted until a start phrase is heard;
    `carry` is the previous phrase heard while waiting."""
    before: list[str] = []
    ends = {k: v for k, v in commands.items() if k in END_COMMANDS}
    if waiting:
        hit = _find_start(text, start) or (_find_start(f"{carry} {text}", start) if carry else None)
        if hit is None:
            if "clear" in commands and find_phrase(text, commands["clear"]) is not None:
                before.append("clear")
            _, name = strip_command(text, {k: v for k, v in ends.items() if k == "stop"})
            return Parsed(tuple(before), "", name, True, carry=text)
        text = _lead(hit[1])
        before.append("start")
        waiting = False
    if "clear" in commands and (hit := find_phrase(text, commands["clear"], last=True)) is not None:
        before.append("clear")
        text = _lead(hit[1])
    text, name = strip_command(text, ends)
    if name == "send" and start:
        waiting = True
    return Parsed(tuple(before), text, name, waiting)
