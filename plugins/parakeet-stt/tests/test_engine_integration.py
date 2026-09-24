import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.environ.get("PARAKEET_INTEGRATION") != "1", reason="set PARAKEET_INTEGRATION=1 to load the real model")


def test_real_model_transcribes_fixture():
    from parakeet_audio import decode_to_mono16k
    from parakeet_config import ServerConfig
    from parakeet_engine import ParakeetEngine

    engine = ParakeetEngine(ServerConfig.from_env({}))
    engine.load()
    audio = decode_to_mono16k((Path(__file__).parent / "fixtures" / "speech.webm").read_bytes())
    text = engine.transcribe(audio).lower()
    assert "session" in text and "before lunch" in text
