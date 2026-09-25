"""Voice-command parsing for streaming dictation.

Phrases match case- and punctuation-insensitively on whole words. Short commands (`send`, `stop`)
only count at the end of a phrase so they can still be said mid-sentence; the longer `clear` and
start phrases count anywhere, and what follows them in the same phrase is kept.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

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


def find_phrase(text: str, phrase: str, *, last: bool = False) -> tuple[str, str] | None:
    """Split `text` around the first (or last) whole-token occurrence of `phrase`: (before, after)."""
    want = _words(phrase)
    if not want:
        return None
    tokens = text.split()
    flat: list[tuple[str, int, bool, bool]] = []  # word, token index, first word of token, last word of token
    for i, tok in enumerate(tokens):
        ws = _words(tok)
        flat += [(w, i, j == 0, j == len(ws) - 1) for j, w in enumerate(ws)]
    starts = range(len(flat) - len(want), -1, -1) if last else range(len(flat) - len(want) + 1)
    for s in starts:
        window = flat[s : s + len(want)]
        if [w for w, *_ in window] == want and window[0][2] and window[-1][3]:
            return _join(tokens[: window[0][1]]), _join(tokens[window[-1][1] + 1 :])
    return None


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


def parse(text: str, commands: dict[str, str], start: tuple[str, ...], waiting: bool) -> Parsed:
    """Interpret one final phrase. While `waiting`, nothing is inserted until a start phrase is heard."""
    before: list[str] = []
    ends = {k: v for k, v in commands.items() if k in END_COMMANDS}
    if waiting:
        hits = [h for p in start if (h := find_phrase(text, p)) is not None]
        if not hits:
            if "clear" in commands and find_phrase(text, commands["clear"]) is not None:
                before.append("clear")
            _, name = strip_command(text, {k: v for k, v in ends.items() if k == "stop"})
            return Parsed(tuple(before), "", name, True)
        text = _lead(min(hits, key=lambda h: len(h[0]))[1])  # the earliest start phrase
        before.append("start")
        waiting = False
    if "clear" in commands and (hit := find_phrase(text, commands["clear"], last=True)) is not None:
        before.append("clear")
        text = _lead(hit[1])
    text, name = strip_command(text, ends)
    if name == "send" and start:
        waiting = True
    return Parsed(tuple(before), text, name, waiting)
