import asyncio
import json

import aiohttp
from aiohttp.test_utils import TestClient, TestServer

from audio_fixtures import encode_tone
from parakeet_config import ServerConfig
from parakeet_server import create_app


class FakeEngine:
    model_id = "parakeet-tdt-0.6b-v2"

    def __init__(self, text="Um, open Tmux.", ready=True):
        self.text, self.ready, self.calls = text, ready, []

    def load(self):
        self.ready = True

    def transcribe(self, audio):
        self.calls.append(len(audio))
        return self.text


def cfg(**over):
    env = {"PARAKEET_API_KEY": "secret"}
    env.update(over)
    return ServerConfig.from_env(env)


def run(engine, config, fn):
    async def go():
        app = create_app(config, engine, load_in_background=False)
        async with TestClient(TestServer(app)) as client:
            return await fn(client)
    return asyncio.run(go())


def form(audio: bytes, **fields):
    data = aiohttp.FormData()
    data.add_field("file", audio, filename="clip.webm", content_type="audio/webm")
    for k, v in fields.items():
        data.add_field(k, v)
    return data


AUTH = {"Authorization": "Bearer secret"}


def test_health_no_auth():
    async def fn(c):
        r = await c.get("/health")
        return r.status, await r.json()
    status, body = run(FakeEngine(), cfg(), fn)
    assert status == 200 and body["ready"] is True and body["model"] == "parakeet-tdt-0.6b-v2"


def test_health_503_while_loading():
    async def fn(c):
        r = await c.get("/health")
        return r.status, await r.json()
    status, body = run(FakeEngine(ready=False), cfg(), fn)
    assert status == 503 and body["ready"] is False


def test_models_requires_auth_and_lists_model():
    async def fn(c):
        bad = await c.get("/v1/models")
        good = await c.get("/v1/models", headers=AUTH)
        return bad.status, (await bad.json())["error"]["code"], await good.json()
    bad_status, code, good = run(FakeEngine(), cfg(), fn)
    assert bad_status == 401 and code == "invalid_api_key"
    assert good["data"][0]["id"] == "parakeet-tdt-0.6b-v2"


def test_transcribe_json_with_postprocessing():
    async def fn(c):
        r = await c.post("/v1/audio/transcriptions", headers=AUTH, data=form(encode_tone("webm"), model="parakeet-tdt-0.6b-v2", custom_words=json.dumps(["tmux"])))
        return r.status, await r.json()
    status, body = run(FakeEngine(), cfg(), fn)
    assert status == 200 and body == {"text": "Open tmux."}


def test_transcribe_whisper_alias_and_text_format():
    async def fn(c):
        r = await c.post("/v1/audio/transcriptions", headers=AUTH, data=form(encode_tone("mp4"), model="whisper-1", response_format="text", remove_fillers="false"))
        return r.status, r.headers["Content-Type"], await r.text()
    status, ctype, text = run(FakeEngine(), cfg(), fn)
    assert status == 200 and ctype.startswith("text/plain") and text == "Um, open Tmux."


def test_unknown_model_is_400():
    async def fn(c):
        r = await c.post("/v1/audio/transcriptions", headers=AUTH, data=form(encode_tone("webm"), model="gpt-4o-transcribe"))
        return r.status, (await r.json())["error"]["code"]
    assert run(FakeEngine(), cfg(), fn) == (400, "model_not_found")


def test_missing_file_is_400():
    async def fn(c):
        data = aiohttp.FormData()
        data.add_field("model", "whisper-1")
        r = await c.post("/v1/audio/transcriptions", headers=AUTH, data=data)
        return r.status, (await r.json())["error"]["code"]
    assert run(FakeEngine(), cfg(), fn) == (400, "missing_file")


def test_undecodable_audio_is_400():
    async def fn(c):
        r = await c.post("/v1/audio/transcriptions", headers=AUTH, data=form(b"nope" * 50))
        return r.status, (await r.json())["error"]["code"]
    assert run(FakeEngine(), cfg(), fn) == (400, "invalid_audio")


def test_too_long_audio_is_413():
    async def fn(c):
        r = await c.post("/v1/audio/transcriptions", headers=AUTH, data=form(encode_tone("webm", seconds=3.0)))
        return r.status, (await r.json())["error"]["code"]
    assert run(FakeEngine(), cfg(PARAKEET_MAX_SECONDS="2"), fn) == (413, "audio_too_long")


def test_oversized_upload_is_413():
    async def fn(c):
        r = await c.post("/v1/audio/transcriptions", headers=AUTH, data=form(b"\0" * (2 * 1024 * 1024)))
        return r.status, (await r.json())["error"]["code"]
    assert run(FakeEngine(), cfg(PARAKEET_MAX_UPLOAD_MB="1"), fn) == (413, "file_too_large")


def test_not_ready_is_503():
    async def fn(c):
        r = await c.post("/v1/audio/transcriptions", headers=AUTH, data=form(encode_tone("webm")))
        return r.status, (await r.json())["error"]["code"]
    assert run(FakeEngine(ready=False), cfg(), fn) == (503, "model_loading")


def test_silence_returns_empty_text():
    async def fn(c):
        r = await c.post("/v1/audio/transcriptions", headers=AUTH, data=form(encode_tone("webm")))
        return r.status, await r.json()
    assert run(FakeEngine(text=""), cfg(), fn) == (200, {"text": ""})


def test_engine_failure_is_500():
    class Boom(FakeEngine):
        def transcribe(self, audio):
            raise RuntimeError("onnx exploded")
    async def fn(c):
        r = await c.post("/v1/audio/transcriptions", headers=AUTH, data=form(encode_tone("webm")))
        return r.status, (await r.json())["error"]["code"]
    assert run(Boom(), cfg(), fn) == (500, "transcription_failed")


def test_loopback_without_key_needs_no_auth():
    async def fn(c):
        r = await c.get("/v1/models")
        return r.status
    assert run(FakeEngine(), ServerConfig.from_env({}), fn) == 200
