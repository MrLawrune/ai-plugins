import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).parent.parent / "hooks" / "scripts"


class Fake:
    def __init__(self, bb_active=False):
        self.bb_active = bb_active
        self.posts = []


@pytest.fixture
def fake_server():
    state = Fake()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _json(self, obj):
            body = json.dumps(obj).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/config":
                self._json({"config": {"voice": "af_sky", "speed": 1.0, "mode": "brief", "lang": "en-us",
                                       "working_sound": True, "attention_sound": True}, "muted": False})
            else:
                self._json({"status": "ok", "bb_plugin_active": state.bb_active})

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            state.posts.append((self.path, json.loads(self.rfile.read(n) or b"{}")))
            self._json({"action": "silent"})

    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    state.port = httpd.server_address[1]
    yield state
    httpd.shutdown()


def run_hook(name, payload, port, **env):
    base = {k: v for k, v in os.environ.items() if not k.startswith(("BB_", "KOKORO_"))}
    base.update({"KOKORO_PORT": str(port), **env})
    return subprocess.run(["bash", str(SCRIPTS / name)], input=json.dumps(payload),
                          capture_output=True, text=True, env=base, timeout=20)


def test_stop_sends_last_message_to_turn(fake_server):
    run_hook("tts-stop.sh", {"session_id": "s1", "last_assistant_message": "Hello there."}, fake_server.port)
    turns = [b for p, b in fake_server.posts if p == "/turn"]
    assert turns == [{"text": "Hello there.", "session_id": "s1", "playback": "server", "source": "claude-code"}]


def test_stop_forwards_env_overrides(fake_server):
    run_hook("tts-stop.sh", {"session_id": "s1", "last_assistant_message": "Hi."}, fake_server.port,
             KOKORO_MODE="verbose", KOKORO_SPEED="1.3")
    body = [b for p, b in fake_server.posts if p == "/turn"][0]
    assert body["mode"] == "verbose" and body["speed"] == 1.3


def test_stop_reads_transcript_when_no_last_message(fake_server, tmp_path):
    t = tmp_path / "t.jsonl"
    t.write_text(json.dumps({"type": "user", "message": {"content": [{"type": "text", "text": "q"}]}}) + "\n"
                 + json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Answer."}]}}) + "\n")
    run_hook("tts-stop.sh", {"session_id": "s1", "transcript_path": str(t)}, fake_server.port)
    body = [b for p, b in fake_server.posts if p == "/turn"][0]
    assert body["text"] == "Answer." and body["final_text"] == "Answer."


def test_guard_skips_when_bb_plugin_active(fake_server):
    fake_server.bb_active = True
    run_hook("tts-stop.sh", {"session_id": "s1", "last_assistant_message": "Hi."}, fake_server.port,
             BB_THREAD_ID="thr_x")
    assert [p for p, _ in fake_server.posts] == []


def test_guard_lets_the_hook_speak_when_bb_plugin_active_is_false(fake_server):
    run_hook("tts-stop.sh", {"session_id": "s1", "last_assistant_message": "Hi."}, fake_server.port,
             BB_THREAD_ID="thr_x")
    assert [p for p, _ in fake_server.posts] == ["/turn"]


def test_guard_ignored_outside_bb(fake_server):
    fake_server.bb_active = True
    run_hook("tts-stop.sh", {"session_id": "s1", "last_assistant_message": "Hi."}, fake_server.port)
    assert [p for p, _ in fake_server.posts] == ["/turn"]


def test_notification_uses_cue(fake_server):
    run_hook("tts-notification.sh", {"session_id": "s1"}, fake_server.port)
    assert fake_server.posts == [("/cue", {"sound": "attention", "session_id": "s1", "playback": "server"})]


def test_session_start_emits_no_contract_under_active_bb_plugin(fake_server):
    fake_server.bb_active = True
    r = run_hook("tts-session-start.sh", {}, fake_server.port, BB_THREAD_ID="thr_x")
    assert r.stdout.strip() == ""


def test_session_start_emits_contract_otherwise(fake_server):
    r = run_hook("tts-session-start.sh", {}, fake_server.port)
    assert "Voice Output" in json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]


