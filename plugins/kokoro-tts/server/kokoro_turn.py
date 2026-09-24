"""Turn routing for kokoro-tts: TTS block parsing, mode ceiling, fallback.

Shared by POST /turn (BB plugin, Claude Code Stop hook) and POST /cue.
Pure functions; no I/O.
"""

import re

MAX_FALLBACK_CHARS = 240
SOUNDS = ("working", "done", "attention", "error")

WEIGHT_RANK = {"silent": 0, "sound:working": 1, "sound:done": 2, "sound:attention": 3, "speech": 4}
RANK_WEIGHT = {rank: weight for weight, rank in WEIGHT_RANK.items()}
MODE_CEILING = {"quiet": 0, "ambient": 3, "brief": 4, "conversational": 4, "verbose": 4}

BLOCK_MULTILINE = re.compile(
    r'<!--\s*TTS_RESPONSE\s+weight="([^"]+)"\s*\n([\s\S]*?)\nTTS_RESPONSE\s*-->'
)
BLOCK_SELF_CLOSING = re.compile(r'<!--\s*TTS_RESPONSE\s+weight="([^"]+)"\s*-->')
BLOCK_LEGACY = re.compile(r"<!--\s*TTS_SUMMARY\s*\n([\s\S]*?)\nTTS_SUMMARY\s*-->")
ANY_BLOCK = re.compile(r"<!--\s*TTS_(?:RESPONSE|SUMMARY)[\s\S]*?-->")
CODE_FENCE = re.compile(r"```[\s\S]*?```")
SENTENCE = re.compile(r"(.+?[.!?])(?:\s|$)")


def extract_block(text):
    """Return (weight, content) from the last TTS block, or (None, None).

    Candidates from all three block forms (multiline TTS_RESPONSE,
    self-closing TTS_RESPONSE, legacy TTS_SUMMARY) are collected and the one
    whose match ends furthest to the right (i.e. textually last) wins. On a
    tie in end position, the multiline interpretation wins -- both because
    self-closing candidates whose span is nested inside a multiline match are
    dropped outright, and because ties are broken by priority.
    """
    candidates = []  # (end, priority, weight, content)

    multiline_spans = []
    for m in BLOCK_MULTILINE.finditer(text):
        multiline_spans.append((m.start(), m.end()))
        candidates.append((m.end(), 1, m.group(1), m.group(2).strip() or None))

    for m in BLOCK_SELF_CLOSING.finditer(text):
        if any(m.start() >= s and m.end() <= e for s, e in multiline_spans):
            continue  # nested inside a multiline block; multiline wins
        candidates.append((m.end(), 0, m.group(1), None))

    for m in BLOCK_LEGACY.finditer(text):
        content = m.group(1).strip()
        if content:
            candidates.append((m.end(), 0, "speech", content))

    if not candidates:
        return None, None

    candidates.sort(key=lambda c: (c[0], c[1]))
    _, _, weight, content = candidates[-1]
    return weight, content


def first_sentence(text):
    """First speakable sentence of the turn, blocks and fences stripped."""
    text = ANY_BLOCK.sub("", text)
    text = CODE_FENCE.sub("", text)
    text = re.sub(r"^#+\s*", "", text.strip(), flags=re.MULTILINE)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return None
    m = SENTENCE.match(text)
    sentence = m.group(1) if m else text
    return sentence[:MAX_FALLBACK_CHARS]


def route_turn(text: str, mode: str, final_text: str | None = None) -> dict:
    """Decide what a finished turn sounds like."""
    weight, content = extract_block(text)
    if weight is None:
        fallback = first_sentence(final_text) if final_text else None
        if fallback is None:
            fallback = first_sentence(text)
        if fallback is None:
            return {"action": "silent"}
        weight, content = "speech", fallback
    rank = WEIGHT_RANK.get(weight, 0)
    ceiling = MODE_CEILING.get(mode, 4)
    if rank > ceiling:
        rank = ceiling
    weight = RANK_WEIGHT[rank]
    if weight == "silent":
        return {"action": "silent"}
    if weight.startswith("sound:"):
        return {"action": "sound", "sound": weight.split(":", 1)[1]}
    if not content:
        return {"action": "sound", "sound": "done"}
    return {"action": "speech", "text": content}


def route_cue(sound: str, mode: str, cfg: dict) -> dict:
    """Gate a standalone sound (attention ping, working tick)."""
    if sound not in SOUNDS or MODE_CEILING.get(mode, 4) == 0:
        return {"action": "silent"}
    if sound == "attention" and not cfg.get("attention_sound", True):
        return {"action": "silent"}
    if sound == "working" and not cfg.get("working_sound", True):
        return {"action": "silent"}
    return {"action": "sound", "sound": sound}
