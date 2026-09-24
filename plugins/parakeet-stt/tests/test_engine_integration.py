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


def test_silero_stream_detects_speech_in_fixture():
    from parakeet_audio import decode_to_mono16k
    from parakeet_config import ServerConfig
    from parakeet_endpoint import FRAME
    from parakeet_engine import ParakeetEngine

    engine = ParakeetEngine(ServerConfig.from_env({}))
    engine.load()
    vad = engine.new_vad()
    audio = decode_to_mono16k((Path(__file__).parent / "fixtures" / "speech.webm").read_bytes())
    probs = [vad.prob(audio[i : i + FRAME]) for i in range(0, len(audio) - FRAME, FRAME)]
    assert sum(p > 0.5 for p in probs) > len(probs) // 2


def test_real_model_streams_fixture():
    import asyncio
    import numpy as np
    from aiohttp import WSMsgType
    from aiohttp.test_utils import TestClient, TestServer
    from parakeet_audio import decode_to_mono16k
    from parakeet_config import ServerConfig
    from parakeet_engine import ParakeetEngine
    from parakeet_server import create_app

    engine = ParakeetEngine(ServerConfig.from_env({}))
    engine.load()
    audio = decode_to_mono16k((Path(__file__).parent / "fixtures" / "speech.webm").read_bytes())
    pcm = (np.concatenate([audio, np.zeros(16000, np.float32)]) * 32767).astype("<i2").tobytes()

    async def go():
        app = create_app(ServerConfig.from_env({}), engine, load_in_background=False)
        async with TestClient(TestServer(app)) as c:
            ws = await c.ws_connect("/v1/stream")
            await ws.send_json({"type": "start", "options": {"custom_words": ["tmux"]}})
            assert (await ws.receive_json())["type"] == "ready"
            for i in range(0, len(pcm), 640):  # 20 ms frames
                await ws.send_bytes(pcm[i : i + 640])
            await ws.send_json({"type": "stop"})
            events = []
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    events.append(msg.json())
                    if events[-1]["type"] == "ended":
                        break
            return events

    events = asyncio.run(go())
    text = " ".join(e["text"] for e in events if e["type"] == "final").lower()
    assert "tmux session" in text and "before lunch" in text
