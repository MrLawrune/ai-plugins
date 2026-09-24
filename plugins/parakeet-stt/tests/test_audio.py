import numpy as np
import pytest

from audio_fixtures import encode_tone
from parakeet_audio import SAMPLE_RATE, AudioDecodeError, decode_to_mono16k


@pytest.mark.parametrize("container", ["webm", "ogg", "mp4", "wav"])
def test_decodes_browser_formats_to_16k_mono(container):
    audio = decode_to_mono16k(encode_tone(container, seconds=1.0))
    assert audio.dtype == np.float32
    assert audio.ndim == 1
    assert abs(len(audio) - SAMPLE_RATE) < SAMPLE_RATE * 0.1  # aac adds priming samples
    assert 0.2 < float(np.abs(audio).max()) < 0.4


def test_garbage_raises_decode_error():
    with pytest.raises(AudioDecodeError):
        decode_to_mono16k(b"definitely not audio" * 20)


def test_empty_raises_decode_error():
    with pytest.raises(AudioDecodeError):
        decode_to_mono16k(b"")