def test_session_start_full_mode_gets_the_short_contract_without_blocks(fake_server):
    r = run_hook("tts-session-start.sh", {}, fake_server.port, KOKORO_MODE="full")
    ctx = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
    assert "whole reply is read aloud" in ctx
    assert "Do not add TTS_RESPONSE blocks" in ctx
    assert "weight=" not in ctx


@pytest.mark.parametrize("script,path", [("tts-interrupt.sh", "/interrupt"), ("tts-session-end.sh", "/cleanup")])
def test_guard_skips_posting_when_bb_plugin_active(fake_server, script, path):
    fake_server.bb_active = True
    run_hook(script, {"session_id": "s1"}, fake_server.port, BB_THREAD_ID="thr_x")
    assert fake_server.posts == []


@pytest.mark.parametrize("script,path", [("tts-interrupt.sh", "/interrupt"), ("tts-session-end.sh", "/cleanup")])
def test_guard_lets_hook_post_when_bb_plugin_active_is_false(fake_server, script, path):
    run_hook(script, {"session_id": "s1"}, fake_server.port, BB_THREAD_ID="thr_x")
    assert [p for p, _ in fake_server.posts] == [path]


def _free_port():
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_stop_with_server_down_points_at_bb_page_and_skill():
    r = run_hook("tts-stop.sh", {"session_id": "s1", "last_assistant_message": "Hi."}, _free_port())
    msg = json.loads(r.stdout)["systemMessage"]
    assert "In bb, open the Kokoro TTS page" in msg and "kokoro-tts skill, Troubleshooting" in msg
    assert "systemctl" not in msg


# --- model fetch (Claude Code-only installs) --------------------------------

import hashlib  # noqa: E402
import time  # noqa: E402


class Files:
    def __init__(self):
        self.files = {}
        self.gets = []


@pytest.fixture
def file_server():
    """Serves fixed bytes per path; ignores Range like python's http.server."""
    state = Files()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            state.gets.append((self.path, self.headers.get("Range")))
            body = state.files.get(self.path)
            if body is None:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    state.base = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield state
    httpd.shutdown()


def make_manifest(tmp_path, server, entries):
    """entries: {name: (served_bytes, expected_bytes)} -> manifest path."""
    files = []
    for name, (served, expected) in entries.items():
        server.files[f"/{name}"] = served
        files.append({"name": name, "url": f"{server.base}/{name}", "size": len(expected),
                      "sha256": hashlib.sha256(expected).hexdigest()})
    path = tmp_path / "models.json"
    path.write_text(json.dumps({"files": files}))
    return path


def run_fetch(manifest, data_dir):
    env = {k: v for k, v in os.environ.items() if not k.startswith("KOKORO_")}
    env.update({"KOKORO_MODELS_MANIFEST": str(manifest), "KOKORO_DATA_DIR": str(data_dir)})
    return subprocess.run(["bash", str(SCRIPTS / "tts-fetch-models.sh")], capture_output=True, text=True,
                          env=env, timeout=30)


MODEL = b"fake-onnx-model-" * 64
VOICES = b"fake-voices-" * 32


def test_fetch_models_downloads_verifies_and_marks(tmp_path, file_server):
    manifest = make_manifest(tmp_path, file_server, {"m.onnx": (MODEL, MODEL), "v.bin": (VOICES, VOICES)})
    data = tmp_path / "data"
    r = run_fetch(manifest, data)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (data / "m.onnx").read_bytes() == MODEL and (data / "v.bin").read_bytes() == VOICES
    assert (data / "m.onnx.sha256").read_text() == hashlib.sha256(MODEL).hexdigest()
    assert not list(data.glob("*.part")) and not (data / ".fetch-models.lock").exists()
    file_server.gets.clear()
    assert run_fetch(manifest, data).returncode == 0
    assert file_server.gets == []  # already verified: no download


