import asyncio
import os
import sys
import time
import types
from collections import deque
from pathlib import Path

import pytest

os.environ["KOKORO_HEADLESS"] = "1"  # no sounddevice import in tests
sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

import kokoro_server as ks  # noqa: E402
from kokoro_config import ConfigStore  # noqa: E402

VOICES = ["af_sky", "af_bella"]


def make_server(tmp_path):
    srv = object.__new__(ks.KokoroServer)
    srv.config = ConfigStore(str(tmp_path / "config.json"), VOICES)
    srv.muted = False
    srv.speech_log = ks.SpeechLog(tmp_path / "log.jsonl")
    srv.active_playbacks = {}
    srv.cancel_events = {}
    srv.bb_plugin_seen = 0.0
    srv.model_path = "kokoro-v1.0.onnx"
    srv.started_at = time.time()
    srv.latency_samples = deque()
    srv.spoken_count = 0
    srv.last_first_audio_ms = None
    srv.engine = types.SimpleNamespace(info=lambda: {"kind": "local"})
    srv.calls = []

    async def fake_speech(text, data, session_id):
        srv.calls.append(("speech", text, session_id, data))
        return {"status": "playing", "session_id": session_id}, 200

    async def fake_sound(sound, session_id, volume=None):
        srv.calls.append(("sound", sound, session_id))
        return {"status": "playing", "sound": sound, "session_id": session_id}, 200

    srv._start_speech = fake_speech
    srv._start_sound = fake_sound
    return srv


def request(srv, method, path, body=None):
    async def go():
        async with TestClient(TestServer(ks.build_app(srv))) as c:
            r = await c.request(method, path, json=body)
            return r.status, await r.json()
    return asyncio.run(go())


BLOCK = '<!-- TTS_RESPONSE weight="speech"\nAll done.\nTTS_RESPONSE -->'


def test_turn_server_playback_speaks(tmp_path):
    srv = make_server(tmp_path)
    status, body = request(srv, "POST", "/turn", {"text": "x\n" + BLOCK, "session_id": "s1"})
    assert status == 200 and body["action"] == "speech"
    assert srv.calls == [("speech", "All done.", "s1", {})]


def test_turn_forwards_env_overrides(tmp_path):
    srv = make_server(tmp_path)
    request(srv, "POST", "/turn", {"text": BLOCK, "session_id": "s1", "voice": "af_bella", "speed": 1.2})
    assert srv.calls[0][3] == {"voice": "af_bella", "speed": 1.2}


def test_turn_client_playback_logs_without_playing(tmp_path):
    srv = make_server(tmp_path)
    status, body = request(srv, "POST", "/turn", {"text": BLOCK, "session_id": "t1", "playback": "client"})
    assert status == 200
    assert body["action"] == "speech" and body["text"] == "All done."
    assert isinstance(body["entry_id"], int) and body["speech_gain"] == 1.0
    assert srv.calls == []
    assert srv.speech_log.get(body["entry_id"])["status"] == "queued"


def test_turn_client_strip_to_empty_becomes_done(tmp_path):
    srv = make_server(tmp_path)
    blk = '<!-- TTS_RESPONSE weight="speech"\nhttps://example.com\nTTS_RESPONSE -->'
    _, body = request(srv, "POST", "/turn", {"text": blk, "playback": "client"})
    assert body["action"] == "sound" and body["sound"] == "done"


def test_turn_muted_is_silent(tmp_path):
    srv = make_server(tmp_path)
    srv.muted = True
    _, body = request(srv, "POST", "/turn", {"text": BLOCK})
    assert body == {"action": "silent", "muted": True} and srv.calls == []


def test_turn_mode_override(tmp_path):
    srv = make_server(tmp_path)
    _, body = request(srv, "POST", "/turn", {"text": BLOCK, "mode": "quiet"})
    assert body["action"] == "silent"


