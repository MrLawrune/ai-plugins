import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from kokoro_turn import extract_block, first_sentence, full_text, parse_directive_attrs, route_cue, route_turn  # noqa: E402

CFG = {"attention_sound": True, "working_sound": True}


def block(weight, say=None):
    if say is None:
        return f'::kokoro-tts{{weight="{weight}"}}'
    return f'::kokoro-tts{{weight="{weight}" say="{say}"}}'


def test_speech_block_is_spoken():
    assert route_turn("Done.\n\n" + block("speech", "All tests pass."), "brief") == {
        "action": "speech", "text": "All tests pass."}


def test_last_block_wins():
    text = block("sound:done") + "\nmore\n" + block("speech", "Final words.")
    assert route_turn(text, "brief") == {"action": "speech", "text": "Final words."}


def test_no_block_falls_back_to_first_sentence():
    assert route_turn("Build is green. Details follow.", "brief") == {
        "action": "speech", "text": "Build is green."}


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


def test_full_reads_the_whole_reply_and_ignores_blocks():
    text = "First point.\n\nSecond point.\n" + block("silent")
    assert route_turn(text, "full") == {"action": "speech", "text": "First point.\n\nSecond point."}


def test_full_skips_code_and_tables_but_keeps_plain_inline_code():
    text = "Run `pytest` now.\n\n```bash\nrm -rf /tmp/x\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nThen `src/app.ts` builds."
    out = route_turn(text, "full")["text"]
    assert "Run pytest now." in out
    assert "Code block skipped." in out and "rm -rf" not in out
    assert "Table skipped." in out and "| a |" not in out
    assert "Then app.ts builds." in out


def test_full_reads_short_commands_and_drops_urls_in_code():
    out = route_turn("Run `bb plugin update` then open `https://x.test/a`.", "full")["text"]
    assert out == "Run bb plugin update then open ."


def test_full_caps_long_replies_at_a_sentence():
    from kokoro_turn import FULL_MAX_CHARS
    out = route_turn("This is one sentence. " * 1000, "full")["text"]
    assert len(out) <= FULL_MAX_CHARS + 40
    assert out.endswith("sentence.\n\nThe rest is on screen.")


def test_full_with_only_a_block_is_silent():
    assert route_turn(block("speech", "Words."), "full") == {"action": "silent"}


def test_cue_prefs_silence_a_disabled_working_tick():
    from kokoro_turn import apply_cue_prefs
    r = apply_cue_prefs({"action": "sound", "sound": "working"}, {"working_sound": False})
    assert r == {"action": "silent"}


def test_cue_prefs_turn_a_disabled_attention_ping_into_done():
    from kokoro_turn import apply_cue_prefs
    r = apply_cue_prefs({"action": "sound", "sound": "attention"}, {"attention_sound": False})
    assert r == {"action": "sound", "sound": "done"}


def test_cue_prefs_leave_speech_and_enabled_sounds_alone():
    from kokoro_turn import apply_cue_prefs
    cfg = {"working_sound": True, "attention_sound": True}
    for r in ({"action": "speech", "text": "Hi."}, {"action": "sound", "sound": "working"}, {"action": "silent"}):
        assert apply_cue_prefs(dict(r), cfg) == r


def directive(attrs):
    return f"::kokoro-tts{{{attrs}}}"


def test_directive_speech_is_spoken():
    text = "Done.\n\n" + directive('weight="speech" say="All tests pass."')
    assert route_turn(text, "brief") == {"action": "speech", "text": "All tests pass."}


def test_directive_sound_and_silent():
    assert route_turn("x\n\n" + directive('weight="sound:done"'), "brief") == {"action": "sound", "sound": "done"}
    assert route_turn("x\n\n" + directive('weight="silent"'), "brief") == {"action": "silent"}


def test_directive_attribute_quoting_forms():
    assert parse_directive_attrs("weight='speech' say=\"Hi there.\" flag") == {
        "weight": "speech", "say": "Hi there.", "flag": ""}
    assert parse_directive_attrs("weight=speech") == {"weight": "speech"}


def test_directive_decodes_entities():
    text = directive('weight="speech" say="He said &quot;hi&quot; &amp; left."')
    assert extract_block(text) == ("speech", 'He said "hi" & left.')


def test_directive_say_may_contain_braces():
    assert extract_block(directive('weight="speech" say="Use {name} here."')) == ("speech", "Use {name} here.")


def test_directive_with_crlf_line_ending():
    text = "Done.\r\n\r\n" + directive('weight="speech" say="Windows line."') + "\r\n"
    assert extract_block(text) == ("speech", "Windows line.")


def test_directive_inside_code_fence_is_ignored():
    text = "Real first sentence.\n\n```markdown\n" + directive('weight="speech" say="Example."') + "\n```\n"
    assert route_turn(text, "brief") == {"action": "speech", "text": "Real first sentence."}


def test_inline_directive_text_is_not_a_directive():
    text = "Write " + directive('weight="speech" say="No."') + " at the end."
    assert extract_block(text) == (None, None)


def test_html_comments_are_neither_directives_nor_spoken():
    text = '<!-- TTS_RESPONSE weight="speech"\nOld form.\nTTS_RESPONSE -->\nBuild is green. More.'
    assert extract_block(text) == (None, None)
    assert route_turn(text, "brief") == {"action": "speech", "text": "Build is green."}
    assert "Old form" not in route_turn(text, "full")["text"]


def test_last_of_two_directives_wins():
    text = directive('weight="sound:done"') + "\n\n" + directive('weight="speech" say="Final."')
    assert extract_block(text) == ("speech", "Final.")


def test_directive_speech_without_say_plays_done():
    assert route_turn(directive('weight="speech"'), "brief") == {"action": "sound", "sound": "done"}
    assert route_turn(directive('weight="speech" say="   "'), "brief") == {"action": "sound", "sound": "done"}


def test_directive_without_weight_is_silent():
    assert route_turn(directive('say="Nothing."'), "brief") == {"action": "silent"}


def test_first_sentence_and_full_text_skip_directives():
    text = directive('weight="sound:done"') + "\n\nReal words here. More.\n\n" + directive('weight="silent"')
    assert first_sentence(text) == "Real words here."
    assert "kokoro-tts" not in full_text(text)


def test_malformed_directive_body_falls_back_to_first_sentence():
    text = "Build is green. More detail.\n\n" + directive('weight="speech" say="He said "hi" now."')
    assert extract_block(text) == (None, None)
    assert route_turn(text, "brief") == {"action": "speech", "text": "Build is green."}


def test_malformed_directive_body_is_rejected():
    assert parse_directive_attrs('weight="speech" say="He said "hi" now."') is None
    assert parse_directive_attrs('weight="speech", say="x"') is None