def test_fetch_models_discards_a_checksum_mismatch(tmp_path, file_server):
    manifest = make_manifest(tmp_path, file_server, {"m.onnx": (b"x" * len(MODEL), MODEL)})
    data = tmp_path / "data"
    r = run_fetch(manifest, data)
    assert r.returncode == 1
    assert "checksum mismatch" in r.stdout
    assert not (data / "m.onnx").exists() and not (data / "m.onnx.part").exists()


def test_fetch_models_resumes_or_restarts_a_partial_download(tmp_path, file_server):
    manifest = make_manifest(tmp_path, file_server, {"m.onnx": (MODEL, MODEL)})
    data = tmp_path / "data"
    data.mkdir()
    (data / "m.onnx.part").write_bytes(MODEL[:100])
    r = run_fetch(manifest, data)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (data / "m.onnx").read_bytes() == MODEL
    assert file_server.gets[0] == ("/m.onnx", "bytes=100-")  # tried to resume first


def test_fetch_models_leaves_a_running_fetch_alone(tmp_path, file_server):
    manifest = make_manifest(tmp_path, file_server, {"m.onnx": (MODEL, MODEL)})
    data = tmp_path / "data"
    data.mkdir()
    (data / ".fetch-models.lock").write_text(str(os.getpid()))  # a live process
    r = run_fetch(manifest, data)
    assert r.returncode == 0 and "already running" in r.stdout
    assert file_server.gets == []


def test_fetch_models_takes_over_a_stale_lock(tmp_path, file_server):
    manifest = make_manifest(tmp_path, file_server, {"m.onnx": (MODEL, MODEL)})
    data = tmp_path / "data"
    data.mkdir()
    (data / ".fetch-models.lock").write_text("999999999")
    assert run_fetch(manifest, data).returncode == 0
    assert (data / "m.onnx").read_bytes() == MODEL


def test_fetch_models_concurrent_invocations_dont_corrupt_the_lock(tmp_path, file_server):
    """Regression test for the lock-acquisition race: several processes racing to
    create the lock at once must never leave more than one of them believing it
    holds the lock (the old mkdir-then-write-pid scheme could see an empty pid
    mid-creation and steal a lock that was never actually stale)."""
    manifest = make_manifest(tmp_path, file_server, {"m.onnx": (MODEL, MODEL)})
    data = tmp_path / "data"
    env = {k: v for k, v in os.environ.items() if not k.startswith("KOKORO_")}
    env.update({"KOKORO_MODELS_MANIFEST": str(manifest), "KOKORO_DATA_DIR": str(data)})
    procs = [subprocess.Popen(["bash", str(SCRIPTS / "tts-fetch-models.sh")], stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, env=env) for _ in range(8)]
    outs = [p.communicate(timeout=30)[0] for p in procs]
    assert all(p.returncode == 0 for p, out in zip(procs, outs)), outs
    assert (data / "m.onnx").read_bytes() == MODEL
    assert (data / "m.onnx.sha256").read_text() == hashlib.sha256(MODEL).hexdigest()
    assert not (data / ".fetch-models.lock").exists()


def _stub(dir_, name, body):
    p = dir_ / name
    p.write_text("#!/bin/bash\n" + body + "\n")
    p.chmod(0o755)
    return p


def session_start_env(tmp_path, manifest, data, uv):
    stubs = tmp_path / "stubs"
    stubs.mkdir(exist_ok=True)
    _stub(stubs, "systemctl", "exit 1")  # no systemd unit on this "machine"
    return {"PATH": f"{stubs}:{os.environ['PATH']}", "KOKORO_MODELS_MANIFEST": str(manifest),
            "KOKORO_DATA_DIR": str(data), "KOKORO_UV": str(uv)}