def test_turn_config_mode(tmp_path):
    srv = make_server(tmp_path)
    srv.config.patch({"mode": "ambient"})
    _, body = request(srv, "POST", "/turn", {"text": BLOCK, "playback": "client"})
    assert body["action"] == "sound" and body["sound"] == "attention"
    assert body["sound_volume"] == 1.0


def test_turn_empty_text_is_silent(tmp_path):
    srv = make_server(tmp_path)
    _, body = request(srv, "POST", "/turn", {"text": "   "})
    assert body == {"action": "silent"}


def test_turn_invalid_json_is_400(tmp_path):
    srv = make_server(tmp_path)

    async def go():
        async with TestClient(TestServer(ks.build_app(srv))) as c:
            r = await c.post("/turn", data="not json")
            return r.status
    assert asyncio.run(go()) == 400


def test_cue_server_plays(tmp_path):
    srv = make_server(tmp_path)
    _, body = request(srv, "POST", "/cue", {"sound": "attention", "session_id": "s1"})
    assert body["action"] == "sound" and srv.calls == [("sound", "attention", "s1")]


def test_cue_client_returns_volume(tmp_path):
    srv = make_server(tmp_path)
    srv.config.patch({"sound_volume": 0.5})
    _, body = request(srv, "POST", "/cue", {"sound": "attention", "playback": "client"})
    assert body == {"action": "sound", "sound": "attention", "sound_volume": 0.5}
    assert srv.calls == []


def test_cue_toggle_off_is_silent(tmp_path):
    srv = make_server(tmp_path)
    srv.config.patch({"attention_sound": False})
    _, body = request(srv, "POST", "/cue", {"sound": "attention"})
    assert body == {"action": "silent"}


def test_speech_log_status_updates_entry(tmp_path):
    srv = make_server(tmp_path)
    _, turn = request(srv, "POST", "/turn", {"text": BLOCK, "playback": "client"})
    status, _ = request(srv, "POST", "/speech-log/status",
                        {"id": turn["entry_id"], "status": "playing", "first_audio_ms": 420})
    assert status == 200
    entry = srv.speech_log.get(turn["entry_id"])
    assert entry["status"] == "playing" and entry["first_audio_ms"] == 420


def test_speech_log_status_rejects_bad_input(tmp_path):
    srv = make_server(tmp_path)
    assert request(srv, "POST", "/speech-log/status", {"id": 999, "status": "done"})[0] == 404
    assert request(srv, "POST", "/speech-log/status", {"id": 1, "status": "exploded"})[0] == 400


def test_bb_plugin_active_after_heartbeat(tmp_path):
    srv = make_server(tmp_path)
    request(srv, "POST", "/runtime", {"bb_plugin": True})
    _, health = request(srv, "GET", "/health")
    assert health["bb_plugin_active"] is True


def test_bb_plugin_active_expires_after_60_s(tmp_path):
    srv = make_server(tmp_path)
    srv.bb_plugin_seen = time.time() - 61
    _, health = request(srv, "GET", "/health")
    assert health["bb_plugin_active"] is False


def test_bb_plugin_false_clears_immediately(tmp_path):
    srv = make_server(tmp_path)
    request(srv, "POST", "/runtime", {"bb_plugin": True})
    request(srv, "POST", "/runtime", {"bb_plugin": False})
    _, health = request(srv, "GET", "/health")
    assert health["bb_plugin_active"] is False


def test_health_reports_no_output_device_when_headless(tmp_path):
    srv = make_server(tmp_path)
    _, health = request(srv, "GET", "/health")
    assert health["output_device_ok"] is False


def test_turn_server_playback_empty_after_strip_plays_done(tmp_path):
    srv = make_server(tmp_path)

    async def fake_speech(text, data, session_id):
        srv.calls.append(("speech", text, session_id, data))
        return {"status": "empty_after_strip"}, 200

    srv._start_speech = fake_speech
    status, body = request(srv, "POST", "/turn", {"text": BLOCK, "session_id": "s1"})
    assert status == 200
    assert body == {"action": "sound", "sound": "done"}
    assert ("sound", "done", "s1") in srv.calls


