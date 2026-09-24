# parakeet-stt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handy-style dictation for bb backed by a self-hosted, OpenAI-compatible Parakeet STT server, plus bb's built-in mic routed to the same server.

**Architecture:** A Python aiohttp server (`server/`) decodes any browser audio with PyAV and transcribes with onnx-asr Parakeet TDT 0.6B v2 int8 on CPU. A bb plugin (`bb/`) records in the composer, sends audio over plugin RPC to its backend, which calls the server; the plugin also registers AI service `parakeet` whose `bb.host` entry serves bb's built-in mic.

**Tech Stack:** Python ≥3.11, uv, aiohttp, onnx-asr 0.12, onnxruntime (CPU), PyAV, pytest; TypeScript (strict), bb plugin SDK 0.5.9, zod 4, React 19, node:test.

**Spec:** `docs/superpowers/specs/2026-09-24-parakeet-stt-design.md`

## Global Constraints

- Plugin dir: `plugins/parakeet-stt`; plugin id `parakeet-stt`; AI service id `parakeet`; model id `parakeet-tdt-0.6b-v2`; onnx-asr model name `nemo-parakeet-tdt-0.6b-v2`, quantization `int8`.
- `engines`: `"bb": ">=0.43"`, `"bbPluginSdk": ">=0.5.9"`; devDependency `@get-bb/plugin-sdk` exactly `0.5.9`.
- Server code (`bb/server.ts` and everything it imports) must NOT import `@get-bb/plugin-sdk/ai-services`; only `bb/host.ts`/`bb/host-contract.ts` may.
- Server defaults: host `127.0.0.1`, port `6790`; refuses non-loopback bind without `PARAKEET_API_KEY`.
- Limits: upload 25 MiB, decoded duration 600 s, VAD cutover 90 s, queue wait 60 s; UI auto-stop 5 min; plugin transcribe timeout 120 s.
- Post-processing defaults: `remove_fillers=true`, `correction_threshold=0.18`; fillers `um uh uhm er erm ah hmm mm`.
- Error body shape: `{"error":{"message","type","code"}}`.
- The repo is public: no LAN IPs, hostnames, or keys in `plugins/` or `docs/superpowers/`. Lab specifics live in the admin runbook (Task 12).
- Conventional commits, scope `parakeet-stt`.

## Review Focus

1. Silent or empty recording → server returns `{"text":""}`; the UI says "No speech detected" and leaves the draft untouched. (Task 4 route test, Task 9 controller test)
2. Server not configured / unreachable / wrong key → plugin RPC fails with a readable message, bb's built-in mic gets `auth_required` or `service_unavailable` instead of hanging. (Task 5 client tests, Task 7 host tests)
3. Mic permission denied or no input device → toast with the browser's reason; controller returns to idle and a second press works. (Task 9 controller test)
4. Phone locks / tab hidden mid-recording → captured audio still transcribed and a notice shown. (Task 9 controller test)
5. Keyboard: `Esc` is only intercepted while recording; the shortcut is only swallowed when it matches exactly (no extra modifiers). (Task 9 shortcut tests)

---

### Task 1: Server scaffold + text post-processing

**Files:**
- Create: `plugins/parakeet-stt/server/pyproject.toml`
- Create: `plugins/parakeet-stt/server/parakeet_text.py`
- Create: `plugins/parakeet-stt/tests/conftest.py`
- Create: `plugins/parakeet-stt/tests/test_text.py`
- Create: `plugins/parakeet-stt/.gitignore`

**Interfaces:**
- Produces: `remove_fillers(text: str) -> str`, `apply_custom_words(text: str, words: list[str], threshold: float) -> str`, `postprocess(text: str, *, custom_words: list[str], remove_fillers_: bool, threshold: float) -> str`, `FILLERS: frozenset[str]`.

- [ ] **Step 1: Scaffold**

`plugins/parakeet-stt/.gitignore`:
```
dist/
node_modules/
.venv/
.pytest_cache/
__pycache__/
```

`plugins/parakeet-stt/server/pyproject.toml`:
```toml
[project]
name = "parakeet-stt-server"
version = "0.1.0"
description = "OpenAI-compatible Parakeet speech-to-text server for bb and other clients"
requires-python = ">=3.11,<3.14"
dependencies = [
    "aiohttp>=3.9.0",
    "av>=14.0",
    "numpy>=1.24.0",
    "onnx-asr[hub]==0.12.0",
]

[dependency-groups]
cpu = ["onnxruntime>=1.20,!=1.24.1,!=1.25.*,!=1.26.0"]

[tool.uv]
default-groups = ["cpu"]
```

`plugins/parakeet-stt/tests/conftest.py`:
```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "server"))
```

- [ ] **Step 2: Write the failing tests** — `tests/test_text.py`:
```python
from parakeet_text import apply_custom_words, postprocess, remove_fillers


def test_remove_fillers_drops_standalone_fillers_and_recapitalizes():
    assert remove_fillers("Um, so I think, uh, we should ship it.") == "So I think, we should ship it."


def test_remove_fillers_keeps_words_containing_filler_letters():
    assert remove_fillers("The umbrella is here.") == "The umbrella is here."


def test_remove_fillers_moves_sentence_end_to_previous_word():
    assert remove_fillers("Ship it um.") == "Ship it."


def test_remove_fillers_all_fillers_yields_empty():
    assert remove_fillers("Um. Uh.") == ""


def test_custom_word_fixes_case():
    assert apply_custom_words("Please open the Tmux session.", ["tmux"], 0.18) == "Please open the tmux session."


def test_custom_word_fuzzy_single_token():
    assert apply_custom_words("Plug in the yubikee now", ["Yubikey"], 0.18) == "Plug in the Yubikey now"


def test_custom_word_multi_token_window():
    assert apply_custom_words("edit the claude dot md file", ["CLAUDE.md"], 0.18) == "edit the CLAUDE.md file"


def test_custom_word_preserves_punctuation():
    assert apply_custom_words("I use Tmux, daily.", ["tmux"], 0.18) == "I use tmux, daily."


def test_custom_word_threshold_blocks_distant_words():
    assert apply_custom_words("the clawed config", ["Claude"], 0.18) == "the clawed config"


def test_custom_word_ignores_very_short_words():
    assert apply_custom_words("go to it", ["gt"], 0.5) == "go to it"


def test_postprocess_runs_both_steps():
    out = postprocess("Um, open Tmux.", custom_words=["tmux"], remove_fillers_=True, threshold=0.18)
    assert out == "Open tmux."


def test_postprocess_can_skip_fillers():
    out = postprocess("Um, open it.", custom_words=[], remove_fillers_=False, threshold=0.18)
    assert out == "Um, open it."
```

Spoken punctuation: a window replaces standalone `dot` tokens with `.` before normalizing, so `claude dot md` and `CLAUDE.md` both normalize to `claudemd` (distance 0). Only `dot` is handled.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd plugins/parakeet-stt && uv run --project server --with pytest pytest tests/test_text.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'parakeet_text'`

- [ ] **Step 4: Implement** — `server/parakeet_text.py`:
```python
"""Transcript post-processing: filler removal and custom-word correction (Handy parity)."""
from __future__ import annotations

import re

FILLERS = frozenset({"um", "uh", "uhm", "er", "erm", "ah", "hmm", "mm"})
_EDGE_PUNCT = ".,!?;:"
_SENTENCE_END = ".!?"
_MIN_WORD_CORE = 3


def _core(token: str) -> str:
    return token.strip(_EDGE_PUNCT + "\"'()").lower()


def remove_fillers(text: str) -> str:
    kept: list[str] = []
    for token in text.split():
        if _core(token) in FILLERS:
            end = token[-1] if token[-1] in _SENTENCE_END else ""
            if end and kept and kept[-1][-1] not in _EDGE_PUNCT:
                kept[-1] += end
            continue
        kept.append(token)
    if not kept:
        return ""
    out = " ".join(kept)
    out = re.sub(r"^[,;:]\s*", "", out)
    return out[:1].upper() + out[1:]


def _levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _norm(s: str) -> str:
    return re.sub(r"[^0-9a-z]", "", s.lower())


def _window_core(tokens: list[str]) -> str:
    return _norm("".join("." if _core(t) == "dot" else t for t in tokens))


def apply_custom_words(text: str, words: list[str], threshold: float) -> str:
    targets = [(w, _norm(w)) for w in words if len(_norm(w)) >= _MIN_WORD_CORE]
    if not targets:
        return text
    tokens = text.split(" ")
    out: list[str] = []
    i = 0
    while i < len(tokens):
        best: tuple[float, int, str] | None = None  # (distance ratio, -n, word)
        for n in (3, 2, 1):
            window = tokens[i : i + n]
            if len(window) < n:
                continue
            core = _window_core(window)
            if len(core) < _MIN_WORD_CORE:
                continue
            for word, wcore in targets:
                ratio = _levenshtein(core, wcore) / max(len(core), len(wcore))
                if ratio <= threshold and (best is None or (ratio, -n) < (best[0], best[1])):
                    best = (ratio, -n, word)
        if best is None:
            out.append(tokens[i])
            i += 1
            continue
        n = -best[1]
        first, last = tokens[i], tokens[i + n - 1]
        lead = first[: len(first) - len(first.lstrip(_EDGE_PUNCT + "\"'("))]
        trail = last[len(last.rstrip(_EDGE_PUNCT + "\"')")) :]
        out.append(f"{lead}{best[2]}{trail}")
        i += n
    return " ".join(out)


def postprocess(text: str, *, custom_words: list[str], remove_fillers_: bool, threshold: float) -> str:
    text = text.strip()
    if remove_fillers_:
        text = remove_fillers(text)
    return apply_custom_words(text, custom_words, threshold)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/parakeet-stt && uv run --project server --with pytest pytest tests/test_text.py -q`
Expected: 12 passed.

- [ ] **Step 6: Commit**
```bash
git add plugins/parakeet-stt/.gitignore plugins/parakeet-stt/server/pyproject.toml plugins/parakeet-stt/server/uv.lock plugins/parakeet-stt/server/parakeet_text.py plugins/parakeet-stt/tests
git commit -m "feat(parakeet-stt): server scaffold and transcript post-processing"
```

---

### Task 2: Audio decoding

**Files:**
- Create: `plugins/parakeet-stt/server/parakeet_audio.py`
- Create: `plugins/parakeet-stt/tests/audio_fixtures.py`
- Create: `plugins/parakeet-stt/tests/test_audio.py`

**Interfaces:**
- Produces: `SAMPLE_RATE = 16000`, `class AudioDecodeError(Exception)`, `decode_to_mono16k(data: bytes) -> numpy.ndarray[float32]`; test helper `encode_tone(container: str, seconds: float = 1.0) -> bytes` for `"webm" | "ogg" | "mp4" | "wav"`.

- [ ] **Step 1: Test helper** — `tests/audio_fixtures.py`:
```python
import io

import av
import numpy as np

FORMATS = {
    "webm": ("libopus", "flt", 48000),
    "ogg": ("libopus", "flt", 48000),
    "mp4": ("aac", "fltp", 44100),
    "wav": ("pcm_s16le", "s16", 48000),
}


def encode_tone(container: str, seconds: float = 1.0, amplitude: float = 0.3) -> bytes:
    codec, fmt, rate = FORMATS[container]
    t = np.arange(int(rate * seconds)) / rate
    samples = (amplitude * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    if fmt == "s16":
        samples = (samples * 32767).astype(np.int16)
    buf = io.BytesIO()
    out = av.open(buf, "w", format=container)
    stream = out.add_stream(codec, rate=rate, layout="mono")
    step = stream.codec_context.frame_size or 1024
    for i in range(0, len(samples), step):
        frame = av.AudioFrame.from_ndarray(samples[i : i + step].reshape(1, -1), format=fmt, layout="mono")
        frame.sample_rate = rate
        for packet in stream.encode(frame):
            out.mux(packet)
    for packet in stream.encode(None):
        out.mux(packet)
    out.close()
    return buf.getvalue()
```

- [ ] **Step 2: Write the failing tests** — `tests/test_audio.py`:
```python
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
```

- [ ] **Step 3: Run to verify failure**

Run: `uv run --project server --with pytest pytest tests/test_audio.py -q`
Expected: FAIL — `No module named 'parakeet_audio'`

- [ ] **Step 4: Implement** — `server/parakeet_audio.py`:
```python
"""Decode any browser recording (webm/opus, ogg, mp4/aac, wav, mp3) to 16 kHz mono float32."""
from __future__ import annotations

import io

import av
import numpy as np

SAMPLE_RATE = 16000


class AudioDecodeError(Exception):
    pass


def decode_to_mono16k(data: bytes) -> np.ndarray:
    if not data:
        raise AudioDecodeError("empty audio")
    try:
        with av.open(io.BytesIO(data)) as container:
            if not container.streams.audio:
                raise AudioDecodeError("no audio stream")
            resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)
            chunks: list[np.ndarray] = []
            for frame in container.decode(audio=0):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1))
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray().reshape(-1))
    except av.error.FFmpegError as exc:
        raise AudioDecodeError(f"could not decode audio: {exc}") from exc
    if not chunks:
        raise AudioDecodeError("no audio frames")
    return np.concatenate(chunks).astype(np.float32, copy=False)
