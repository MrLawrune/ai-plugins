from parakeet_commands import find_phrase, parse, strip_command

CMDS = {"send": "send it", "stop": "stop listening", "clear": "clear all response text"}
START = ("start new reply", "send new message")


def test_find_phrase_matches_whole_words_ignoring_case_and_punctuation():
    assert find_phrase("Okay. Start new reply, fix the bug.", "start new reply") == ("Okay.", "fix the bug.")
    assert find_phrase("restart new reply", "start new reply", fuzzy=False) is None
    assert find_phrase("start new replying", "start new reply", fuzzy=False) is None
    assert find_phrase("a b a b", "a b", last=True) == ("a b", "")


def test_strip_command_only_at_phrase_end():
    assert strip_command("I'll send it tomorrow.", {"send": "send it"}) == ("I'll send it tomorrow.", None)
    assert strip_command("Okay, SEND IT!", {"send": "send it"}) == ("Okay", "send")
    assert strip_command("send it", {"send": "send it"}) == ("", "send")


def test_waiting_ignores_speech_without_a_start_phrase():
    p = parse("Fix the bug, send it.", CMDS, START, waiting=True)
    assert (p.before, p.text, p.after, p.waiting) == ((), "", None, True)


def test_start_phrase_keeps_what_follows():
    p = parse("Okay, start new reply. Fix the login bug.", CMDS, START, waiting=True)
    assert (p.before, p.text, p.after, p.waiting) == (("start",), "Fix the login bug.", None, False)
    p = parse("send new message fix it", CMDS, START, waiting=True)
    assert (p.before, p.text) == (("start",), "Fix it")


def test_start_alone_inserts_nothing():
    p = parse("Start new reply.", CMDS, START, waiting=True)
    assert (p.before, p.text, p.waiting) == (("start",), "", False)


def test_send_returns_to_waiting_only_with_start_phrases():
    assert parse("Done, send it.", CMDS, START, waiting=False).waiting is True
    p = parse("Done, send it.", CMDS, (), waiting=False)
    assert (p.text, p.after, p.waiting) == ("Done", "send", False)


def test_start_text_and_send_in_one_phrase():
    p = parse("Start new reply, looks good, send it.", CMDS, START, waiting=True)
    assert (p.before, p.text, p.after, p.waiting) == (("start",), "Looks good", "send", True)


def test_clear_anywhere_keeps_what_follows():
    p = parse("This is wrong. Clear all response text. Try again.", CMDS, START, waiting=False)
    assert (p.before, p.text, p.after) == (("clear",), "Try again.", None)
    p = parse("clear all response text", CMDS, (), waiting=False)
    assert (p.before, p.text) == (("clear",), "")


def test_stop_and_clear_work_while_waiting_but_send_does_not():
    assert parse("Stop listening.", CMDS, START, waiting=True).after == "stop"
    assert parse("Send it.", CMDS, START, waiting=True).after is None
    p = parse("Clear all response text.", CMDS, START, waiting=True)
    assert (p.before, p.text, p.waiting) == (("clear",), "", True)


def test_start_phrase_is_plain_text_once_dictating():
    p = parse("Start new reply", CMDS, START, waiting=False)
    assert (p.before, p.text) == ((), "Start new reply")


def test_no_commands_passes_text_through():
    p = parse("Send it.", {}, (), waiting=False)
    assert (p.before, p.text, p.after, p.waiting) == ((), "Send it.", None, False)


def test_long_phrases_match_loosely():
    assert find_phrase("Okay start a new reply. Hello.", "start new reply") == ("Okay", "Hello.")
    assert find_phrase("Star new replay, hello", "start new reply") == ("", "hello")
    assert find_phrase("Clear all the response text.", "clear all response text") == ("", "")
    assert find_phrase("clear all responsibilities", "clear all response text") is None
    assert find_phrase("I started a new thread", "start new reply") is None


def test_short_phrases_stay_exact():
    assert strip_command("Buy it and spend it.", {"send": "send it"}) == ("Buy it and spend it.", None)
    assert strip_command("That's it. Sent it.", {"send": "send it"}) == ("That's it. Sent it.", None)


def test_alternatives_are_comma_separated():
    assert strip_command("Looks good. Sunday.", {"send": "send it, sunday"}) == ("Looks good.", "send")
    p = parse("New message please, hi", CMDS, ("start new reply", "new message please"), waiting=True)
    assert (p.before, p.text) == (("start",), "Hi")


def test_start_phrase_split_by_a_pause():
    first = parse("Start new.", CMDS, START, waiting=True)
    assert (first.before, first.waiting, first.carry) == ((), True, "Start new.")
    p = parse("Reply. Fix the bug.", CMDS, START, waiting=True, carry=first.carry)
    assert (p.before, p.text, p.waiting, p.carry) == (("start",), "Fix the bug.", False, "")
