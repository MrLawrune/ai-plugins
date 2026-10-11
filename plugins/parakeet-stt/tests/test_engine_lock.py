import asyncio
import logging
import threading
import time

import numpy as np
import pytest

from parakeet_config import ServerConfig
from parakeet_server import LOCK, create_app, run_transcription

AUDIO = np.zeros(1600, dtype=np.float32)


class SlowEngine:
    """Blocking transcribe that records how many calls overlap."""

    model_id = "parakeet-tdt-0.6b-v2"
    ready = True

    def __init__(self, delay=0.3):
        self.delay = delay
        self.calls = 0
        self.active = 0
        self.max_active = 0
        self._guard = threading.Lock()

    def transcribe(self, audio):
        with self._guard:
            self.calls += 1
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            time.sleep(self.delay)
            return "text"
        finally:
            with self._guard:
                self.active -= 1


def make_app(engine):
    return create_app(ServerConfig.from_env({}), engine, load_in_background=False)


def test_cancelled_request_keeps_the_slot_until_its_thread_ends():
    async def go():
        engine = SlowEngine(delay=0.3)
        app = make_app(engine)
        first = asyncio.create_task(run_transcription(app, AUDIO, partial=False))
        await asyncio.sleep(0.05)  # the worker thread is inside transcribe
        first.cancel()
        second = asyncio.create_task(run_transcription(app, AUDIO, partial=False))
        assert await second == "text"
        await asyncio.sleep(0.4)  # let the cancelled call's thread finish too
        return engine, app

    engine, app = asyncio.run(go())
    assert engine.calls == 2
    assert engine.max_active == 1
    assert not app[LOCK].locked()


def test_slot_is_released_after_a_normal_run_and_after_an_engine_error():
    class Boom(SlowEngine):
        def transcribe(self, audio):
            raise RuntimeError("onnx exploded")

    async def go():
        app = make_app(Boom())
        with pytest.raises(RuntimeError, match="onnx exploded"):
            await run_transcription(app, AUDIO, partial=False)
        return app[LOCK].locked()

    assert asyncio.run(go()) is False


def test_partial_skips_while_the_slot_is_held_and_never_calls_the_engine():
    async def go():
        engine = SlowEngine(delay=0.01)
        app = make_app(engine)
        await app[LOCK].acquire()
        skipped = await run_transcription(app, AUDIO, partial=True)
        return skipped, engine.calls

    assert asyncio.run(go()) == (None, 0)


def test_final_waits_for_the_slot_and_then_runs():
    async def go():
        engine = SlowEngine(delay=0.01)
        app = make_app(engine)
        await app[LOCK].acquire()
        final = asyncio.create_task(run_transcription(app, AUDIO, partial=False))
        await asyncio.sleep(0.05)
        waited = not final.done() and engine.calls == 0
        app[LOCK].release()
        return waited, await final, engine.calls

    assert asyncio.run(go()) == (True, "text", 1)


def test_partial_skips_in_the_window_between_release_and_the_waiting_final_running():
    async def go():
        engine = SlowEngine(delay=0.01)
        app = make_app(engine)
        await app[LOCK].acquire()
        final = asyncio.create_task(run_transcription(app, AUDIO, partial=False))
        await asyncio.sleep(0.05)  # the final is queued on the lock
        app[LOCK].release()  # hands the slot to the final, which has not resumed yet
        skipped = await asyncio.wait_for(run_transcription(app, AUDIO, partial=True), timeout=0.5)
        return skipped, await final, engine.calls

    assert asyncio.run(go()) == (None, "text", 1)


def test_engine_failure_in_a_cancelled_request_is_logged_and_frees_the_slot(caplog):
    class Boom(SlowEngine):
        def transcribe(self, audio):
            time.sleep(0.2)
            raise RuntimeError("onnx exploded")

    async def go():
        app = make_app(Boom())
        task = asyncio.create_task(run_transcription(app, AUDIO, partial=False))
        await asyncio.sleep(0.05)
        task.cancel()
        await asyncio.sleep(0.4)
        return app[LOCK].locked()

    with caplog.at_level(logging.WARNING, logger="parakeet.server"):
        locked = asyncio.run(go())
    assert locked is False
    assert any("onnx exploded" in r.getMessage() for r in caplog.records)
