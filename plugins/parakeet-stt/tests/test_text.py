from parakeet_text import apply_custom_words, postprocess, remove_fillers


def test_remove_fillers_drops_standalone_fillers_and_recapitalizes():
    assert remove_fillers("Um, so I think, uh, we should ship it.") == "So I think, we should ship it."


def test_remove_fillers_keeps_words_containing_filler_letters():
    assert remove_fillers("The umbrella is here.") == "The umbrella is here."


def test_remove_fillers_moves_sentence_end_to_previous_word():
    assert remove_fillers("Ship it um.") == "Ship it."


def test_remove_fillers_all_fillers_yields_empty():
    assert remove_fillers("Um. Uh.") == ""


def test_custom_word_fixes_case():
    assert apply_custom_words("Please open the Tmux session.", ["tmux"], 0.18) == "Please open the tmux session."


def test_custom_word_fuzzy_single_token():
    assert apply_custom_words("Plug in the yubikee now", ["Yubikey"], 0.18) == "Plug in the Yubikey now"


def test_custom_word_multi_token_window():
    assert apply_custom_words("edit the claude dot md file", ["CLAUDE.md"], 0.18) == "edit the CLAUDE.md file"


def test_custom_word_preserves_punctuation():
    assert apply_custom_words("I use Tmux, daily.", ["tmux"], 0.18) == "I use tmux, daily."


def test_custom_word_threshold_blocks_distant_words():
    assert apply_custom_words("the clawed config", ["Claude"], 0.18) == "the clawed config"


def test_custom_word_ignores_very_short_words():
    assert apply_custom_words("go to it", ["gt"], 0.5) == "go to it"


def test_postprocess_runs_both_steps():
    out = postprocess("Um, open Tmux.", custom_words=["tmux"], remove_fillers_=True, threshold=0.18)
    assert out == "Open tmux."


def test_postprocess_can_skip_fillers():
    out = postprocess("Um, open it.", custom_words=[], remove_fillers_=False, threshold=0.18)
    assert out == "Um, open it."