def test_session_start_fetches_missing_models_in_the_background(tmp_path, file_server):
    manifest = make_manifest(tmp_path, file_server, {"m.onnx": (MODEL, MODEL), "v.bin": (VOICES, VOICES)})
    data = tmp_path / "data"
    uv_log = tmp_path / "uv.log"
    uv = _stub(tmp_path, "uv", f'echo "$@" >> "{uv_log}"')
    r = run_hook("tts-session-start.sh", {}, _free_port(), **session_start_env(tmp_path, manifest, data, uv))
    out = json.loads(r.stdout)
    assert "Downloading the Kokoro voice model (about 355 MB) in the background" in out["systemMessage"]
    assert "Voice Output" in out["hookSpecificOutput"]["additionalContext"]
    for _ in range(100):
        if (data / "v.bin.sha256").exists():
            break
        time.sleep(0.1)
    assert (data / "m.onnx").read_bytes() == MODEL and (data / "v.bin").read_bytes() == VOICES
    assert not uv_log.exists()  # the server is not started until the models exist


def test_session_start_without_uv_and_with_models_present_says_how_to_install_it(tmp_path, file_server):
    manifest = make_manifest(tmp_path, file_server, {"m.onnx": (MODEL, MODEL)})
    data = tmp_path / "data"
    data.mkdir()
    (data / "m.onnx").write_bytes(MODEL)
    r = run_hook("tts-session-start.sh", {}, _free_port(),
                 **session_start_env(tmp_path, manifest, data, tmp_path / "no-uv"))
    msg = json.loads(r.stdout)["systemMessage"]
    assert "needs uv" in msg and "https://astral.sh/uv/install.sh" in msg
    assert "Downloading" not in msg  # models are already present: nothing to fetch
    assert file_server.gets == []


def test_session_start_without_uv_still_fetches_models_in_the_background(tmp_path, file_server):
    """The model fetch only needs curl + sha256sum + jq, not uv, so a clean
    machine missing both should not need a third session just to start the
    download once uv shows up."""
    manifest = make_manifest(tmp_path, file_server, {"m.onnx": (MODEL, MODEL), "v.bin": (VOICES, VOICES)})
    data = tmp_path / "data"
    r = run_hook("tts-session-start.sh", {}, _free_port(),
                 **session_start_env(tmp_path, manifest, data, tmp_path / "no-uv"))
    msg = json.loads(r.stdout)["systemMessage"]
    assert "needs uv" in msg and "https://astral.sh/uv/install.sh" in msg
    assert "Downloading the Kokoro voice model (about 355 MB) in the background" in msg
    for _ in range(100):
        if (data / "v.bin.sha256").exists():
            break
        time.sleep(0.1)
    assert (data / "m.onnx").read_bytes() == MODEL and (data / "v.bin").read_bytes() == VOICES


def test_session_start_starts_the_server_with_the_fetched_models(tmp_path, file_server):
    manifest = make_manifest(tmp_path, file_server, {"m.onnx": (MODEL, MODEL), "v.bin": (VOICES, VOICES)})
    data = tmp_path / "data"
    data.mkdir()
    (data / "m.onnx").write_bytes(MODEL)
    (data / "v.bin").write_bytes(VOICES)
    uv_log = tmp_path / "uv.log"
    uv = _stub(tmp_path, "uv", f'echo "$KOKORO_MODEL $KOKORO_VOICES $*" >> "{uv_log}"')
    r = run_hook("tts-session-start.sh", {}, _free_port(), **session_start_env(tmp_path, manifest, data, uv))
    assert "systemMessage" not in json.loads(r.stdout)
    for _ in range(50):
        if uv_log.exists():
            break
        time.sleep(0.1)
    model, voices, *args = uv_log.read_text().split()
    assert (model, voices) == (str(data / "m.onnx"), str(data / "v.bin"))
    assert args[:2] == ["run", "--project"] and args[-1].endswith("server/kokoro_server.py")
    assert file_server.gets == []
