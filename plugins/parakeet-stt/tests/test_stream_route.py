import asyncio

import numpy as np
from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer

from parakeet_config import ServerConfig
from parakeet_server import create_app

FRAME = 512


class FakeEngine:
    model_id = "parakeet-tdt-0.6b-v2"

    def __init__(self, ready=True):
        self.ready = ready

    def load(self):
        self.ready = True

    def transcribe(self, audio):
        return f"heard {len(audio) // FRAME} frames"


class FakeVad:
    def prob(self, frame):
        return float(frame.mean())


def pcm(prob, frames):
    return np.full(frames * FRAME, prob * 32767).astype("<i2").tobytes()


def run(fn, engine=None, env=None):
    async def go():
        cfg = ServerConfig.from_env(env if env is not None else {"PARAKEET_API_KEY": "secret"})
        app = create_app(cfg, engine or FakeEngine(), load_in_background=False, vad_factory=FakeVad)
        async with TestClient(TestServer(app)) as client:
            return await fn(client)
    return asyncio.run(go())


async def collect(ws):
    out = []
    async for msg in ws:
        if msg.type == WSMsgType.TEXT:
            out.append(msg.json())
            if out[-1]["type"] == "ended":
                break
    return out


def test_stream_happy_path():
    async def fn(c):
        ws = await c.ws_connect("/v1/stream")
        await ws.send_json({"type": "start", "api_key": "secret", "options": {"pause_ms": 300, "preview": False}})
        ready = await ws.receive_json()
        await ws.send_bytes(pcm(0.9, 15) + pcm(0.0, 10))
        await ws.send_json({"type": "stop"})
        return ready, await collect(ws)
    ready, events = run(fn)
    assert ready == {"type": "ready"}
    assert [e["type"] for e in events] == ["final", "ended"]
    assert events[0]["text"].startswith("Heard")
    assert events[1]["reason"] == "stopped"


def test_stream_rejects_bad_key_with_4401():
    async def fn(c):
        ws = await c.ws_connect("/v1/stream")
        await ws.send_json({"type": "start", "api_key": "nope"})
        first = await ws.receive_json()
        closing = await ws.receive()
        return first, ws.close_code
    first, code = run(fn)
    assert first["type"] == "error" and code == 4401


def test_stream_needs_no_bearer_header():
    async def fn(c):
        ws = await c.ws_connect("/v1/stream")  # no Authorization header: auth is in the start message
        await ws.send_json({"type": "start", "api_key": "secret"})
        return await ws.receive_json()
    assert run(fn) == {"type": "ready"}


def test_stream_not_ready_4503():
    async def fn(c):
        ws = await c.ws_connect("/v1/stream")
        await ws.send_json({"type": "start", "api_key": "secret"})
        first = await ws.receive_json()
        await ws.receive()
        return first["type"], ws.close_code
    assert run(fn, engine=FakeEngine(ready=False)) == ("error", 4503)


def test_stream_bad_options_4400():
    async def fn(c):
        ws = await c.ws_connect("/v1/stream")
        await ws.send_json({"type": "start", "api_key": "secret", "options": {"pause_ms": 5}})
        first = await ws.receive_json()
        await ws.receive()
        return first["type"], ws.close_code
    assert run(fn) == ("error", 4400)


def test_http_routes_still_require_bearer():
    async def fn(c):
        r = await c.get("/v1/models")
        return r.status
    assert run(fn) == 401
