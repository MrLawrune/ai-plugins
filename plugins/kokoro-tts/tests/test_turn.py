import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from kokoro_turn import extract_block, first_sentence, route_cue, route_turn  # noqa: E402

CFG = {"attention_sound": True, "working_sound": True}


def block(weight, body=None):
    if body is None:
        return f'<!-- TTS_RESPONSE weight="{weight}" -->'
    return f'<!-- TTS_RESPONSE weight="{weight}"\n{body}\nTTS_RESPONSE -->'


def test_speech_block_is_spoken():
    assert route_turn("Done.\n\n" + block("speech", "All tests pass."), "brief") == {
        "action": "speech", "text": "All tests pass."}


def test_last_block_wins():
    text = block("sound:done") + "\nmore\n" + block("speech", "Final words.")
    assert route_turn(text, "brief") == {"action": "speech", "text": "Final words."}


def test_legacy_summary_block_is_speech():
    text = "x\n<!-- TTS_SUMMARY\nLegacy words.\nTTS_SUMMARY -->"
    assert route_turn(text, "verbose") == {"action": "speech", "text": "Legacy words."}


def test_no_block_falls_back_to_first_sentence():
    assert route_turn("Build is green. Details follow.", "brief") == {
        "action": "speech", "text": "Build is green."}


def test_fallback_prefers_final_text():
    assert route_turn("Old part. New part.", "brief", final_text="New part.") == {
        "action": "speech", "text": "New part."}


def test_fallback_uses_full_text_when_final_has_nothing_speakable():
    assert route_turn("Summary here. ```x```", "brief", final_text="```code```") == {
        "action": "speech", "text": "Summary here."}


def test_nothing_speakable_is_silent():
    assert route_turn("```only code```", "brief") == {"action": "silent"}


def test_quiet_mode_silences_speech():
    assert route_turn(block("speech", "Hi."), "quiet") == {"action": "silent"}


def test_ambient_mode_downgrades_speech_to_attention():
    assert route_turn(block("speech", "Hi."), "ambient") == {"action": "sound", "sound": "attention"}


def test_ambient_keeps_lower_sounds():
    assert route_turn(block("sound:done"), "ambient") == {"action": "sound", "sound": "done"}


def test_silent_block_is_silent():
    assert route_turn(block("silent"), "verbose") == {"action": "silent"}


def test_unknown_weight_is_silent():
    assert route_turn(block("shout"), "verbose") == {"action": "silent"}


def test_empty_speech_block_plays_done():
    assert route_turn('<!-- TTS_RESPONSE weight="speech" -->', "brief") == {"action": "sound", "sound": "done"}


def test_unknown_mode_is_treated_as_speech_ceiling():
    assert route_turn(block("speech", "Hi."), "loud") == {"action": "speech", "text": "Hi."}


def test_first_sentence_strips_blocks_fences_and_headings():
    assert first_sentence("# Title\n```x```\nHello there. More.") == "Title Hello there."


def test_extract_block_none():
    assert extract_block("plain") == (None, None)


def test_cue_attention_allowed():
    assert route_cue("attention", "brief", CFG) == {"action": "sound", "sound": "attention"}


def test_cue_respects_toggles():
    assert route_cue("attention", "brief", {**CFG, "attention_sound": False}) == {"action": "silent"}
    assert route_cue("working", "brief", {**CFG, "working_sound": False}) == {"action": "silent"}


def test_cue_quiet_mode_is_silent():
    assert route_cue("attention", "quiet", CFG) == {"action": "silent"}


def test_cue_unknown_sound_is_silent():
    assert route_cue("klaxon", "brief", CFG) == {"action": "silent"}