```

- [ ] **Step 5: Run to verify pass**

Run: `uv run --project server --with pytest pytest tests/test_audio.py -q`
Expected: 6 passed.

- [ ] **Step 6: Commit**
```bash
git add plugins/parakeet-stt/server/parakeet_audio.py plugins/parakeet-stt/tests/audio_fixtures.py plugins/parakeet-stt/tests/test_audio.py
git commit -m "feat(parakeet-stt): decode browser audio formats with PyAV"
```

---

### Task 3: Config + engine

**Files:**
- Create: `plugins/parakeet-stt/server/parakeet_config.py`
- Create: `plugins/parakeet-stt/server/parakeet_engine.py`
- Create: `plugins/parakeet-stt/tests/test_config.py`
- Create: `plugins/parakeet-stt/tests/test_engine_integration.py`
- Create: `plugins/parakeet-stt/tests/fixtures/speech.webm` (Kokoro-generated, synthetic)

**Interfaces:**
- Produces: `@dataclass(frozen=True) class ServerConfig(host, port, api_key, model, quantization, threads, max_upload_bytes, max_seconds, vad_above_seconds, queue_timeout_s)`, `ServerConfig.from_env(env: Mapping[str,str]) -> ServerConfig`, `ServerConfig.model_id -> str` (model without `nemo-` prefix), `ConfigError(Exception)`, `is_loopback(host: str) -> bool`; `class ParakeetEngine(cfg)` with `model_id: str`, `ready: bool`, `load() -> None`, `transcribe(audio: np.ndarray) -> str`.

- [ ] **Step 1: Write the failing tests** — `tests/test_config.py`:
```python
import pytest

from parakeet_config import ConfigError, ServerConfig, is_loopback


def test_defaults():
    cfg = ServerConfig.from_env({})
    assert (cfg.host, cfg.port) == ("127.0.0.1", 6790)
    assert cfg.model == "nemo-parakeet-tdt-0.6b-v2"
    assert cfg.model_id == "parakeet-tdt-0.6b-v2"
    assert cfg.quantization == "int8"
    assert cfg.max_upload_bytes == 25 * 1024 * 1024
    assert (cfg.max_seconds, cfg.vad_above_seconds, cfg.queue_timeout_s) == (600, 90, 60)
    assert cfg.api_key is None


def test_non_loopback_requires_key():
    with pytest.raises(ConfigError, match="PARAKEET_API_KEY"):
        ServerConfig.from_env({"PARAKEET_HOST": "0.0.0.0"})
    cfg = ServerConfig.from_env({"PARAKEET_HOST": "0.0.0.0", "PARAKEET_API_KEY": "k"})
    assert cfg.api_key == "k"


def test_bad_number_is_config_error():
    with pytest.raises(ConfigError, match="PARAKEET_PORT"):
        ServerConfig.from_env({"PARAKEET_PORT": "abc"})


@pytest.mark.parametrize("host,expected", [("127.0.0.1", True), ("localhost", True), ("::1", True), ("0.0.0.0", False), ("10.1.2.3", False)])
def test_is_loopback(host, expected):
    assert is_loopback(host) is expected
```

`tests/test_engine_integration.py`:
```python
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
```

- [ ] **Step 2: Create the speech fixture** (synthetic; uses the local Kokoro server's `/synthesize`, 24 kHz float32 frames with a 4-byte LE length prefix):
```bash
cd plugins/parakeet-stt && mkdir -p tests/fixtures && python3 - <<'EOF'
import json, struct, urllib.request
req = urllib.request.Request("http://127.0.0.1:6789/synthesize", data=json.dumps({"text": "Please open the tmux session and check the Claude config file before lunch."}).encode(), headers={"Content-Type": "application/json"})
buf = urllib.request.urlopen(req, timeout=60).read(); pcm = bytearray(); i = 0
while i + 4 <= len(buf):
    n = struct.unpack("<I", buf[i:i+4])[0]; pcm += buf[i+4:i+4+n]; i += 4 + n
open("/tmp/speech.f32", "wb").write(pcm)
EOF
ffmpeg -loglevel error -y -f f32le -ar 24000 -ac 1 -i /tmp/speech.f32 -c:a libopus -b:a 24k tests/fixtures/speech.webm && ls -la tests/fixtures/speech.webm
```
Expected: a ~15 KB file.

- [ ] **Step 3: Run to verify failure**

Run: `uv run --project server --with pytest pytest tests/test_config.py -q`
Expected: FAIL — `No module named 'parakeet_config'`

- [ ] **Step 4: Implement** — `server/parakeet_config.py`:
```python
"""Server settings from environment variables."""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from typing import Mapping


class ConfigError(Exception):
    pass


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _int(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer, got {raw!r}") from exc


@dataclass(frozen=True)
class ServerConfig:
    host: str
    port: int
    api_key: str | None
    model: str
    quantization: str | None
    threads: int
    max_upload_bytes: int
    max_seconds: int
    vad_above_seconds: int
    queue_timeout_s: int

    @property
    def model_id(self) -> str:
        return self.model.removeprefix("nemo-").split("/")[-1]

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "ServerConfig":
        host = env.get("PARAKEET_HOST") or "127.0.0.1"
        api_key = env.get("PARAKEET_API_KEY") or None
        if not is_loopback(host) and not api_key:
            raise ConfigError("PARAKEET_API_KEY is required when PARAKEET_HOST is not a loopback address")
        return cls(
            host=host,
            port=_int(env, "PARAKEET_PORT", 6790),
            api_key=api_key,
            model=env.get("PARAKEET_MODEL") or "nemo-parakeet-tdt-0.6b-v2",
            quantization=(env.get("PARAKEET_QUANTIZATION", "int8") or None),
            threads=_int(env, "PARAKEET_THREADS", 0),
            max_upload_bytes=_int(env, "PARAKEET_MAX_UPLOAD_MB", 25) * 1024 * 1024,
            max_seconds=_int(env, "PARAKEET_MAX_SECONDS", 600),
            vad_above_seconds=_int(env, "PARAKEET_VAD_ABOVE_SECONDS", 90),
            queue_timeout_s=_int(env, "PARAKEET_QUEUE_TIMEOUT", 60),
        )
```

`server/parakeet_engine.py`:
```python
"""Parakeet model wrapper: whole-clip decoding for short audio, VAD segmentation for long audio."""
from __future__ import annotations

import logging

import numpy as np

from parakeet_audio import SAMPLE_RATE
from parakeet_config import ServerConfig

log = logging.getLogger("parakeet.engine")


class ParakeetEngine:
    def __init__(self, cfg: ServerConfig) -> None:
        self._cfg = cfg
        self.model_id = cfg.model_id
        self.ready = False
        self._model = None
        self._vad_model = None

    def load(self) -> None:
        import onnx_asr
        import onnxruntime as ort

        opts = ort.SessionOptions()
        if self._cfg.threads > 0:
            opts.intra_op_num_threads = self._cfg.threads
        self._model = onnx_asr.load_model(self._cfg.model, quantization=self._cfg.quantization, sess_options=opts)
        self._vad_model = self._model.with_vad(onnx_asr.load_vad("silero"))
        self.ready = True
        log.info("loaded %s (%s)", self._cfg.model, self._cfg.quantization or "fp32")

    def transcribe(self, audio: np.ndarray) -> str:
        if not self.ready or self._model is None or self._vad_model is None:
            raise RuntimeError("model not loaded")
        if len(audio) <= self._cfg.vad_above_seconds * SAMPLE_RATE:
            return str(self._model.recognize(audio, sample_rate=SAMPLE_RATE)).strip()
        parts = (seg.text.strip() for seg in self._vad_model.recognize(audio, sample_rate=SAMPLE_RATE))
        return " ".join(p for p in parts if p)
```

- [ ] **Step 5: Run to verify pass**

Run: `uv run --project server --with pytest pytest tests/test_config.py tests/test_engine_integration.py -q`
Expected: 8 passed, 1 skipped. Then `PARAKEET_INTEGRATION=1 uv run --project server --with pytest pytest tests/test_engine_integration.py -q` → 1 passed (first run downloads the model, ~35 s).

- [ ] **Step 6: Commit**
```bash
git add plugins/parakeet-stt/server/parakeet_config.py plugins/parakeet-stt/server/parakeet_engine.py plugins/parakeet-stt/tests/test_config.py plugins/parakeet-stt/tests/test_engine_integration.py plugins/parakeet-stt/tests/fixtures/speech.webm
git commit -m "feat(parakeet-stt): env config and Parakeet engine with VAD cutover"
```

---

### Task 4: HTTP server

**Files:**
- Create: `plugins/parakeet-stt/server/parakeet_server.py`
- Create: `plugins/parakeet-stt/tests/test_server_routes.py`

**Interfaces:**
- Consumes: `ServerConfig`, `ConfigError`, `decode_to_mono16k`, `AudioDecodeError`, `postprocess`, engine duck type (`model_id`, `ready`, `load()`, `transcribe(np.ndarray) -> str`).
- Produces: `SERVER_VERSION = "0.1.0"`; `create_app(cfg: ServerConfig, engine, *, load_in_background: bool = True) -> web.Application`; `main() -> None`. HTTP contract per spec.

- [ ] **Step 1: Write the failing tests** — `tests/test_server_routes.py`:
```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run --project server --with pytest pytest tests/test_server_routes.py -q`
Expected: FAIL — `No module named 'parakeet_server'`

- [ ] **Step 3: Implement** — `server/parakeet_server.py`:
```python
"""OpenAI-compatible speech-to-text HTTP server backed by Parakeet."""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import sys
import time

from aiohttp import web

from parakeet_audio import SAMPLE_RATE, AudioDecodeError, decode_to_mono16k
from parakeet_config import ConfigError, ServerConfig
from parakeet_text import postprocess

SERVER_VERSION = "0.1.0"
MODEL_ALIASES = {"whisper-1"}
log = logging.getLogger("parakeet.server")

CFG = web.AppKey("cfg", ServerConfig)
ENGINE = web.AppKey("engine", object)
LOCK = web.AppKey("lock", asyncio.Lock)
STARTED = web.AppKey("started", float)


def error(status: int, code: str, message: str, kind: str = "invalid_request_error") -> web.Response:
    return web.json_response({"error": {"message": message, "type": kind, "code": code}}, status=status)


@web.middleware
async def errors_and_auth(request: web.Request, handler):
    cfg = request.app[CFG]
    if request.path.startswith("/v1/") and cfg.api_key:
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        if not hmac.compare_digest(token.encode(), cfg.api_key.encode()):
            return error(401, "invalid_api_key", "Invalid or missing API key", "authentication_error")
    try:
        return await handler(request)
    except web.HTTPRequestEntityTooLarge:
        return error(413, "file_too_large", f"Upload exceeds {cfg.max_upload_bytes // (1024 * 1024)} MiB")
    except web.HTTPException as exc:
        return error(exc.status, "http_error", exc.reason)


async def health(request: web.Request) -> web.Response:
    engine = request.app[ENGINE]
    body = {
        "status": "ok" if engine.ready else "loading",
        "version": SERVER_VERSION,
        "model": engine.model_id,
        "ready": engine.ready,
        "uptime_s": round(time.time() - request.app[STARTED]),
    }
    return web.json_response(body, status=200 if engine.ready else 503)


async def models(request: web.Request) -> web.Response:
    engine = request.app[ENGINE]
    return web.json_response({"object": "list", "data": [{"id": engine.model_id, "object": "model", "owned_by": "nvidia"}]})


def _bool(value: str | None, default: bool) -> bool:
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


async def transcriptions(request: web.Request) -> web.Response:
    cfg, engine = request.app[CFG], request.app[ENGINE]
    form = await request.post()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "file"):
        return error(400, "missing_file", "Multipart field 'file' is required")
    model = str(form.get("model") or engine.model_id)
    if model != engine.model_id and model not in MODEL_ALIASES:
        return error(400, "model_not_found", f"Unknown model {model!r}; use {engine.model_id!r}")
    try:
        custom_words = json.loads(str(form.get("custom_words") or "[]"))
        if not isinstance(custom_words, list) or not all(isinstance(w, str) for w in custom_words):
            raise ValueError
        threshold = float(form.get("correction_threshold") or 0.18)
    except ValueError:
        return error(400, "invalid_parameter", "custom_words must be a JSON string array; correction_threshold a number")
    if not engine.ready:
        return error(503, "model_loading", "Model is still loading; retry shortly", "server_error")
    try:
        audio = decode_to_mono16k(upload.file.read())
    except AudioDecodeError as exc:
        return error(400, "invalid_audio", str(exc))
    if len(audio) > cfg.max_seconds * SAMPLE_RATE:
        return error(413, "audio_too_long", f"Audio exceeds {cfg.max_seconds} s")
    lock = request.app[LOCK]
    try:
        await asyncio.wait_for(lock.acquire(), timeout=cfg.queue_timeout_s)
    except TimeoutError:
        return error(503, "busy", "Server busy; retry shortly", "server_error")
    started = time.perf_counter()
    try:
        raw = await asyncio.get_running_loop().run_in_executor(None, engine.transcribe, audio)
    except Exception as exc:  # engine errors are opaque onnxruntime failures
        log.exception("transcription failed")
        return error(500, "transcription_failed", f"Transcription failed: {exc}", "server_error")
    finally:
        lock.release()
    text = postprocess(raw, custom_words=custom_words, remove_fillers_=_bool(form.get("remove_fillers"), True), threshold=threshold)
    log.info("transcribed %.1fs audio in %.0f ms (%d chars)", len(audio) / SAMPLE_RATE, (time.perf_counter() - started) * 1000, len(text))
    if str(form.get("response_format") or "json") == "text":
        return web.Response(text=text, content_type="text/plain")
    return web.json_response({"text": text})


