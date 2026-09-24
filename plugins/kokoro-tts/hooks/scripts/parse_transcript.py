#!/usr/bin/env python3
"""Parse a Claude Code transcript JSONL for the kokoro-tts Stop hook.

Usage: parse_transcript.py TRANSCRIPT_PATH
       parse_transcript.py --stdin-message   (final assistant text on stdin)
Prints one line of JSON to stdout. Always exits 0.

Output shapes:
  {"kind": "intermediate"}   last assistant entry has tool_use (mid-loop)
  {"kind": "empty"}          no assistant text in the turn / unreadable file
  {"kind": "final", "text": str, "final_text": str}
"""

import json
import sys
import time

READ_RETRIES = 4
RETRY_DELAY_S = 0.3
# Claude Code appends the final assistant text to the transcript slightly
# after firing Stop. If the newest assistant entry is still a tool_use we
# re-read for a bit before believing the turn is intermediate.
INTERMEDIATE_RETRIES = 10
INTERMEDIATE_DELAY_S = 0.3


def _content_list(obj):
    content = obj.get("content")
    if content is None:
        content = obj.get("message", {}).get("content", [])
    return content if isinstance(content, list) else []


def parse_turn(lines):
    """Scan transcript lines backwards; return the current turn's state."""
    collected = []
    first_assistant = True
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        t = obj.get("type", "")
        if t not in ("user", "assistant"):
            continue
        if t == "user":
            content = _content_list(obj)
            is_tool_result = bool(content) and all(
                isinstance(c, dict) and c.get("type") == "tool_result" for c in content
            )
            if not is_tool_result:
                break
            continue
        content = _content_list(obj)
        types = {c.get("type") for c in content if isinstance(c, dict)}
        if first_assistant:
            if "tool_use" in types:
                return {"kind": "intermediate"}
            first_assistant = False
        texts = [
            c["text"]
            for c in content
            if isinstance(c, dict) and c.get("type") == "text" and c.get("text", "").strip()
        ]
        if texts:
            collected.append(" ".join(texts))
    if not collected:
        return {"kind": "empty"}
    # `collected` was built scanning backwards, so collected[0] is the
    # turn's most recent (final) assistant text fragment.
    return {
        "kind": "final",
        "text": " ".join(reversed(collected)),
        "final_text": collected[0],
    }


def _read_lines(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.readlines()
    except (OSError, UnicodeDecodeError):
        return None


def read_turn(path, sleep=time.sleep):
    """parse_turn with retries: on unreadable/empty transcripts, and on
    'intermediate' (the final text may not have been flushed yet)."""
    result = {"kind": "empty"}
    for attempt in range(READ_RETRIES):
        lines = _read_lines(path)
        if lines:
            result = parse_turn(lines)
            if result["kind"] != "empty":
                break
        if attempt < READ_RETRIES - 1:
            sleep(RETRY_DELAY_S)
    for _ in range(INTERMEDIATE_RETRIES):
        if result["kind"] != "intermediate":
            break
        sleep(INTERMEDIATE_DELAY_S)
        lines = _read_lines(path)
        if lines:
            result = parse_turn(lines)
    return result


def main():
    # Safety net: this CLI's contract is to ALWAYS print exactly one line of
    # JSON and ALWAYS exit 0, no matter what goes wrong reading or parsing
    # the transcript (e.g. invalid UTF-8, permission errors, surprises in
    # untrusted transcript content).
    try:
        if len(sys.argv) < 2:
            print(json.dumps({"kind": "empty"}))
            return
        if sys.argv[1] == "--stdin-message":
            text = sys.stdin.read().strip()
            result = {"kind": "final", "text": text, "final_text": text} if text else {"kind": "empty"}
        else:
            result = read_turn(sys.argv[1])
        print(json.dumps(result))
    except Exception:
        print(json.dumps({"kind": "empty"}))


if __name__ == "__main__":
    main()
