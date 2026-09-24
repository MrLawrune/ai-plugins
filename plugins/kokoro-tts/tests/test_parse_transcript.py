import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "hooks" / "scripts"))

from parse_transcript import parse_turn, read_turn

SCRIPT_PATH = Path(__file__).parent.parent / "hooks" / "scripts" / "parse_transcript.py"


def entry(type_, content, nested=True):
    """Build a transcript JSONL line. Assistant content nests under message."""
    if type_ == "assistant" or nested:
        return json.dumps({"type": type_, "message": {"content": content}})
    return json.dumps({"type": type_, "content": content})


def text_block(t):
    return {"type": "text", "text": t}


def tool_use_block():
    return {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}


def tool_result_line():
    return json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}})


SPEECH_BLOCK = '<!-- TTS_RESPONSE weight="speech"\nAll tests pass.\nTTS_RESPONSE -->'
SOUND_BLOCK = '<!-- TTS_RESPONSE weight="sound:done" -->'
LEGACY_BLOCK = '<!-- TTS_SUMMARY\nLegacy summary here.\nTTS_SUMMARY -->'


class TestParseTurn:
    def test_final_turn_with_text(self):
        lines = [
            entry("user", [text_block("do the thing")]),
            entry("assistant", [text_block("Done. " + SPEECH_BLOCK)]),
        ]
        result = parse_turn(lines)
        assert result["kind"] == "final"
        assert "Done." in result["text"]

    def test_intermediate_when_last_assistant_has_tool_use(self):
        lines = [
            entry("user", [text_block("do the thing")]),
            entry("assistant", [text_block("Looking..."), tool_use_block()]),
        ]
        assert parse_turn(lines) == {"kind": "intermediate"}

    def test_stops_at_real_user_prompt_not_tool_result(self):
        lines = [
            entry("user", [text_block("previous prompt")]),
            entry("assistant", [text_block("OLD TURN TEXT")]),
            entry("user", [text_block("new prompt")]),
            entry("assistant", [text_block("part one"), tool_use_block()]),
            tool_result_line(),
            entry("assistant", [text_block("part two " + SPEECH_BLOCK)]),
        ]
        result = parse_turn(lines)
        assert result["kind"] == "final"
        assert "OLD TURN TEXT" not in result["text"]
        assert "part one" in result["text"]
        assert "part two" in result["text"]
        # fragments joined in original order
        assert result["text"].index("part one") < result["text"].index("part two")

    def test_empty_turn(self):
        lines = [entry("user", [text_block("hello")])]
        assert parse_turn(lines) == {"kind": "empty"}

    def test_malformed_lines_skipped(self):
        lines = [
            "not json at all",
            '{"type": "weird"}',
            entry("user", [text_block("go")]),
            entry("assistant", [text_block("ok " + SOUND_BLOCK)]),
        ]
        assert parse_turn(lines)["kind"] == "final"

    def test_final_text_is_last_fragment(self):
        lines = [
            entry("user", [text_block("new prompt")]),
            entry("assistant", [text_block("Let me check the parser first."), tool_use_block()]),
            tool_result_line(),
            entry("assistant", [text_block("All tests pass and the fix works.")]),
        ]
        result = parse_turn(lines)
        assert result["kind"] == "final"
        assert result["final_text"] == "All tests pass and the fix works."
        # joined "text" still holds both fragments in chronological order
        assert result["text"].index("Let me check") < result["text"].index("All tests pass")


class TestFallbackFromFinalMessage:
    def _run_cli(self, tmp_path, lines):
        transcript = tmp_path / "transcript.jsonl"
        transcript.write_text("\n".join(lines) + "\n")
        result = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), str(transcript)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        out_lines = result.stdout.splitlines()
        assert len(out_lines) == 1
        return json.loads(out_lines[0])

    def test_fallback_from_final_fragment(self, tmp_path):
        # Early narration, then a tool call, then a different final message.
        # No TTS block anywhere -- the CLI must report the final fragment
        # separately from the joined turn text.
        lines = [
            entry("user", [text_block("new prompt")]),
            entry("assistant", [text_block("Let me check the parser first."), tool_use_block()]),
            tool_result_line(),
            entry("assistant", [text_block("All tests pass and the fix works.")]),
        ]
        out = self._run_cli(tmp_path, lines)
        assert out == {
            "kind": "final",
            "text": "Let me check the parser first. All tests pass and the fix works.",
            "final_text": "All tests pass and the fix works.",
        }

    def test_fallback_falls_back_to_joined_when_final_fragment_unspeakable(self, tmp_path):
        # Final fragment is only a code fence; the CLI still reports both the
        # joined text and the final fragment, letting the caller decide.
        lines = [
            entry("user", [text_block("new prompt")]),
            entry(
                "assistant",
                [text_block("Fixed the parser bug in first_sentence handling."), tool_use_block()],
            ),
            tool_result_line(),
            entry("assistant", [text_block("```python\nx = 1\n```")]),
        ]
        out = self._run_cli(tmp_path, lines)
        assert out["kind"] == "final"
        assert out["final_text"] == "```python\nx = 1\n```"
        assert "Fixed the parser bug in first_sentence handling." in out["text"]


class TestCLIInvalidUTF8:
    def test_invalid_utf8_still_exits_zero_with_empty_json(self, tmp_path):
        transcript = tmp_path / "bad.jsonl"
        transcript.write_bytes(b"\xff\xfe not json")

        result = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), str(transcript)],
            capture_output=True,
            text=True,
        )

        assert result.returncode == 0
        lines = result.stdout.splitlines()
        assert len(lines) == 1
        assert json.loads(lines[0]) == {"kind": "empty"}



def test_read_turn_waits_for_late_final_text(tmp_path):
    """Stop can fire before the final assistant text is appended; read_turn must re-read."""
    path = tmp_path / "t.jsonl"
    lines = [entry("user", [text_block("hi")]), entry("assistant", [tool_use_block()]), tool_result_line()]
    path.write_text("\n".join(lines) + "\n")
    calls = {"n": 0}

    def fake_sleep(_):
        calls["n"] += 1
        if calls["n"] == 2:  # final text lands during the second wait
            with open(path, "a") as f:
                f.write(entry("assistant", [text_block("Done.\n\n<!-- TTS_RESPONSE weight=\"speech\"\nDone.\nTTS_RESPONSE -->")]) + "\n")

    result = read_turn(str(path), sleep=fake_sleep)
    assert result["kind"] == "final"
    assert "Done." in result["text"]


def test_read_turn_gives_up_on_true_intermediate(tmp_path):
    path = tmp_path / "t.jsonl"
    path.write_text("\n".join([entry("user", [text_block("hi")]), entry("assistant", [tool_use_block()])]) + "\n")
    sleeps = []
    result = read_turn(str(path), sleep=sleeps.append)
    assert result["kind"] == "intermediate"
    assert len(sleeps) == 10


def test_stdin_message_mode(tmp_path):
    import subprocess, sys, os
    script = os.path.join(os.path.dirname(__file__), "..", "hooks", "scripts", "parse_transcript.py")
    msg = 'Done.\n\n<!-- TTS_RESPONSE weight="speech"\nAll good.\nTTS_RESPONSE -->'
    out = subprocess.run([sys.executable, script, "--stdin-message"], input=msg, capture_output=True, text=True)
    data = json.loads(out.stdout)
    assert data == {"kind": "final", "text": msg, "final_text": msg}