@pytest.mark.parametrize("path", ["/cue", "/speech-log/status", "/runtime"])
def test_non_object_body_is_400(tmp_path, path):
    srv = make_server(tmp_path)
    status, body = request(srv, "POST", path, [1, 2])
    assert status == 400 and body == {"error": "body must be an object"}


def test_synthesize_409_when_hop_reaches_remote_backed_node(tmp_path):
    srv = make_server(tmp_path)
    srv.engine = ks.RemoteEngine("http://localhost:9999", None)

    async def go():
        async with TestClient(TestServer(ks.build_app(srv))) as c:
            r = await c.post("/synthesize", json={"text": "hi"}, headers={"X-Kokoro-Hop": "1"})
            return r.status
    assert asyncio.run(go()) == 409


def request_with(srv, method, path, body=None, headers=None, host=None):
    async def go():
        async with TestClient(TestServer(ks.build_app(srv, host))) as c:
            r = await c.request(method, path, json=body, headers=headers or {})
            return r.status, await r.json()
    return asyncio.run(go())


def test_request_with_origin_header_is_403(tmp_path):
    srv = make_server(tmp_path)
    status, body = request_with(srv, "POST", "/turn", {"text": ""}, {"Origin": "https://evil.example"})
    assert status == 403 and "cross-origin" in body["error"]


def test_rebound_host_header_is_403_on_loopback(tmp_path):
    srv = make_server(tmp_path)
    status, _ = request_with(srv, "POST", "/turn", {"text": ""}, {"Host": "evil.example:6789"})
    assert status == 403


@pytest.mark.parametrize("host", ["127.0.0.1:6789", "localhost:6789", "[::1]:6789", "LOCALHOST"])
def test_loopback_host_headers_are_allowed(tmp_path, host):
    srv = make_server(tmp_path)
    status, body = request_with(srv, "POST", "/turn", {"text": ""}, {"Host": host})
    assert status == 200 and body == {"action": "silent"}


def test_lan_bind_accepts_any_host_but_still_refuses_origin(tmp_path):
    srv = make_server(tmp_path)
    status, _ = request_with(srv, "POST", "/turn", {"text": ""}, {"Host": "desk.lan:6789"}, host="0.0.0.0")
    assert status == 200
    status, _ = request_with(srv, "POST", "/turn", {"text": ""}, {"Origin": "http://desk.lan"}, host="0.0.0.0")
    assert status == 403


@pytest.mark.parametrize("body", [
    {"text": 5},
    {"text": ["a"]},
    {"text": {"a": 1}},
    {"text": "Done. " + BLOCK, "final_text": 7},
    {"text": "Done. " + BLOCK, "final_text": ["x"]},
])
def test_turn_non_string_text_is_silent(tmp_path, body):
    srv = make_server(tmp_path)
    status, resp = request(srv, "POST", "/turn", body)
    assert status == 200 and resp == {"action": "silent"}
    assert srv.calls == []


def test_turn_non_string_mode_falls_back_to_config(tmp_path):
    srv = make_server(tmp_path)
    status, body = request(srv, "POST", "/turn", {"text": "x\n" + BLOCK, "mode": ["verbose"], "session_id": "s1"})
    assert status == 200 and body["action"] == "speech"


def test_turn_full_mode_reads_the_cleaned_reply_to_the_client(tmp_path):
    srv = make_server(tmp_path)
    reply = ("## Result\n\nThe **build** passed; see [the log](https://ci.example/run/1) "
             "and `dist/app.js`.\n\n```sh\nnpm test\n```\n\n- One fix\n- Two tests\n" + BLOCK)
    status, body = request(srv, "POST", "/turn", {"text": reply, "mode": "full", "playback": "client", "session_id": "s1"})
    assert status == 200 and body["action"] == "speech"
    text = body["text"]
    assert text.startswith("Result. The build passed; see the log and app.js.")
    assert "Code block skipped." in text and "One fix." in text and "Two tests." in text
    assert "http" not in text and "dist/" not in text and "All done." not in text