def create_app(cfg: ServerConfig, engine, *, load_in_background: bool = True) -> web.Application:
    app = web.Application(client_max_size=cfg.max_upload_bytes, middlewares=[errors_and_auth])
    app[CFG], app[ENGINE], app[LOCK], app[STARTED] = cfg, engine, asyncio.Lock(), time.time()
    app.router.add_get("/health", health)
    app.router.add_get("/v1/models", models)
    app.router.add_post("/v1/audio/transcriptions", transcriptions)

    if load_in_background:
        async def start_loading(app: web.Application) -> None:
            async def load() -> None:
                try:
                    await asyncio.get_running_loop().run_in_executor(None, engine.load)
                except Exception:
                    log.exception("model load failed")
                    os._exit(1)  # let systemd restart us
            app["loader"] = asyncio.create_task(load())
        app.on_startup.append(start_loading)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    try:
        cfg = ServerConfig.from_env(os.environ)
    except ConfigError as exc:
        print(f"parakeet-stt: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
    from parakeet_engine import ParakeetEngine

    web.run_app(create_app(cfg, ParakeetEngine(cfg)), host=cfg.host, port=cfg.port, access_log=None)


if __name__ == "__main__":
    main()
```

Note: `app["loader"]` uses a string key — change it to a `web.AppKey("loader", asyncio.Task)` if aiohttp warns.

- [ ] **Step 4: Run to verify pass**

Run: `uv run --project server --with pytest pytest tests -q`
Expected: all pass (text 12, audio 6, config 8, routes 14), integration skipped.

- [ ] **Step 5: Smoke test the real server**

```bash
cd plugins/parakeet-stt/server && PARAKEET_PORT=6790 uv run python parakeet_server.py &
until curl -sf localhost:6790/health; do sleep 2; done; echo
curl -s -F file=@../tests/fixtures/speech.webm -F model=whisper-1 -F 'custom_words=["tmux","Claude"]' localhost:6790/v1/audio/transcriptions; echo
kill %1
```
Expected: `{"text": "Please open the tmux session and check the ... config file before lunch."}`

- [ ] **Step 6: Commit**
```bash
git add plugins/parakeet-stt/server/parakeet_server.py plugins/parakeet-stt/tests/test_server_routes.py
git commit -m "feat(parakeet-stt): OpenAI-compatible transcription server"
```

---

### Task 5: Plugin scaffold + STT client

**Files:**
- Create: `plugins/parakeet-stt/package.json`, `tsconfig.json`, `components.json`
- Create: `plugins/parakeet-stt/bb/stt-client.ts`, `bb/stt-client.test.ts`
- Copy: `plugins/kokoro-tts/assets/{working,done,attention,error}.wav` → `plugins/parakeet-stt/assets/{start,stop,cancel,error}.wav`; create `assets/icon.svg`

**Interfaces:**
- Produces:
  ```ts
  export type SttErrorCode = "not_configured" | "unreachable" | "timeout" | "unauthorized" | "bad_request" | "unavailable" | "server_error" | "invalid_response";
  export class SttError extends Error { readonly code: SttErrorCode; readonly status: number | null }
  export interface SttConfig { serverUrl: string; apiKey: string }
  export interface TranscribeOptions { customWords: string[]; removeFillers: boolean; correctionThreshold: number; timeoutMs: number; signal?: AbortSignal }
  export interface SttHealth { status: string; version: string; model: string; ready: boolean; uptime_s: number }
  export interface SttClient { health(timeoutMs?: number): Promise<SttHealth>; transcribe(audio: Uint8Array, mimeType: string, filename: string, opts: TranscribeOptions): Promise<string> }
  export function createSttClient(config: SttConfig, fetchImpl?: typeof fetch): SttClient
  export type AiFailureCode = "timeout" | "rate_limited" | "service_unavailable" | "auth_required" | "request_failed" | "invalid_response";
  export function aiFailure(err: unknown): { ok: false; code: AiFailureCode; message: string }
  export const MODEL_ID = "parakeet-tdt-0.6b-v2";
  ```

- [ ] **Step 1: Scaffold.** `package.json`:
```json
{
  "name": "bb-plugin-parakeet-stt",
  "version": "0.1.0",
  "type": "module",
  "engines": { "bb": ">=0.43", "bbPluginSdk": ">=0.5.9" },
  "bb": {
    "name": "Parakeet STT",
    "description": "Dictate to your agents: Handy-style speech-to-text for every BB composer, powered by your own Parakeet server.",
    "branding": { "icon": "./assets/icon.svg" },
    "server": "./bb/server.ts",
    "host": "./bb/host.ts",
    "app": "./bb/app.tsx"
  },
  "scripts": {
    "test": "node --test \"bb/**/*.test.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "description": "BB dictation plugin for the Parakeet STT server"
}
```
Copy `dependencies` and `devDependencies` verbatim from `plugins/kokoro-tts/package.json`, then `npm install`. Copy `tsconfig.json` and `components.json` verbatim from kokoro-tts. `assets/icon.svg`: a 24×24 microphone glyph (stroke `currentColor`), e.g.:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>
```

- [ ] **Step 2: Write the failing tests** — `bb/stt-client.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { aiFailure, createSttClient, SttError } from "./stt-client.ts";

const cfg = { serverUrl: "https://stt.example/", apiKey: "k" };
const opts = { customWords: ["tmux"], removeFillers: true, correctionThreshold: 0.18, timeoutMs: 1000 };
const audio = new Uint8Array([1, 2, 3]);

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  return { f, calls };
}

test("transcribe posts multipart with auth and extensions", async () => {
  const { f, calls } = fakeFetch(() => Response.json({ text: "hello" }));
  const text = await createSttClient(cfg, f).transcribe(audio, "audio/webm", "clip.webm", opts);
  assert.equal(text, "hello");
  assert.equal(calls[0].url, "https://stt.example/v1/audio/transcriptions");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer k");
  const body = calls[0].init.body as FormData;
  assert.equal(body.get("model"), "parakeet-tdt-0.6b-v2");
  assert.equal(body.get("custom_words"), '["tmux"]');
  assert.equal(body.get("remove_fillers"), "true");
  assert.equal((body.get("file") as File).type, "audio/webm");
});

test("not configured when serverUrl empty", async () => {
  const { f } = fakeFetch(() => Response.json({}));
  await assert.rejects(createSttClient({ serverUrl: "", apiKey: "" }, f).transcribe(audio, "a", "b", opts), (e: SttError) => e.code === "not_configured");
});

for (const [status, code] of [[401, "unauthorized"], [400, "bad_request"], [413, "bad_request"], [503, "unavailable"], [500, "server_error"]] as const) {
  test(`HTTP ${status} -> ${code}, message from error body`, async () => {
    const { f } = fakeFetch(() => Response.json({ error: { message: `m${status}`, type: "x", code: "y" } }, { status }));
    await assert.rejects(createSttClient(cfg, f).transcribe(audio, "a", "b", opts), (e: SttError) => e.code === code && e.status === status && e.message.includes(`m${status}`));
  });
}

test("network failure -> unreachable", async () => {
  const f = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(createSttClient(cfg, f).transcribe(audio, "a", "b", opts), (e: SttError) => e.code === "unreachable");
});

test("timeout -> timeout", async () => {
  const f = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
  await assert.rejects(createSttClient(cfg, f).transcribe(audio, "a", "b", { ...opts, timeoutMs: 20 }), (e: SttError) => e.code === "timeout");
});

test("missing text -> invalid_response", async () => {
  const { f } = fakeFetch(() => Response.json({ nope: 1 }));
  await assert.rejects(createSttClient(cfg, f).transcribe(audio, "a", "b", opts), (e: SttError) => e.code === "invalid_response");
});

test("empty text is a valid result", async () => {
  const { f } = fakeFetch(() => Response.json({ text: "" }));
  assert.equal(await createSttClient(cfg, f).transcribe(audio, "a", "b", opts), "");
});

test("health hits /health without auth requirement", async () => {
  const { f, calls } = fakeFetch(() => Response.json({ status: "ok", version: "0.1.0", model: "parakeet-tdt-0.6b-v2", ready: true, uptime_s: 3 }));
  const h = await createSttClient(cfg, f).health();
  assert.equal(h.ready, true);
  assert.equal(calls[0].url, "https://stt.example/health");
});

test("aiFailure maps codes", () => {
  const cases: [string, string][] = [["not_configured", "auth_required"], ["unauthorized", "auth_required"], ["unreachable", "service_unavailable"], ["unavailable", "service_unavailable"], ["server_error", "service_unavailable"], ["timeout", "timeout"], ["bad_request", "request_failed"], ["invalid_response", "invalid_response"]];
  for (const [from, to] of cases) {
    assert.equal(aiFailure(new SttError(from as never, "x", null)).code, to);
  }
  assert.equal(aiFailure(new Error("boom")).code, "service_unavailable");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd plugins/parakeet-stt && node --test bb/stt-client.test.ts`
Expected: FAIL — cannot find module `./stt-client.ts`

- [ ] **Step 4: Implement** — `bb/stt-client.ts`:
```ts
// Typed client for the Parakeet STT server. Shared by the server entry and the host entry.
export const MODEL_ID = "parakeet-tdt-0.6b-v2";

export type SttErrorCode =
  | "not_configured" | "unreachable" | "timeout" | "unauthorized"
  | "bad_request" | "unavailable" | "server_error" | "invalid_response";

export class SttError extends Error {
  readonly code: SttErrorCode;
  readonly status: number | null;
  constructor(code: SttErrorCode, message: string, status: number | null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface SttConfig { serverUrl: string; apiKey: string }
export interface TranscribeOptions {
  customWords: string[];
  removeFillers: boolean;
  correctionThreshold: number;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface SttHealth { status: string; version: string; model: string; ready: boolean; uptime_s: number }
export interface SttClient {
  health(timeoutMs?: number): Promise<SttHealth>;
  transcribe(audio: Uint8Array, mimeType: string, filename: string, opts: TranscribeOptions): Promise<string>;
}

function codeForStatus(status: number): SttErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 503) return "unavailable";
  if (status >= 500) return "server_error";
  return "bad_request";
}

export function createSttClient(config: SttConfig, fetchImpl: typeof fetch = fetch): SttClient {
  const base = config.serverUrl.trim().replace(/\/+$/, "");

  async function request(path: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal): Promise<unknown> {
    if (!base) throw new SttError("not_configured", "Parakeet STT server URL is not set", null);
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    const relay = () => ctl.abort();
    outer?.addEventListener("abort", relay, { once: true });
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { ...init, signal: ctl.signal });
    } catch (cause) {
      if (timedOut) throw new SttError("timeout", `Parakeet STT server did not answer within ${timeoutMs} ms`, null);
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new SttError("unreachable", `Parakeet STT server unreachable at ${base} (${reason})`, null);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", relay);
    }
    let data: unknown = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const msg = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
      throw new SttError(codeForStatus(res.status), `Parakeet STT: ${msg}`, res.status);
    }
    return data;
  }

  const auth = (): Record<string, string> => (config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {});

  return {
    async health(timeoutMs = 4000) {
      const data = await request("/health", { method: "GET", headers: auth() }, timeoutMs);
      return data as SttHealth;
    },
    async transcribe(audio, mimeType, filename, opts) {
      const form = new FormData();
      form.set("file", new File([audio], filename, { type: mimeType }));
      form.set("model", MODEL_ID);
      form.set("custom_words", JSON.stringify(opts.customWords));
      form.set("remove_fillers", String(opts.removeFillers));
      form.set("correction_threshold", String(opts.correctionThreshold));
      const data = await request("/v1/audio/transcriptions", { method: "POST", headers: auth(), body: form }, opts.timeoutMs, opts.signal);
      const text = (data as { text?: unknown } | null)?.text;
      if (typeof text !== "string") throw new SttError("invalid_response", "Parakeet STT returned no text", null);
      return text;
    },
  };
}

export type AiFailureCode = "timeout" | "rate_limited" | "service_unavailable" | "auth_required" | "request_failed" | "invalid_response";

const AI_CODE: Record<SttErrorCode, AiFailureCode> = {
  not_configured: "auth_required",
  unauthorized: "auth_required",
  unreachable: "service_unavailable",
  unavailable: "service_unavailable",
  server_error: "service_unavailable",
  timeout: "timeout",
  bad_request: "request_failed",
  invalid_response: "invalid_response",
};

export function aiFailure(err: unknown): { ok: false; code: AiFailureCode; message: string } {
  if (err instanceof SttError) return { ok: false, code: AI_CODE[err.code], message: err.message || err.code };
  return { ok: false, code: "service_unavailable", message: err instanceof Error && err.message ? err.message : "Parakeet STT failed" };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test bb/stt-client.test.ts && npx tsc --noEmit`
Expected: all tests pass; tsc clean.

- [ ] **Step 6: Commit**
```bash
git add plugins/parakeet-stt/package.json plugins/parakeet-stt/package-lock.json plugins/parakeet-stt/tsconfig.json plugins/parakeet-stt/components.json plugins/parakeet-stt/assets plugins/parakeet-stt/bb/stt-client.ts plugins/parakeet-stt/bb/stt-client.test.ts
git commit -m "feat(parakeet-stt): plugin scaffold and typed STT client"
```

---

### Task 6: Schemas, prefs, history

**Files:**
- Create: `plugins/parakeet-stt/bb/schemas.ts`, `bb/prefs.ts`, `bb/prefs.test.ts`, `bb/history.ts`, `bb/history.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // schemas.ts
  export const SHORTCUTS = ["ctrl+space", "alt+space", "ctrl+shift+space", "off"] as const;
  export const prefsSchema: z.ZodObject<...>; export type Prefs = z.infer<typeof prefsSchema>;
  export const historyEntrySchema; export type HistoryEntry = { id: string; text: string; at: number; durationMs: number };
  export const healthResultSchema; export type HealthResult = { configured: boolean; up: boolean; model: string | null; version: string | null; error: string | null; lastLatencyMs: number | null };
  export const rpcContract  // health, transcribe, getPrefs, setPrefs, listHistory, clearHistory
  export const SOUNDS = ["start", "stop", "cancel", "error"] as const; export type SoundName = typeof SOUNDS[number];
  // prefs.ts
  export const DEFAULT_PREFS: Prefs; export interface KvLike; export class PrefsStore { load(); get(); update(patch); onChange(l) }
  // history.ts
  export class HistoryStore { constructor(kv: KvLike, limit: () => number, now?: () => number, id?: () => string); list(): Promise<HistoryEntry[]>; add(text: string, durationMs: number): Promise<void>; clear(): Promise<void> }
  ```

- [ ] **Step 1: Write the failing tests** — `bb/prefs.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS, PrefsStore, type KvLike } from "./prefs.ts";

export function memKv(initial: Record<string, unknown> = {}): KvLike & { data: Record<string, unknown> } {
  const data = { ...initial };
  return { data, async get<T>(k: string) { return data[k] as T | undefined; }, async set(k, v) { data[k] = v; } };
}

test("defaults mirror Handy settings", () => {
  assert.equal(DEFAULT_PREFS.shortcut, "ctrl+space");
  assert.equal(DEFAULT_PREFS.autoSubmit, false);
  assert.equal(DEFAULT_PREFS.removeFillers, true);
  assert.equal(DEFAULT_PREFS.correctionThreshold, 0.18);
  assert.equal(DEFAULT_PREFS.historyLimit, 5);
});

test("load keeps valid stored prefs and drops invalid ones", async () => {
  const store = new PrefsStore(memKv({ prefs: { autoSubmit: true, customWords: ["tmux"] } }));
  const p = await store.load();
  assert.equal(p.autoSubmit, true);
  assert.deepEqual(p.customWords, ["tmux"]);
  const bad = new PrefsStore(memKv({ prefs: { shortcut: "f13" } }));
  assert.deepEqual(await bad.load(), DEFAULT_PREFS);
});

test("update validates, persists, notifies", async () => {
  const kv = memKv();
  const store = new PrefsStore(kv);
  await store.load();
  const seen: boolean[] = [];
  store.onChange((n) => seen.push(n.autoSubmit));
  await store.update({ autoSubmit: true });
  assert.deepEqual(seen, [true]);
  assert.equal((kv.data.prefs as { autoSubmit: boolean }).autoSubmit, true);
  await assert.rejects(store.update({ correctionThreshold: 2 }));
  assert.equal(store.get().correctionThreshold, 0.18);
});

test("custom words are trimmed and de-duplicated", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  const p = await store.update({ customWords: [" tmux ", "tmux", "", "CLAUDE.md"] });
  assert.deepEqual(p.customWords, ["tmux", "CLAUDE.md"]);
});
```

`bb/history.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryStore } from "./history.ts";
import { memKv } from "./prefs.test.ts";

test("keeps newest first and trims to limit", async () => {
  let t = 0, n = 0;
  const h = new HistoryStore(memKv(), () => 2, () => ++t, () => `id${++n}`);
  await h.add("a", 10); await h.add("b", 20); await h.add("c", 30);
  assert.deepEqual((await h.list()).map((e) => e.text), ["c", "b"]);
});

test("limit 0 stores nothing; blank text is skipped; clear empties", async () => {
  const h0 = new HistoryStore(memKv(), () => 0);
  await h0.add("a", 1);
  assert.deepEqual(await h0.list(), []);
  const h = new HistoryStore(memKv(), () => 5);
  await h.add("   ", 1);
  assert.deepEqual(await h.list(), []);
  await h.add("x", 1);
  await h.clear();
  assert.deepEqual(await h.list(), []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test bb/prefs.test.ts bb/history.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement** — `bb/schemas.ts`:
```ts
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const SHORTCUTS = ["ctrl+space", "alt+space", "ctrl+shift+space", "off"] as const;
export const SOUNDS = ["start", "stop", "cancel", "error"] as const;
export type SoundName = (typeof SOUNDS)[number];

const customWordsSchema = z
  .array(z.string().max(64))
  .max(200)
  .transform((words) => [...new Set(words.map((w) => w.trim()).filter(Boolean))]);

export const prefsSchema = z.object({
  shortcut: z.enum(SHORTCUTS),
  holdToTalk: z.boolean(),
  autoSubmit: z.boolean(),
  trailingSpace: z.boolean(),
  soundCues: z.boolean(),
  customWords: customWordsSchema,
  removeFillers: z.boolean(),
  correctionThreshold: z.number().min(0).max(0.5),
  historyLimit: z.number().int().min(0).max(50),
}).strict();
export type Prefs = z.output<typeof prefsSchema>;

export const historyEntrySchema = z.object({ id: z.string(), text: z.string(), at: z.number(), durationMs: z.number() });
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const healthResultSchema = z.object({
  configured: z.boolean(),
  up: z.boolean(),
  model: z.string().nullable(),
  version: z.string().nullable(),
  error: z.string().nullable(),
  lastLatencyMs: z.number().nullable(),
});
export type HealthResult = z.infer<typeof healthResultSchema>;

export const rpcContract = defineRpcContract({
  health: { input: z.null(), output: healthResultSchema },
  transcribe: {
    input: z.object({ audioBase64: z.string().min(1), mimeType: z.string().min(1), filename: z.string().min(1) }).strict(),
    output: z.object({ text: z.string(), durationMs: z.number() }),
  },
  getPrefs: { input: z.null(), output: prefsSchema },
  setPrefs: { input: z.object(prefsSchema.shape).partial().strict(), output: prefsSchema },
  listHistory: { input: z.null(), output: z.object({ entries: z.array(historyEntrySchema) }) },
  clearHistory: { input: z.null(), output: z.object({ cleared: z.literal(true) }) },
});
```

`bb/prefs.ts`:
```ts
import { prefsSchema, type Prefs } from "./schemas.ts";

export const DEFAULT_PREFS: Prefs = {
  shortcut: "ctrl+space",
  holdToTalk: false,
  autoSubmit: false,
  trailingSpace: false,
  soundCues: true,
  customWords: [],
  removeFillers: true,
  correctionThreshold: 0.18,
  historyLimit: 5,
};

export interface KvLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

type Listener = (next: Prefs, prev: Prefs) => void;

export class PrefsStore {
  #kv: KvLike;
  #cache: Prefs = DEFAULT_PREFS;
  #listeners = new Set<Listener>();

  constructor(kv: KvLike) {
    this.#kv = kv;
  }

  async load(): Promise<Prefs> {
    const parsed = prefsSchema.safeParse({ ...DEFAULT_PREFS, ...((await this.#kv.get<object>("prefs")) ?? {}) });
    this.#cache = parsed.success ? parsed.data : DEFAULT_PREFS;
    return this.#cache;
  }

  get(): Prefs {
    return this.#cache;
  }

  async update(patch: Partial<Prefs>): Promise<Prefs> {
    const next = prefsSchema.parse({ ...this.#cache, ...patch });
    const prev = this.#cache;
    await this.#kv.set("prefs", next);
    this.#cache = next;
    for (const l of this.#listeners) l(next, prev);
    return next;
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
```

`bb/history.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { KvLike } from "./prefs.ts";
import { historyEntrySchema, type HistoryEntry } from "./schemas.ts";

export class HistoryStore {
  #kv: KvLike;
  #limit: () => number;
  #now: () => number;
  #id: () => string;

  constructor(kv: KvLike, limit: () => number, now: () => number = Date.now, id: () => string = randomUUID) {
    this.#kv = kv;
    this.#limit = limit;
    this.#now = now;
    this.#id = id;
  }

  async list(): Promise<HistoryEntry[]> {
    const parsed = historyEntrySchema.array().safeParse((await this.#kv.get<unknown>("history")) ?? []);
    return parsed.success ? parsed.data.slice(0, this.#limit()) : [];
  }

  async add(text: string, durationMs: number): Promise<void> {
    if (!text.trim() || this.#limit() === 0) return;
    const entry: HistoryEntry = { id: this.#id(), text, at: this.#now(), durationMs };
    await this.#kv.set("history", [entry, ...(await this.list())].slice(0, this.#limit()));
  }

  async clear(): Promise<void> {
    await this.#kv.set("history", []);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test bb/prefs.test.ts bb/history.test.ts && npx tsc --noEmit`
Expected: pass; tsc clean.

- [ ] **Step 5: Commit**
```bash
git add plugins/parakeet-stt/bb/schemas.ts plugins/parakeet-stt/bb/prefs.ts plugins/parakeet-stt/bb/prefs.test.ts plugins/parakeet-stt/bb/history.ts plugins/parakeet-stt/bb/history.test.ts
git commit -m "feat(parakeet-stt): prefs, history, and RPC schemas"
```

---

### Task 7: Host entry (bb built-in mic)

**Files:**
- Create: `plugins/parakeet-stt/bb/configure-contract.ts`, `bb/host-contract.ts`, `bb/host-handlers.ts`, `bb/host-handlers.test.ts`, `bb/host.ts`

**Interfaces:**
- Consumes: `createSttClient`, `aiFailure`, `MODEL_ID` (Task 5).
- Produces:
  ```ts
  // configure-contract.ts (server-safe; no ai-services import)
  export const hostConfigSchema; export type HostConfig = { serverUrl: string; apiKey: string; customWords: string[]; removeFillers: boolean; correctionThreshold: number };
  export const configureContract = defineRpcContract({ "stt.configure": { input: hostConfigSchema, output: { ok: true } } });
  // host-contract.ts (host only)
  export const hostContract = { ...experimental_aiServicesHostContract, ...configureContract };
  // host-handlers.ts
  export async function writeHostConfig(dataDir: string, config: HostConfig): Promise<void>;
  export async function readHostConfig(dataDir: string): Promise<HostConfig | null>;
  export async function handleTranscribe(input: VoiceInput, dataDir: string, fetchImpl?: typeof fetch): Promise<VoiceOutput>;
  ```

- [ ] **Step 1: Write the failing tests** — `bb/host-handlers.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handleTranscribe, readHostConfig, writeHostConfig } from "./host-handlers.ts";

const config = { serverUrl: "https://stt.example", apiKey: "k", customWords: ["tmux"], removeFillers: true, correctionThreshold: 0.18 };
const input = { serviceId: "parakeet", model: "parakeet-tdt-0.6b-v2", audioBase64: Buffer.from("abc").toString("base64"), mimeType: "audio/webm", filename: "voice.webm", prompt: null, timeoutMs: 10_000 };
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "stt-host-"));

test("config round-trips with 0600 permissions", async () => {
  const dir = await tmp();
  await writeHostConfig(path.join(dir, "nested"), config);
  assert.deepEqual(await readHostConfig(path.join(dir, "nested")), config);
  const st = await fs.stat(path.join(dir, "nested", "config.json"));
  assert.equal(st.mode & 0o777, 0o600);
});

test("missing or corrupt config reads as null", async () => {
  const dir = await tmp();
  assert.equal(await readHostConfig(dir), null);
  await fs.writeFile(path.join(dir, "config.json"), "{nope");
  assert.equal(await readHostConfig(dir), null);
});

test("transcribe without config -> auth_required", async () => {
  const out = await handleTranscribe(input, await tmp());
  assert.deepEqual(out.ok, false);
  assert.equal(!out.ok && out.code, "auth_required");
});

test("transcribe forwards decoded audio and prefs", async () => {
  const dir = await tmp();
  await writeHostConfig(dir, config);
  let seen: FormData | null = null;
  const f = (async (_u: string, init?: RequestInit) => { seen = init!.body as FormData; return Response.json({ text: "hi" }); }) as typeof fetch;
  const out = await handleTranscribe(input, dir, f);
  assert.deepEqual(out, { ok: true, model: "parakeet-tdt-0.6b-v2", text: "hi" });
  const file = seen!.get("file") as File;
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "abc");
  assert.equal(seen!.get("custom_words"), '["tmux"]');
});

test("server 503 -> service_unavailable (retryable)", async () => {
  const dir = await tmp();
  await writeHostConfig(dir, config);
  const f = (async () => Response.json({ error: { message: "loading" } }, { status: 503 })) as typeof fetch;
  const out = await handleTranscribe(input, dir, f);
  assert.equal(!out.ok && out.code, "service_unavailable");
});

test("timeout budget leaves headroom under bb's timeoutMs", async () => {
  const dir = await tmp();
  await writeHostConfig(dir, config);
  const f = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
  const started = Date.now();
  const out = await handleTranscribe({ ...input, timeoutMs: 600 }, dir, f);
  assert.equal(!out.ok && out.code, "timeout");
  assert.ok(Date.now() - started < 600);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test bb/host-handlers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `bb/configure-contract.ts`:
```ts
// Host-config RPC shared by server.ts (client) and host.ts (handler). Must stay free of
// @get-bb/plugin-sdk/ai-services: the bb server runtime cannot resolve that subpath.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostConfigSchema = z.object({
  serverUrl: z.string(),
  apiKey: z.string(),
  customWords: z.array(z.string()),
  removeFillers: z.boolean(),
  correctionThreshold: z.number(),
}).strict();
export type HostConfig = z.infer<typeof hostConfigSchema>;

export const configureContract = defineRpcContract({
  "stt.configure": { input: hostConfigSchema, output: z.object({ ok: z.literal(true) }).strict() },
});
```

`bb/host-contract.ts`:
```ts
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_aiServicesHostContract } from "@get-bb/plugin-sdk/ai-services";
import { configureContract } from "./configure-contract.ts";

export const hostContract = defineRpcContract({ ...experimental_aiServicesHostContract, ...configureContract });
```

`bb/host-handlers.ts`:
```ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hostConfigSchema, type HostConfig } from "./configure-contract.ts";
import { aiFailure, createSttClient, SttError, type AiFailureCode } from "./stt-client.ts";

export interface VoiceInput {
  serviceId: string; model: string; audioBase64: string; mimeType: string; filename: string; prompt: string | null; timeoutMs: number;
}
export type VoiceOutput = { ok: true; model: string; text: string } | { ok: false; code: AiFailureCode; message: string };

const CONFIG_FILE = "config.json";
/** bb retries within its own budget; answer before it gives up so our code wins over a generic timeout. */
const HEADROOM_MS = 250;

export async function writeHostConfig(dataDir: string, config: HostConfig): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const target = path.join(dataDir, CONFIG_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config), { mode: 0o600 });
  await fs.rename(tmp, target);
}

export async function readHostConfig(dataDir: string): Promise<HostConfig | null> {
  try {
    const parsed = hostConfigSchema.safeParse(JSON.parse(await fs.readFile(path.join(dataDir, CONFIG_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function handleTranscribe(input: VoiceInput, dataDir: string, fetchImpl: typeof fetch = fetch): Promise<VoiceOutput> {
  const config = await readHostConfig(dataDir);
  if (!config || !config.serverUrl) return aiFailure(new SttError("not_configured", "parakeet-stt is not configured (set serverUrl in the plugin settings)", null));
  try {
    const text = await createSttClient(config, fetchImpl).transcribe(
      Buffer.from(input.audioBase64, "base64"),
      input.mimeType,
      input.filename,
      {
        customWords: config.customWords,
        removeFillers: config.removeFillers,
        correctionThreshold: config.correctionThreshold,
        timeoutMs: Math.max(100, input.timeoutMs - HEADROOM_MS),
      },
    );
    return { ok: true, model: input.model, text };
  } catch (err) {
    return aiFailure(err);
  }
}
```

`bb/host.ts`:
```ts
// bb.host entry: serves bb's built-in voice button (AI service "parakeet") and stores the
// server-pushed config, since host code cannot read plugin settings.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract.ts";
import { handleTranscribe, writeHostConfig } from "./host-handlers.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    "ai.inference.complete": async () => ({ ok: false, code: "request_failed", message: "parakeet serves voice transcription only" }),
    "ai.voice.transcribe": async (input, context) => handleTranscribe(input, context.experimental_paths.dataDir),
    "stt.configure": async (input, context) => {
      await writeHostConfig(context.experimental_paths.dataDir, input);
      return { ok: true };
    },
  },
});
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test bb/host-handlers.test.ts && npx tsc --noEmit`
Expected: pass; tsc clean.

- [ ] **Step 5: Commit**
```bash
git add plugins/parakeet-stt/bb/configure-contract.ts plugins/parakeet-stt/bb/host-contract.ts plugins/parakeet-stt/bb/host-handlers.ts plugins/parakeet-stt/bb/host-handlers.test.ts plugins/parakeet-stt/bb/host.ts
git commit -m "feat(parakeet-stt): host entry serving bb's built-in voice button"
```

---

### Task 8: Server entry + RPC

**Files:**
- Create: `plugins/parakeet-stt/bb/rpc.ts`, `bb/rpc.test.ts`, `bb/server.ts`

**Interfaces:**
- Consumes: Tasks 5–7 (`createSttClient`, `PrefsStore`, `HistoryStore`, `rpcContract`, `configureContract`, `HostConfig`, `SOUNDS`).
- Produces: `export const TRANSCRIBE_TIMEOUT_MS = 120_000`; `export function createRpcHandlers(deps: RpcDeps)` returning the object passed to `bb.rpc.register(rpcContract, …)`; `RpcDeps = { client: () => SttClient; configured: () => boolean; prefs: PrefsStore; history: HistoryStore; now: () => number }`; `export function hostConfigFrom(settings: { serverUrl: string; apiKey: string }, prefs: Prefs): HostConfig`.

- [ ] **Step 1: Write the failing tests** — `bb/rpc.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryStore } from "./history.ts";
import { DEFAULT_PREFS, PrefsStore } from "./prefs.ts";
import { memKv } from "./prefs.test.ts";
import { createRpcHandlers, hostConfigFrom } from "./rpc.ts";
import { SttError, type SttClient } from "./stt-client.ts";

async function setup(client: Partial<SttClient>, configured = true) {
  const kv = memKv();
  const prefs = new PrefsStore(kv);
  await prefs.load();
  await prefs.update({ customWords: ["tmux"] });
  const history = new HistoryStore(kv, () => prefs.get().historyLimit);
  let t = 1000;
  const handlers = createRpcHandlers({ client: () => client as SttClient, configured: () => configured, prefs, history, now: () => (t += 50) });
  return { handlers, history };
}

test("transcribe decodes base64, applies prefs, records history", async () => {
  let got: { bytes: string; words: string[] } | null = null;
  const { handlers, history } = await setup({
    async transcribe(audio, _m, _f, opts) { got = { bytes: Buffer.from(audio).toString(), words: opts.customWords }; return "hello"; },
  });
  const out = await handlers.transcribe({ audioBase64: Buffer.from("abc").toString("base64"), mimeType: "audio/webm", filename: "x.webm" });
  assert.equal(out.text, "hello");
  assert.equal(out.durationMs, 50);
  assert.deepEqual(got, { bytes: "abc", words: ["tmux"] });
  assert.deepEqual((await history.list()).map((e) => e.text), ["hello"]);
});

test("empty transcript is returned but not stored", async () => {
  const { handlers, history } = await setup({ async transcribe() { return ""; } });
  assert.equal((await handlers.transcribe({ audioBase64: "YQ==", mimeType: "a", filename: "b" })).text, "");
  assert.deepEqual(await history.list(), []);
});

test("transcribe errors surface the server message", async () => {
  const { handlers } = await setup({ async transcribe() { throw new SttError("unauthorized", "Parakeet STT: Invalid or missing API key", 401); } });
  await assert.rejects(handlers.transcribe({ audioBase64: "YQ==", mimeType: "a", filename: "b" }), /Invalid or missing API key/);
});

test("health reports not configured without calling the server", async () => {
  const { handlers } = await setup({ async health() { throw new Error("should not be called"); } }, false);
  const h = await handlers.health();
  assert.equal(h.configured, false);
  assert.equal(h.up, false);
});

test("health reports server errors as down", async () => {
  const { handlers } = await setup({ async health() { throw new SttError("unreachable", "unreachable at x", null); } });
  const h = await handlers.health();
  assert.deepEqual([h.configured, h.up, h.error], [true, false, "unreachable at x"]);
});

test("hostConfigFrom merges settings and prefs", () => {
  const cfg = hostConfigFrom({ serverUrl: "u", apiKey: "k" }, { ...DEFAULT_PREFS, customWords: ["a"], removeFillers: false, correctionThreshold: 0.2 });
  assert.deepEqual(cfg, { serverUrl: "u", apiKey: "k", customWords: ["a"], removeFillers: false, correctionThreshold: 0.2 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test bb/rpc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `bb/rpc.ts`:
```ts
import type { HostConfig } from "./configure-contract.ts";
import type { HistoryStore } from "./history.ts";
import type { PrefsStore } from "./prefs.ts";
import type { HealthResult, Prefs } from "./schemas.ts";
import type { SttClient } from "./stt-client.ts";

export const TRANSCRIBE_TIMEOUT_MS = 120_000;

export interface RpcDeps {
  client: () => SttClient;
  configured: () => boolean;
  prefs: PrefsStore;
  history: HistoryStore;
  now: () => number;
}

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

export function hostConfigFrom(settings: { serverUrl: string; apiKey: string }, prefs: Prefs): HostConfig {
  return {
    serverUrl: settings.serverUrl,
    apiKey: settings.apiKey,
    customWords: prefs.customWords,
    removeFillers: prefs.removeFillers,
    correctionThreshold: prefs.correctionThreshold,
  };
}

export function createRpcHandlers(deps: RpcDeps) {
  let lastLatencyMs: number | null = null;
  return {
    async health(): Promise<HealthResult> {
      if (!deps.configured()) return { configured: false, up: false, model: null, version: null, error: null, lastLatencyMs };
      try {
        const h = await deps.client().health();
        return { configured: true, up: h.ready, model: h.model, version: h.version, error: h.ready ? null : "model loading", lastLatencyMs };
      } catch (e) {
        return { configured: true, up: false, model: null, version: null, error: message(e), lastLatencyMs };
      }
    },
    async transcribe(input: { audioBase64: string; mimeType: string; filename: string }) {
      const p = deps.prefs.get();
      const started = deps.now();
      const text = await deps.client().transcribe(Buffer.from(input.audioBase64, "base64"), input.mimeType, input.filename, {
        customWords: p.customWords,
        removeFillers: p.removeFillers,
        correctionThreshold: p.correctionThreshold,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      });
      const durationMs = deps.now() - started;
      lastLatencyMs = durationMs;
      await deps.history.add(text, durationMs);
      return { text, durationMs };
    },
    async getPrefs() { return deps.prefs.get(); },
    async setPrefs(patch: Partial<Prefs>) { return deps.prefs.update(patch); },
    async listHistory() { return { entries: await deps.history.list() }; },
    async clearHistory() { await deps.history.clear(); return { cleared: true as const }; },
  };
}
```

`bb/server.ts`:
```ts
// bb-plugin-parakeet-stt -- backend entry.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { configureContract } from "./configure-contract.ts";
import { HistoryStore } from "./history.ts";
import { PrefsStore } from "./prefs.ts";
import { createRpcHandlers, hostConfigFrom } from "./rpc.ts";
import { rpcContract, SOUNDS } from "./schemas.ts";
import { createSttClient, type SttClient } from "./stt-client.ts";

export { rpcContract } from "./schemas.ts";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    serverUrl: {
      type: "string",
      label: "Parakeet server URL",
      description: "Base URL of the Parakeet STT server, e.g. https://stt.example.com",
      default: "",
    },
    apiKey: { type: "string", label: "API key", secret: true },
  });
  let current = await settings.get();
  let client: SttClient = createSttClient({ serverUrl: current.serverUrl, apiKey: current.apiKey ?? "" });

  const prefs = new PrefsStore(bb.storage.kv);
  await prefs.load();
  const history = new HistoryStore(bb.storage.kv, () => prefs.get().historyLimit);

  bb.rpc.register(rpcContract, createRpcHandlers({
    client: () => client,
    configured: () => current.serverUrl.trim() !== "",
    prefs,
    history,
    now: Date.now,
  }));

  bb.experimental_aiServices.register({ id: "parakeet", displayName: "Parakeet STT (self-hosted)", kinds: ["voice"] });
  const host = bb.hosts.experimental_client({ contract: configureContract });

  const pushHostConfig = async (signal?: AbortSignal) => {
    try {
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (!hostId) return;
      await host.call("stt.configure", hostConfigFrom({ serverUrl: current.serverUrl, apiKey: current.apiKey ?? "" }, prefs.get()), { hostId, signal });
    } catch (e) {
      bb.log.warn(`could not push config to host: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  settings.onChange((next) => {
    current = next;
    client = createSttClient({ serverUrl: next.serverUrl, apiKey: next.apiKey ?? "" });
    void pushHostConfig();
  });
  prefs.onChange((next, prev) => {
    if (next.customWords !== prev.customWords || next.removeFillers !== prev.removeFillers || next.correctionThreshold !== prev.correctionThreshold) {
      void pushHostConfig();
    }
  });
  host.experimental_onWorkerExit(() => void pushHostConfig());
  bb.background.service("host-config", {
    start: async (signal) => {
      await pushHostConfig(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
  for (const sound of SOUNDS) {
    bb.http.route("GET", `/sound/${sound}`, () => {
      const wav = fs.readFileSync(path.join(assets, `${sound}.wav`));
      return new Response(wav, { headers: { "content-type": "audio/wav", "cache-control": "max-age=86400" } });
    });
  }
  bb.log.info(current.serverUrl ? `using ${current.serverUrl}` : "serverUrl not set; configure it in the plugin settings");
}
```

If `tsc` reports `apiKey` as `string` (not optional) drop the `?? ""`. If the dist build puts `server.js` in `dist/`, `..` from `import.meta.url` still resolves to the plugin root for both `bb/server.ts` and `dist/server.js`.

- [ ] **Step 4: Run to verify pass**

Run: `npm test && npx tsc --noEmit`
Expected: all TS tests pass; tsc clean.

- [ ] **Step 5: Install and check registration**

```bash
bb plugin install /data/dev/projects/ai-plugins/plugins/parakeet-stt --yes
bb plugin list | grep -A3 parakeet-stt
bb settings ai-services | grep parakeet
```
Expected: `parakeet-stt@0.1.0 running`, `service host-config: running`, and `parakeet  Parakeet STT (self-hosted)  [voice]`. (The app bundle builds at install; `app.tsx` must exist — create it with `export default definePluginApp(() => {});` from `@get-bb/plugin-sdk/app` if Task 9 is not done yet.)

- [ ] **Step 6: Commit**
```bash
git add plugins/parakeet-stt/bb/rpc.ts plugins/parakeet-stt/bb/rpc.test.ts plugins/parakeet-stt/bb/server.ts plugins/parakeet-stt/bb/app.tsx
git commit -m "feat(parakeet-stt): server entry, RPC, AI-service registration, host config push"
```

---

### Task 9: Dictation controller, recorder, shortcuts

**Files:**
- Create: `plugins/parakeet-stt/bb/dictation.ts`, `bb/dictation.test.ts`, `bb/recorder.ts`, `bb/recorder.test.ts`

**Interfaces:**
- Consumes: `SoundName` (Task 6).
- Produces:
  ```ts
  // dictation.ts
  export type Phase = "idle" | "recording" | "transcribing";
  export interface DictationSnapshot { phase: Phase; targetId: string | null; startedAt: number | null }
  export interface Target { id: string; appendText(text: string): void; submit(): void }
  export interface RecordingHandle { stop(): Promise<Blob>; cancel(): void }
  export type Interruption = "hidden" | "limit";
  export interface DictationDeps {
    startRecording(onInterrupt: (why: Interruption) => void): Promise<RecordingHandle>;
    transcribe(audio: Blob): Promise<string>;
    prefs(): { autoSubmit: boolean; trailingSpace: boolean; soundCues: boolean };
    playSound(name: SoundName): void;
    notify(kind: "info" | "error", message: string): void;
    now(): number;
  }
  export class DictationController { constructor(deps: DictationDeps | null); configure(deps: DictationDeps); snapshot(): DictationSnapshot; subscribe(l: () => void): () => void; register(t: Target): () => void; toggle(targetId?: string): Promise<void>; start(targetId?: string): Promise<void>; stop(): Promise<void>; cancel(): void }
  export function appendDictation(current: string, text: string, trailingSpace: boolean): string;
  export function matchesShortcut(e: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">, shortcut: string): boolean;
  export const controller: DictationController; // module singleton shared by app surfaces
  // recorder.ts
  export const MIME_PREFERENCE: readonly string[];
  export function pickMimeType(isSupported: (t: string) => boolean): string | null;
  export function extensionFor(mime: string): string; // "webm" | "ogg" | "m4a"
  export const MAX_RECORDING_MS = 300_000;
  export async function startBrowserRecording(onInterrupt: (why: Interruption) => void): Promise<RecordingHandle & { mimeType: string }>;
  export async function blobToBase64(blob: Blob): Promise<string>;
  ```

- [ ] **Step 1: Write the failing tests** — `bb/dictation.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendDictation, DictationController, matchesShortcut, type DictationDeps, type Interruption } from "./dictation.ts";

function harness(over: Partial<DictationDeps> = {}) {
  const log: string[] = [];
  let interrupt: ((why: Interruption) => void) | null = null;
  const deps: DictationDeps = {
    async startRecording(onInterrupt) {
      interrupt = onInterrupt;
      log.push("rec:start");
      return { async stop() { log.push("rec:stop"); return new Blob(["x"]); }, cancel() { log.push("rec:cancel"); } };
    },
    async transcribe() { return "hello world"; },
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: true }),
    playSound: (n) => log.push(`sound:${n}`),
    notify: (k, m) => log.push(`${k}:${m}`),
    now: () => 0,
    ...over,
  };
  const c = new DictationController(deps);
  let draft = "fix the";
  c.register({ id: "t1", appendText: (t) => { draft = appendDictation(draft, t, false); }, submit: () => log.push("submit") });
  return { c, log, draft: () => draft, interrupt: (w: Interruption) => interrupt!(w) };
}

test("toggle records then transcribes into the target", async () => {
  const h = harness();
  await h.c.toggle();
  assert.equal(h.c.snapshot().phase, "recording");
  await h.c.toggle();
  assert.equal(h.c.snapshot().phase, "idle");
  assert.equal(h.draft(), "fix the hello world");
  assert.deepEqual(h.log, ["rec:start", "sound:start", "rec:stop", "sound:stop"]);
});

test("cancel discards audio", async () => {
  const h = harness();
  await h.c.start();
  h.c.cancel();
  assert.equal(h.c.snapshot().phase, "idle");
  assert.equal(h.draft(), "fix the");
  assert.ok(h.log.includes("rec:cancel") && h.log.includes("sound:cancel"));
});

test("empty transcript leaves draft and says no speech", async () => {
  const h = harness({ async transcribe() { return "  "; } });
  await h.c.start();
  await h.c.stop();
  assert.equal(h.draft(), "fix the");
  assert.ok(h.log.includes("info:No speech detected"));
});

test("mic failure notifies and returns to idle; next press works", async () => {
  let fail = true;
  const h = harness({
    async startRecording() {
      if (fail) throw new DOMException("Permission denied", "NotAllowedError");
      return { async stop() { return new Blob(["x"]); }, cancel() {} };
    },
  });
  await h.c.start();
  assert.equal(h.c.snapshot().phase, "idle");
  assert.ok(h.log.some((l) => l.startsWith("error:") && l.includes("Permission denied")));
  fail = false;
  await h.c.start();
  assert.equal(h.c.snapshot().phase, "recording");
});

test("transcription failure plays error and keeps draft", async () => {
  const h = harness({ async transcribe() { throw new Error("server down"); } });
  await h.c.start();
  await h.c.stop();
  assert.equal(h.c.snapshot().phase, "idle");
  assert.ok(h.log.includes("sound:error") && h.log.includes("error:server down"));
  assert.equal(h.draft(), "fix the");
});

test("page hidden mid-recording still transcribes, with a notice", async () => {
  const h = harness();
  await h.c.start();
  h.interrupt("hidden");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.c.snapshot().phase, "idle");
  assert.equal(h.draft(), "fix the hello world");
  assert.ok(h.log.some((l) => l.startsWith("info:") && l.includes("hidden")));
});

test("autoSubmit submits after appending", async () => {
  const h = harness({ prefs: () => ({ autoSubmit: true, trailingSpace: false, soundCues: false }) });
  await h.c.start();
  await h.c.stop();
  assert.equal(h.log.at(-1), "submit");
  assert.ok(!h.log.some((l) => l.startsWith("sound:")));
});

test("toggle is ignored while transcribing", async () => {
  let release!: (t: string) => void;
  const h = harness({ transcribe: () => new Promise<string>((r) => { release = r; }) });
  await h.c.start();
  const stopping = h.c.stop();
  assert.equal(h.c.snapshot().phase, "transcribing");
  await h.c.toggle();
  assert.equal(h.c.snapshot().phase, "transcribing");
  release("ok");
  await stopping;
  assert.equal(h.c.snapshot().phase, "idle");
});

test("no registered target -> start is a no-op with a notice", async () => {
  const c = new DictationController(null);
  await c.start();
  assert.equal(c.snapshot().phase, "idle");
});

test("appendDictation spacing", () => {
  assert.equal(appendDictation("", "Hi.", false), "Hi.");
  assert.equal(appendDictation("a", "Hi.", false), "a Hi.");
  assert.equal(appendDictation("a\n", "Hi.", false), "a\nHi.");
  assert.equal(appendDictation("a ", "Hi.", true), "a Hi. ");
});

test("matchesShortcut is exact", () => {
  const ev = (code: string, m: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });
  assert.equal(matchesShortcut(ev("Space", { ctrlKey: true }), "ctrl+space"), true);
  assert.equal(matchesShortcut(ev("Space", { ctrlKey: true, shiftKey: true }), "ctrl+space"), false);
  assert.equal(matchesShortcut(ev("Space", { ctrlKey: true, shiftKey: true }), "ctrl+shift+space"), true);
  assert.equal(matchesShortcut(ev("Space", { altKey: true }), "alt+space"), true);
  assert.equal(matchesShortcut(ev("Space"), "ctrl+space"), false);
  assert.equal(matchesShortcut(ev("Space", { ctrlKey: true }), "off"), false);
});
```

`bb/recorder.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { blobToBase64, extensionFor, pickMimeType } from "./recorder.ts";

test("prefers opus webm, falls back to mp4 (iOS Safari)", () => {
  assert.equal(pickMimeType(() => true), "audio/webm;codecs=opus");
  assert.equal(pickMimeType((t) => t === "audio/mp4"), "audio/mp4");
  assert.equal(pickMimeType(() => false), null);
});

test("extensions", () => {
  assert.equal(extensionFor("audio/webm;codecs=opus"), "webm");
  assert.equal(extensionFor("audio/ogg;codecs=opus"), "ogg");
  assert.equal(extensionFor("audio/mp4"), "m4a");
  assert.equal(extensionFor(""), "webm");
});

test("blobToBase64", async () => {
  assert.equal(await blobToBase64(new Blob(["abc"])), "YWJj");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test bb/dictation.test.ts bb/recorder.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement** — `bb/dictation.ts`:
```ts
// Frontend dictation state machine shared by the composer action, plus-menu item, banner,
// and keyboard shortcut. Browser specifics are injected so the logic runs under node:test.
import type { SoundName } from "./schemas.ts";

export type Phase = "idle" | "recording" | "transcribing";
export interface DictationSnapshot { phase: Phase; targetId: string | null; startedAt: number | null }
export interface Target { id: string; appendText(text: string): void; submit(): void }
export interface RecordingHandle { stop(): Promise<Blob>; cancel(): void }
export type Interruption = "hidden" | "limit";
export interface DictationDeps {
  startRecording(onInterrupt: (why: Interruption) => void): Promise<RecordingHandle>;
  transcribe(audio: Blob): Promise<string>;
  prefs(): { autoSubmit: boolean; trailingSpace: boolean; soundCues: boolean };
  playSound(name: SoundName): void;
  notify(kind: "info" | "error", message: string): void;
  now(): number;
}

const IDLE: DictationSnapshot = { phase: "idle", targetId: null, startedAt: null };
const INTERRUPT_NOTICE: Record<Interruption, string> = {
  hidden: "Recording stopped because the page was hidden; transcribing what was captured.",
  limit: "Recording reached the 5-minute limit; transcribing.",
};

export function appendDictation(current: string, text: string, trailingSpace: boolean): string {
  const sep = current === "" || /\s$/.test(current) ? "" : " ";
  return `${current}${sep}${text}${trailingSpace ? " " : ""}`;
}

export function matchesShortcut(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
  shortcut: string,
): boolean {
  if (shortcut === "off" || e.code !== "Space" || e.metaKey) return false;
  const want = new Set(shortcut.split("+"));
  return e.ctrlKey === want.has("ctrl") && e.altKey === want.has("alt") && e.shiftKey === want.has("shift");
}

export class DictationController {
  #deps: DictationDeps | null;
  #state: DictationSnapshot = IDLE;
  #targets: Target[] = [];
  #listeners = new Set<() => void>();
  #recording: RecordingHandle | null = null;

  constructor(deps: DictationDeps | null) {
    this.#deps = deps;
  }

  configure(deps: DictationDeps): void {
    this.#deps = deps;
  }

  snapshot(): DictationSnapshot {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Most recently registered/used target is the default for shortcuts. */
  register(target: Target): () => void {
    this.#targets = [...this.#targets.filter((t) => t.id !== target.id), target];
    return () => { this.#targets = this.#targets.filter((t) => t !== target); };
  }

  async toggle(targetId?: string): Promise<void> {
    if (this.#state.phase === "idle") return this.start(targetId);
    if (this.#state.phase === "recording") return this.stop();
  }

  async start(targetId?: string): Promise<void> {
    const deps = this.#deps;
    if (this.#state.phase !== "idle" || !deps) return;
    const target = this.#resolve(targetId);
    if (!target) return;
    this.#set({ phase: "recording", targetId: target.id, startedAt: deps.now() });
    try {
      this.#recording = await deps.startRecording((why) => {
        if (this.#state.phase !== "recording") return;
        deps.notify("info", INTERRUPT_NOTICE[why]);
        void this.stop();
      });
    } catch (e) {
      this.#recording = null;
      this.#set(IDLE);
      this.#cue("error");
      deps.notify("error", `Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.#cue("start");
  }

  async stop(): Promise<void> {
    const deps = this.#deps;
    const recording = this.#recording;
    if (this.#state.phase !== "recording" || !deps || !recording) return;
    const target = this.#resolve(this.#state.targetId ?? undefined);
    this.#recording = null;
    this.#set({ ...this.#state, phase: "transcribing" });
    this.#cue("stop");
    try {
      const text = (await deps.transcribe(await recording.stop())).trim();
      if (!text) deps.notify("info", "No speech detected");
      else if (target) {
        target.appendText(text);
        if (deps.prefs().autoSubmit) target.submit();
      }
    } catch (e) {
      this.#cue("error");
      deps.notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      this.#set(IDLE);
    }
  }

  cancel(): void {
    if (this.#state.phase !== "recording") return;
    this.#recording?.cancel();
    this.#recording = null;
    this.#set(IDLE);
    this.#cue("cancel");
  }

  #resolve(targetId?: string): Target | undefined {
    if (targetId) {
      const t = this.#targets.find((x) => x.id === targetId);
      if (t) this.#targets = [...this.#targets.filter((x) => x !== t), t];
      return t;
    }
    return this.#targets.at(-1);
  }

  #cue(name: SoundName): void {
    if (this.#deps?.prefs().soundCues) this.#deps.playSound(name);
  }

  #set(next: DictationSnapshot): void {
    this.#state = next;
    for (const l of this.#listeners) l();
  }
}

export const controller = new DictationController(null);
```

Note: `start()` sets `recording` before the mic promise resolves so a double press is ignored; the `sound:start` cue therefore follows `rec:start` (matches the test's order).

`bb/recorder.ts`:
```ts
// Browser MediaRecorder wrapper. Picks a codec every major browser supports (iOS Safari only
// records audio/mp4) and stops on page hide (phone lock) or the 5-minute limit.
import type { Interruption, RecordingHandle } from "./dictation.ts";

export const MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"] as const;
export const MAX_RECORDING_MS = 300_000;

export function pickMimeType(isSupported: (t: string) => boolean): string | null {
  return MIME_PREFERENCE.find((t) => isSupported(t)) ?? null;
}

export function extensionFor(mime: string): string {
  if (mime.startsWith("audio/ogg")) return "ogg";
  if (mime.startsWith("audio/mp4")) return "m4a";
  return "webm";
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function startBrowserRecording(onInterrupt: (why: Interruption) => void): Promise<RecordingHandle & { mimeType: string }> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("this browser cannot record audio");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const release = () => {
    stream.getTracks().forEach((t) => t.stop());
    document.removeEventListener("visibilitychange", onVisibility);
    clearTimeout(limit);
  };
  const onVisibility = () => { if (document.visibilityState === "hidden") onInterrupt("hidden"); };
  document.addEventListener("visibilitychange", onVisibility);
  const limit = setTimeout(() => onInterrupt("limit"), MAX_RECORDING_MS);
  recorder.start(1000); // timeslice: keeps captured audio if the page is suspended
  const type = recorder.mimeType || mimeType || "audio/webm";
  return {
    mimeType: type,
    stop: () => new Promise<Blob>((resolve) => {
      recorder.onstop = () => { release(); resolve(new Blob(chunks, { type })); };
      recorder.state === "inactive" ? recorder.onstop(new Event("stop")) : recorder.stop();
    }),
    cancel: () => { recorder.onstop = null; if (recorder.state !== "inactive") recorder.stop(); release(); },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test bb/dictation.test.ts bb/recorder.test.ts && npx tsc --noEmit`
Expected: pass.

- [ ] **Step 5: Commit**
```bash
git add plugins/parakeet-stt/bb/dictation.ts plugins/parakeet-stt/bb/dictation.test.ts plugins/parakeet-stt/bb/recorder.ts plugins/parakeet-stt/bb/recorder.test.ts
git commit -m "feat(parakeet-stt): dictation state machine, recorder, shortcut matching"
```

---

### Task 10: App surfaces (composer, shortcuts, settings page)

**Files:**
- Create: `plugins/parakeet-stt/bb/app.tsx` (replace the stub), `bb/dictation-prefs.ts`, `bb/page/parakeet-page.tsx`, `bb/page/ui.tsx`

`bb/dictation-prefs.ts` (browser-side prefs cache shared by `app.tsx` and the page; no React):
```ts
import { DEFAULT_PREFS } from "./prefs.ts";
import type { Prefs } from "./schemas.ts";

let current: Prefs = DEFAULT_PREFS;
export const dictationPrefs = (): Prefs => current;
export function setDictationPrefs(next: Prefs): void { current = next; }
```
`prefs.ts` imports only `schemas.ts` (no Node APIs), so it is safe in the browser bundle.
- Copy from `plugins/kokoro-tts/bb/`: `components/ui/{button,input,label,switch,slider,card,badge,icon,icon-extended,icon-registry,coarse-pointer-sizing,motion,overlay-trigger}.tsx|.ts`, `components/ui/hooks/`, `lib/utils.ts`, `lib/portal-scope.ts`, `page/ui.tsx`, and `app.css` if kokoro has one (else create per `bb plugin new` scaffold). Delete copied files that end up unimported (check with `tsc --noEmit` + grep).

**Interfaces:**
- Consumes: `controller`, `appendDictation`, `matchesShortcut` (Task 9); `startBrowserRecording`, `blobToBase64`, `extensionFor` (Task 9); `rpcContract`, `Prefs`, `HistoryEntry`, `HealthResult` (Task 6).
- Produces: registered UI — composer action `mic`, plus-menu item `dictate`, banner `recording`, content script `shortcuts`, nav panel `parakeet-stt` at path `parakeet`.

- [ ] **Step 1: Wire the controller to React** — top of `bb/app.tsx`:
```tsx
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useComposer, useComposerView, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { appendDictation, controller, matchesShortcut, type DictationDeps } from "./dictation.ts";
import { dictationPrefs as prefsNow, setDictationPrefs } from "./dictation-prefs.ts";
import { ParakeetPage } from "./page/parakeet-page.tsx";
import { blobToBase64, extensionFor, startBrowserRecording } from "./recorder.ts";
import type { rpcContract, SoundName } from "./schemas.ts";

const PLUGIN_ID = "parakeet-stt";

function useDictationState() {
  return useSyncExternalStore((l) => controller.subscribe(l), () => controller.snapshot());
}

/** Configures the shared controller with this app's RPC the first time any composer surface mounts. */
function useControllerDeps() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    void rpc.call("getPrefs").then(setDictationPrefs, () => undefined);
    let recordingMime = "audio/webm";
    const deps: DictationDeps = {
      startRecording: async (onInterrupt) => {
        const handle = await startBrowserRecording(onInterrupt);
        recordingMime = handle.mimeType;
        return handle;
      },
      transcribe: async (blob) => {
        const { text } = await rpc.call("transcribe", {
          audioBase64: await blobToBase64(blob),
          mimeType: recordingMime,
          filename: `dictation.${extensionFor(recordingMime)}`,
        });
        return text;
      },
      prefs: prefsNow,
      playSound: (name: SoundName) => { void new Audio(`/api/v1/plugins/${PLUGIN_ID}/http/sound/${name}`).play().catch(() => undefined); },
      notify: (kind, message) => (kind === "error" ? toast.error(message) : toast(message)),
      now: Date.now,
    };
    controller.configure(deps);
  }, [rpc]);
}

/** Registers the composer that mounted this component as a dictation target; returns its id. */
function useComposerTarget(): string {
  const composer = useComposer();
  const view = useComposerView();
  const id = JSON.stringify(view.scope);
  const ref = useRef(composer);
  ref.current = composer;
  useEffect(() => controller.register({
    id,
    appendText: (text) => ref.current.updateText((current) => appendDictation(current, text, prefsNow().trailingSpace)),
    submit: () => { void ref.current.experimental_submit({ experimental_data: {} }); },
  }), [id]);
  return id;
}
```

- [ ] **Step 2: Composer surfaces** (same file):
```tsx
function MicAction() {
  useControllerDeps();
  const id = useComposerTarget();
  const s = useDictationState();
  const mine = s.targetId === id;
  const label = mine && s.phase === "recording" ? "Stop dictation" : "Dictate (Ctrl+Space)";
  return (
    <Button
      type="button" variant="ghost" size="icon" aria-label={label} title={label}
      aria-pressed={mine && s.phase === "recording"}
      disabled={s.phase === "transcribing"}
      onClick={() => void controller.toggle(id)}
      className={mine && s.phase === "recording" ? "text-red-500 animate-pulse" : undefined}
    >
      <Icon name={mine && s.phase === "transcribing" ? "Loading03" : "Mic01"} />
    </Button>
  );
}

function RecordingBanner() {
  useControllerDeps();
  const id = useComposerTarget();
  const s = useDictationState();
  useSecondTick(s.phase === "recording");
  if (s.targetId !== id || s.phase === "idle") return null;
  const secs = s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0;
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm" role="status" aria-live="polite">
      <span className="size-2 rounded-full bg-red-500 animate-pulse" aria-hidden />
      <span className="flex-1">{s.phase === "recording" ? `Listening… ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : "Transcribing…"}</span>
      {s.phase === "recording" && (
        <>
          <Button size="sm" onClick={() => void controller.stop()}>Stop</Button>
          <Button size="sm" variant="ghost" onClick={() => controller.cancel()}>Cancel</Button>
        </>
      )}
    </div>
  );
}

/** Re-renders once a second while `active`, for the elapsed-time readout. */
function useSecondTick(active: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}
```

- [ ] **Step 3: Registration** (same file):
```tsx
export default definePluginApp((app) => {
  app.composer.customize({
    id: "dictation",
    actions: [{ id: "mic", component: MicAction }],
    plusMenu: [{
      id: "dictate",
      label: "Dictate",
      icon: "Mic",
      description: "Speak instead of typing",
      disabled: () => controller.snapshot().phase === "transcribing",
      run: ({ composer, view }) => {
        const id = JSON.stringify(view.scope);
        controller.register({
          id,
          appendText: (text) => composer.updateText((current) => appendDictation(current, text, prefsNow().trailingSpace)),
          submit: () => { void composer.experimental_submit({ experimental_data: {} }); },
        });
        void controller.start(id);
      },
    }],
    banners: [{ id: "recording", component: RecordingBanner, chrome: "bare" }],
  });

  app.contentScripts.register({
    id: "shortcuts",
    mount({ signal }) {
      const onKeyDown = (e: KeyboardEvent) => {
        const phase = controller.snapshot().phase;
        if (e.key === "Escape" && phase === "recording") {
          e.preventDefault(); e.stopPropagation(); controller.cancel(); return;
        }
        if (!matchesShortcut(e, prefsNow().shortcut)) return;
        e.preventDefault(); e.stopPropagation();
        if (e.repeat) return;
        if (prefsNow().holdToTalk) void controller.start();
        else void controller.toggle();
      };
      const onKeyUp = (e: KeyboardEvent) => {
        if (prefsNow().holdToTalk && e.code === "Space" && controller.snapshot().phase === "recording") void controller.stop();
      };
      document.addEventListener("keydown", onKeyDown, { capture: true, signal });
      document.addEventListener("keyup", onKeyUp, { capture: true, signal });
    },
  });

  app.slots.navPanel({ id: "parakeet-stt", title: "Parakeet STT", icon: "Mic", path: "parakeet", component: ParakeetPage });
});
```
Check `Icon` names against `components/ui/icon-registry.ts` (use whatever mic/loading names exist there) and the plus-menu `icon` against bb's icon names (kokoro uses `"Mic"`). If `ComposerPlusMenuItem.run`'s `composer` lacks `experimental_submit`, use `view`-less submit via the target registered by `MicAction` (same id) and drop `submit` from this ad-hoc target.

- [ ] **Step 4: Settings page** — `bb/page/parakeet-page.tsx`:
```tsx
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setDictationPrefs } from "../dictation-prefs.ts";
import { SHORTCUTS, type HealthResult, type HistoryEntry, type Prefs, type rpcContract } from "../schemas.ts";
import { errorText, Row, Section, SliderRow, SwitchRow } from "./ui.tsx";

export function ParakeetPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [words, setWords] = useState("");

  const refresh = useCallback(async () => {
    const [p, h, hist] = await Promise.all([rpc.call("getPrefs"), rpc.call("health"), rpc.call("listHistory")]);
    setPrefs(p); setDictationPrefs(p); setHealth(h); setHistory(hist.entries); setWords(p.customWords.join(", "));
  }, [rpc]);
  useEffect(() => { void refresh().catch((e) => toast.error(errorText(e))); }, [refresh]);

  const patch = async (p: Partial<Prefs>) => {
    try { const next = await rpc.call("setPrefs", p); setPrefs(next); setDictationPrefs(next); }
    catch (e) { toast.error(errorText(e)); }
  };
  if (!prefs) return null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <Section title="Server" description="Set the server URL and API key under Settings → Installed plugins → Parakeet STT." actions={<Button size="sm" variant="outline" onClick={() => void refresh()}>Check</Button>}>
        <Row label="Status">
          <span>{!health ? "…" : !health.configured ? "Not configured" : health.up ? `Ready — ${health.model} (v${health.version})` : `Unavailable — ${health.error}`}</span>
        </Row>
        {health?.lastLatencyMs != null && <Row label="Last transcription"><span>{health.lastLatencyMs} ms</span></Row>}
      </Section>

      <Section title="Dictation">
        <Row label="Shortcut" hint="Works while bb has focus. Esc cancels.">
          <select className="rounded border bg-transparent px-2 py-1" value={prefs.shortcut} onChange={(e) => void patch({ shortcut: e.target.value as Prefs["shortcut"] })}>
            {SHORTCUTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Row>
        <SwitchRow id="hold" label="Hold to talk" hint="Record only while the shortcut is held" checked={prefs.holdToTalk} onChange={(v) => void patch({ holdToTalk: v })} />
        <SwitchRow id="submit" label="Auto-submit" hint="Send the message after dictating" checked={prefs.autoSubmit} onChange={(v) => void patch({ autoSubmit: v })} />
        <SwitchRow id="space" label="Trailing space" checked={prefs.trailingSpace} onChange={(v) => void patch({ trailingSpace: v })} />
        <SwitchRow id="sounds" label="Sound cues" checked={prefs.soundCues} onChange={(v) => void patch({ soundCues: v })} />
      </Section>

      <Section title="Vocabulary">
        <Row label="Custom words" hint="Comma-separated; fixes spelling and case (e.g. tmux, CLAUDE.md)" htmlFor="words">
          <Input id="words" value={words} onChange={(e) => setWords(e.target.value)} onBlur={() => void patch({ customWords: words.split(",") })} />
        </Row>
        <SwitchRow id="fillers" label="Remove filler words" hint="um, uh, er…" checked={prefs.removeFillers} onChange={(v) => void patch({ removeFillers: v })} />
        <SliderRow id="threshold" label="Correction strength" hint="Higher corrects more aggressively" value={prefs.correctionThreshold} min={0} max={0.5} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => void patch({ correctionThreshold: v })} />
      </Section>

      <Section title="History" actions={<Button size="sm" variant="ghost" onClick={() => void rpc.call("clearHistory").then(() => setHistory([]))}>Clear</Button>}>
        {history.length === 0 ? <p className="text-sm opacity-70">No transcriptions yet.</p> : history.map((h) => (
          <Row key={h.id} label={new Date(h.at).toLocaleTimeString()} hint={`${h.durationMs} ms`}>
            <div className="flex items-center gap-2">
              <span className="text-sm">{h.text}</span>
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(h.text).then(() => toast("Copied"))}>Copy</Button>
            </div>
          </Row>
        ))}
      </Section>
    </div>
  );
}
```
Match the prop names of the copied `Section`/`Row`/`SwitchRow`/`SliderRow` (see `plugins/kokoro-tts/bb/page/ui.tsx`); adjust calls, not the helpers.

- [ ] **Step 5: Build, typecheck, reload**

Run: `npx tsc --noEmit && npm test && bb plugin build . && bb plugin reload parakeet-stt && bb plugin list | grep -A3 parakeet-stt`
Expected: clean; `running`.

- [ ] **Step 6: Browser check (desktop)** — open `https://<bb>/` with Playwright or a real browser, open a thread: mic button visible left of bb's voice button; plus menu has "Dictate"; nav panel "Parakeet STT" renders all four cards; `Ctrl+Space` in a headless browser → `Microphone unavailable: Requested device not found` toast (proves the wiring; real audio is tested in Task 12).

- [ ] **Step 7: Commit**
```bash
git add plugins/parakeet-stt/bb
git commit -m "feat(parakeet-stt): composer dictation, shortcuts, and settings page"
```

---

### Task 11: Repo wiring, docs, release script, CI

**Files:**
- Modify: `.bb/plugins.json`, `marketplace.json`, `.github/workflows/ci.yml`, `README.md` (repo root: add the plugin to the list)
- Create: `plugins/parakeet-stt/README.md`, `plugins/parakeet-stt/PLUGIN_OVERVIEW.md`, `plugins/parakeet-stt/scripts/release.sh`

- [ ] **Step 1: Catalogs.** `.bb/plugins.json` `plugins` array gains `{ "name": "parakeet-stt", "source": "./plugins/parakeet-stt" }`. `marketplace.json` `plugins` array gains:
```json
{
  "id": "parakeet-stt",
  "displayName": "Parakeet STT",
  "description": "Dictate to your agents: Handy-style speech-to-text for every BB composer, powered by your own Parakeet server.",
  "icon": { "url": "./plugins/parakeet-stt/assets/icon.svg" },
  "tags": ["voice", "stt", "dictation", "accessibility"],
  "author": { "name": "MrLawrune", "github": "MrLawrune" },
  "source": { "git": { "url": "https://github.com/MrLawrune/ai-plugins.git", "subdir": "plugins/parakeet-stt", "range": "^0.1.0", "tagPrefix": "parakeet-stt/" } }
}
```

- [ ] **Step 2: CI job** appended to `.github/workflows/ci.yml` `jobs:`:
```yaml
  parakeet-stt:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: plugins/parakeet-stt } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - uses: astral-sh/setup-uv@v6
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm test
      - run: uv run --project server --with pytest pytest tests -q
```

- [ ] **Step 3: `scripts/release.sh`** — copy kokoro's script and change: `tag="parakeet-stt/v$version"`; drop the `.claude-plugin/plugin.json` line; the pyproject `sed` stays (first unindented `version =`); `sed -i -E "s/^SERVER_VERSION = \"[^\"]+\"/SERVER_VERSION = \"$version\"/" server/parakeet_server.py`; `git add package.json package-lock.json server/pyproject.toml server/uv.lock server/parakeet_server.py`; commit message `chore(parakeet-stt): release $version`. `chmod +x`.

- [ ] **Step 4: Docs.** `PLUGIN_OVERVIEW.md` (user-facing, shown in bb's catalog) — what you get (mic button, Ctrl+Space, phone plus-menu, custom words, filler removal, sound cues, history, bb's own mic), how it works (your own server, OpenAI-compatible, nothing goes to a cloud), requirements (a machine running the server: Python 3.11–3.13 + uv, ~1.2 GB RAM idle, ~3 GB peak for long clips, 4+ CPU cores). `README.md` — server install (`uv run --project server python parakeet_server.py`, env var table from `parakeet_config.py`, systemd unit example with `EnvironmentFile`), bb setup (the three commands from the spec), API reference (endpoints + extensions), development (`npm test`, pytest, `PARAKEET_INTEGRATION=1`). Use `stt.example.com` placeholders only.

- [ ] **Step 5: Verify**

Run: `jq . .bb/plugins.json marketplace.json >/dev/null && (cd plugins/parakeet-stt && npm test && npx tsc --noEmit && uv run --project server --with pytest pytest tests -q)`
Expected: all green.

- [ ] **Step 6: Commit**
```bash
git add .bb/plugins.json marketplace.json .github/workflows/ci.yml README.md plugins/parakeet-stt/README.md plugins/parakeet-stt/PLUGIN_OVERVIEW.md plugins/parakeet-stt/scripts/release.sh
git commit -m "docs(parakeet-stt): catalog entries, README, release script, CI job"
```

---

### Task 12: Lab deployment + end-to-end verification

Lab specifics (hostnames, IPs, CT id, credentials) live in the private admin runbook, not in this repo: `/data/dev/admin/.agents/mops/parakeet-stt-deployment.md`. This task writes that runbook and executes it.

- [ ] **Step 1:** Write the runbook (CT creation from the node's Debian 12 template with static IP outside the DHCP pool, uv install, code sync to `/opt/parakeet-stt/server`, `/etc/parakeet-stt.env` 0600 with `PARAKEET_HOST=0.0.0.0` and a generated `PARAKEET_API_KEY`, `HF_HOME=/opt/parakeet-stt/models`, systemd unit mirroring the TTS node's, Caddy site block with the LAN+tailnet `remote_ip` allowlist, internal DNS override, bb settings, rollback).
- [ ] **Step 2:** Execute it; verify `curl https://<stt>/health` → `ready:true` and an authenticated transcription of `tests/fixtures/speech.webm` from cachtop.
- [ ] **Step 3:** Configure bb (`serverUrl`, `apiKey`, `BB_TRANSCRIPTION=parakeet/parakeet-tdt-0.6b-v2`); verify `POST /api/v1/system/voice-transcription` with the fixture returns the phrase.
- [ ] **Step 4:** Update admin docs: node doc LXC table row, Caddy reverse-proxy table row.
- [ ] **Step 5:** Manual checks with the user: desktop mic button + `Ctrl+Space` + `Esc`; bb's native mic; Android phone (plus menu → banner → Stop, lock-screen mid-recording); iOS Safari if available.
