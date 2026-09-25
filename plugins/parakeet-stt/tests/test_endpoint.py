from parakeet_endpoint import Endpointer


def run(ep, probs):
    return [(i, e) for i, p in enumerate(probs) if (e := ep.push(p))]


def test_opens_after_two_speech_frames_and_closes_after_pause():
    ep = Endpointer(pause_frames=3)
    events = run(ep, [0.1, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1])
    assert events == [(2, "start"), (6, "end")]
    assert ep.active is False


def test_single_click_does_not_open():
    ep = Endpointer(pause_frames=3)
    assert run(ep, [0.9, 0.1, 0.9, 0.1]) == []


def test_speech_during_pause_resets_the_pause():
    ep = Endpointer(pause_frames=3)
    events = run(ep, [0.9, 0.9, 0.1, 0.1, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1])
    assert events == [(1, "start"), (9, "end")]


def test_noise_blip_during_pause_does_not_restart_it():
    ep = Endpointer(pause_frames=4)
    events = run(ep, [0.9, 0.9, 0.1, 0.1, 0.6, 0.1, 0.1])
    assert events == [(1, "start"), (6, "end")]


def test_brief_dip_mid_speech_is_not_a_pause():
    ep = Endpointer(pause_frames=3)
    assert run(ep, [0.9, 0.9, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9]) == [(1, "start")]


def test_hysteresis_band_is_not_silence():
    ep = Endpointer(pause_frames=2)
    assert run(ep, [0.9, 0.9, 0.4, 0.4, 0.4]) == [(1, "start")]
