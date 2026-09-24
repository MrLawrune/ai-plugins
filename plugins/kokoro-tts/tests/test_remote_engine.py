import asyncio
import os
import sys
from pathlib import Path

import numpy as np
import pytest

os.environ["KOKORO_HEADLESS"] = "1"
sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestServer  # noqa: E402

from kokoro_engine import RemoteEngine  # noqa: E402


def frame(value):
    samples = np.full(4, value, dtype=np.float32).tobytes()
    return len(samples).to_bytes(4, "little") + samples


def remote_app(frames, delay, fail_after=None):
    async def synthesize(request):
        resp = web.StreamResponse(headers={"X-Sample-Rate": "24000"})
        await resp.prepare(request)
        for i, value in enumerate(frames):
            if fail_after is not None and i == fail_after:
                request.transport.close()  # connection drops mid-reply
                return resp
            await resp.write(frame(value))
            await asyncio.sleep(delay)
        return resp
    app = web.Application()
    app.router.add_post("/synthesize", synthesize)
    return app


class FakeFallback:
    def __init__(self):
        self.calls = 0

    def get_voice_style(self, voice):
        return voice

    async def stream(self, text, style, speed, lang, trim):
        self.calls += 1
        yield np.zeros(4, dtype=np.float32), 24000


def collect(app, fallback, timeout_s):
    async def go():
        async with TestServer(app) as server:
            engine = RemoteEngine(str(server.make_url("")), fallback, timeout_s=timeout_s)
            try:
                return [float(chunk[0]) async for chunk, _ in engine.stream("hi", "af_sky", 1.0, "en-us", False)]
            finally:
                await engine.close()
    return asyncio.run(go())


def test_long_stream_outlasts_the_per_read_timeout():
    # 5 frames x 0.2 s = 1 s total, well past a 0.5 s timeout, but each read is quick.
    assert collect(remote_app([1, 2, 3, 4, 5], 0.2), None, timeout_s=0.5) == [1, 2, 3, 4, 5]


def test_failure_after_audio_does_not_replay_on_the_fallback():
    fallback = FakeFallback()
    with pytest.raises(Exception):
        collect(remote_app([1, 2, 3], 0.05, fail_after=2), fallback, timeout_s=2)
    assert fallback.calls == 0


def test_failure_before_audio_uses_the_fallback():
    fallback = FakeFallback()
    assert collect(remote_app([1], 0, fail_after=0), fallback, timeout_s=2) == [0.0]
    assert fallback.calls == 1
