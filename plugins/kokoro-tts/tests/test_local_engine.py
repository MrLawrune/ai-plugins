import asyncio
import os
import sys
import threading
import time
from pathlib import Path

os.environ["KOKORO_HEADLESS"] = "1"
sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from kokoro_engine import LocalEngine  # noqa: E402


class FakeKokoro:
    async def create_stream(self, *args, **kwargs):
        if False:
            yield None


def test_cancelled_stream_mid_load_does_not_load_twice(monkeypatch):
    engine = LocalEngine("model.onnx", "voices.bin")
    calls = []
    started = threading.Event()

    def slow_load():
        calls.append(1)
        started.set()
        time.sleep(0.3)
        engine._kokoro = FakeKokoro()

    monkeypatch.setattr(engine, "_load", slow_load)

    async def drain():
        async for _ in engine.stream("hi", None, 1.0, "en-us", False):
            pass

    async def scenario():
        first = asyncio.create_task(drain())
        while not started.is_set():
            await asyncio.sleep(0.01)
        first.cancel()  # e.g. /interrupt while the model is still loading
        try:
            await first
        except asyncio.CancelledError:
            pass
        await drain()

    asyncio.run(scenario())
    assert len(calls) == 1
