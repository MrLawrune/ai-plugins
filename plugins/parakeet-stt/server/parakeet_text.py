"""Transcript post-processing: filler removal and custom-word correction (Handy parity)."""
from __future__ import annotations

import re

FILLERS = frozenset({"um", "uh", "uhm", "er", "erm", "ah", "hmm", "mm"})
_EDGE_PUNCT = ".,!?;:"
_SENTENCE_END = ".!?"
_MIN_WORD_CORE = 3


def _core(token: str) -> str:
    return token.strip(_EDGE_PUNCT + "\"'()").lower()


def remove_fillers(text: str) -> str:
    kept: list[str] = []
    for token in text.split():
        if _core(token) in FILLERS:
            end = token[-1] if token[-1] in _SENTENCE_END else ""
            if end and kept and kept[-1][-1] not in _EDGE_PUNCT:
                kept[-1] += end
            continue
        kept.append(token)
    if not kept:
        return ""
    out = " ".join(kept)
    out = re.sub(r"^[,;:]\s*", "", out)
    return out[:1].upper() + out[1:]


def _levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _norm(s: str) -> str:
    return re.sub(r"[^0-9a-z]", "", s.lower())


def _window_core(tokens: list[str]) -> str:
    return _norm("".join("." if _core(t) == "dot" else t for t in tokens))


def apply_custom_words(text: str, words: list[str], threshold: float) -> str:
    targets = [(w, _norm(w)) for w in words if len(_norm(w)) >= _MIN_WORD_CORE]
    if not targets:
        return text
    tokens = text.split(" ")
    out: list[str] = []
    i = 0
    while i < len(tokens):
        best: tuple[float, int, str] | None = None  # (distance ratio, -n, word)
        for n in (3, 2, 1):
            window = tokens[i : i + n]
            if len(window) < n:
                continue
            core = _window_core(window)
            if len(core) < _MIN_WORD_CORE:
                continue
            for word, wcore in targets:
                ratio = _levenshtein(core, wcore) / max(len(core), len(wcore))
                if ratio <= threshold and (best is None or (ratio, -n) < (best[0], best[1])):
                    best = (ratio, -n, word)
        if best is None:
            out.append(tokens[i])
            i += 1
            continue
        n = -best[1]
        first, last = tokens[i], tokens[i + n - 1]
        lead = first[: len(first) - len(first.lstrip(_EDGE_PUNCT + "\"'("))]
        trail = last[len(last.rstrip(_EDGE_PUNCT + "\"')")) :]
        out.append(f"{lead}{best[2]}{trail}")
        i += n
    return " ".join(out)


def postprocess(text: str, *, custom_words: list[str], remove_fillers_: bool, threshold: float) -> str:
    text = text.strip()
    if remove_fillers_:
        text = remove_fillers(text)
    return apply_custom_words(text, custom_words, threshold)
