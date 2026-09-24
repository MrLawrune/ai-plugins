# parakeet-stt Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continuous hands-free dictation with a live dimmed preview, phrase commits at pauses, configurable endings, one mic, and press-and-hold one-shot.

**Architecture:** The page captures 16 kHz PCM with an AudioWorklet and streams it over a bb plugin websocket to the plugin backend, which relays it (adding key and prefs) to a new `/v1/stream` websocket on the Parakeet server. The server endpoints phrases with Silero VAD, re-transcribes the open phrase for partials, and emits ordered finals, commands, and an end reason.

**Tech Stack:** Python 3.11+, aiohttp websockets, onnxruntime (Silero VAD via onnx-asr's model), numpy; TypeScript strict, bb plugin SDK 0.5.9, Web Audio (AudioWorklet), node:test.

**Spec:** `docs/superpowers/specs/2026-09-24-parakeet-stt-streaming-design.md` (extends `docs/superpowers/specs/2026-09-24-parakeet-stt-design.md`)

## Global Constraints

- VAD frame 512 samples (32 ms) at 16 kHz; open after 2 frames ≥ 0.5; close after `pause_ms` of frames < 0.35; 200 ms pre-roll.
- Partials: open phrase ≥ 0.5 s, ≥ 0.25 s new audio, never wait for the inference lock, never emitted while an earlier final is pending.
- Force-commit at 15 s, cut at the lowest-probability frame of the last 2 s. Session limit 900 s of audio.
- Wire: page/relay → server binary PCM16 LE 16 kHz mono; JSON text messages exactly as in the spec (`start`, `stop`, `ready`, `partial`, `final`, `command`, `ended`, `error`). Close codes 4400 bad start, 4401 auth, 4503 not ready.
- Prefs defaults: `mode` continuous, `livePreview` true, `pauseMs` 600 (300–1500), `endOnSilence` false, `silenceTimeoutS` 8 (3–60), `voiceCommands` false, `sendPhrase` "send it", `stopPhrase` "stop listening", `hideNativeMic` true. `autoSubmit` is one-shot only.
- Hold ≥ 350 ms on the mic = one-shot push-to-talk; stream connect/ready timeout 5 s → one-shot fallback.
- Public repo: no LAN hosts/IPs/keys under `plugins/` or `docs/superpowers/`.
- Conventional commits, scope `parakeet-stt`.

## Review Focus

1. User keeps talking through a force-commit (> 15 s without pause) → no words lost or duplicated at the cut. (Task 2 test `test_force_commit_splits_without_loss`)
2. Voice command said mid-sentence ("I'll send it tomorrow") → no command fires. (Task 2 test `test_command_only_at_phrase_end`)
3. Relay: page streams audio before upstream is open → frames are queued, not dropped. (Task 5 test "queues frames until upstream opens")
4. Mic released (hold) or Stop tapped while the stream is still connecting → session stops once connected, mic released. (Task 6 test "stop during stream connect")
5. Draft edited by the user mid-session → edits kept, tail re-anchored at end. (Task 4 test "tail re-anchors after user edits")

---

### Task 1: Endpointer + streaming VAD wrapper

**Files:**
- Create: `plugins/parakeet-stt/server/parakeet_endpoint.py`, `plugins/parakeet-stt/tests/test_endpoint.py`
- Modify: `plugins/parakeet-stt/server/parakeet_engine.py` (load Silero session, `new_vad()`)

**Interfaces:**
- Produces: `FRAME = 512`; `class Endpointer(pause_frames: int, start_frames: int = 2, on: float = 0.5, off: float = 0.35)` with `push(prob: float) -> "start" | "end" | None`, `active: bool`; `class SileroStream(session)` with `prob(frame: np.ndarray) -> float`; `ParakeetEngine.new_vad() -> SileroStream`.

- [ ] **Step 1: Failing tests** — `tests/test_endpoint.py`:
```python
from parakeet_endpoint import Endpointer


def run(ep, probs):
    return [(i, e) for i, p in enumerate(probs) if (e := ep.push(p))]


def test_opens_after_two_speech_frames_and_closes_after_pause():
    ep = Endpointer(pause_frames=3)
    events = run(ep, [0.1, 0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1])
    assert events == [(2, "start"), (6, "end")]
    assert ep.active is False


def test_single_click_does_not_open():
    ep = Endpointer(pause_frames=3)
    assert run(ep, [0.9, 0.1, 0.9, 0.1]) == []


def test_speech_during_pause_resets_the_pause():
    ep = Endpointer(pause_frames=3)
    events = run(ep, [0.9, 0.9, 0.1, 0.1, 0.9, 0.1, 0.1, 0.1])
    assert events == [(1, "start"), (7, "end")]


def test_hysteresis_band_is_not_silence():
    ep = Endpointer(pause_frames=2)
    assert run(ep, [0.9, 0.9, 0.4, 0.4, 0.4]) == [(1, "start")]
```

- [ ] **Step 2: Run** `uv run --project server --with pytest pytest tests/test_endpoint.py -q` → FAIL (`No module named 'parakeet_endpoint'`).

- [ ] **Step 3: Implement** — `server/parakeet_endpoint.py`:
```python
"""Phrase endpointing over per-frame speech probabilities, plus a streaming Silero wrapper."""
from __future__ import annotations

import numpy as np

FRAME = 512  # samples per VAD frame at 16 kHz (32 ms)
_CONTEXT = 64


class Endpointer:
    def __init__(self, pause_frames: int, start_frames: int = 2, on: float = 0.5, off: float = 0.35) -> None:
        self.pause_frames, self.start_frames, self.on, self.off = pause_frames, start_frames, on, off
        self.active = False
        self._run = 0
        self._quiet = 0

    def push(self, prob: float) -> str | None:
        if not self.active:
            self._run = self._run + 1 if prob >= self.on else 0
            if self._run >= self.start_frames:
                self.active, self._quiet = True, 0
                return "start"
            return None
        self._quiet = self._quiet + 1 if prob < self.off else 0
        if self._quiet >= self.pause_frames:
            self.active, self._run = False, 0
            return "end"
        return None


class SileroStream:
    """Stateful Silero VAD over consecutive 512-sample frames (one per stream)."""

    def __init__(self, session) -> None:
        self._session = session
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, _CONTEXT), dtype=np.float32)
        self._sr = np.array(16000, dtype=np.int64)

    def prob(self, frame: np.ndarray) -> float:
        x = np.concatenate([self._context, frame.reshape(1, -1).astype(np.float32)], axis=1)
        out, self._state = self._session.run(["output", "stateN"], {"input": x, "state": self._state, "sr": self._sr})
        self._context = x[:, -_CONTEXT:]
        return float(out[0][0])
```

`server/parakeet_engine.py` — add to `load()` after the model loads, and add `new_vad()`:
```python
        vad = onnx_asr.load_vad("silero")
        self._vad_model = self._model.with_vad(vad)
        self._silero = vad._model  # onnxruntime session; onnx-asr is pinned (0.12.0)
```
```python
    def new_vad(self) -> "SileroStream":
        from parakeet_endpoint import SileroStream

        if self._silero is None:
            raise RuntimeError("model not loaded")
        return SileroStream(self._silero)
```
Initialize `self._silero = None` in `__init__` and replace the existing `self._vad_model = self._model.with_vad(onnx_asr.load_vad("silero"))` line with the three lines above.

- [ ] **Step 4: Run** `uv run --project server --with pytest pytest tests -q` → all pass. Then `PARAKEET_INTEGRATION=1 … tests/test_engine_integration.py` → pass, and append to that file:
```python
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
```
and re-run the integration test → 2 passed.

- [ ] **Step 5: Commit** `feat(parakeet-stt): phrase endpointer and streaming Silero VAD`

---

### Task 2: Stream session

**Files:**
- Create: `plugins/parakeet-stt/server/parakeet_stream.py`, `plugins/parakeet-stt/tests/test_stream.py`

**Interfaces:**
- Consumes: `FRAME`, `Endpointer` (Task 1); `postprocess` (existing); `SAMPLE_RATE`.
- Produces: `@dataclass(frozen=True) StreamOptions(pause_ms=600, silence_timeout_s=None, commands=None, preview=True, custom_words=(), remove_fillers=True, correction_threshold=0.18, max_phrase_s=15.0, max_session_s=900.0, preroll_ms=200)`, `StreamOptions.from_json(raw: dict) -> StreamOptions` (raises `ValueError`); `strip_command(text: str, commands: dict[str,str]) -> tuple[str, str | None]`; `class StreamSession(options, *, transcribe: Callable[[np.ndarray, bool], Awaitable[str | None]], vad_prob: Callable[[np.ndarray], float], emit: Callable[[dict], Awaitable[None]])` with `async feed(pcm16: bytes)`, `async finish(reason: str = "stopped")`, `abort()`, `done: asyncio.Event`.

- [ ] **Step 1: Failing tests** — `tests/test_stream.py`:
```python
import asyncio

import numpy as np
import pytest

from parakeet_stream import StreamOptions, StreamSession, strip_command

FRAME = 512


def pcm(prob: float, frames: int) -> bytes:
    """PCM whose samples encode the fake VAD probability."""
    return (np.full(frames * FRAME, prob * 32767)).astype("<i2").tobytes()


def fake_vad(frame):
    return float(frame.mean())


class Harness:
    def __init__(self, texts=None, **opts):
        self.events = []
        self.calls = []
        self.texts = texts
        self.opts = StreamOptions(**opts)

    async def transcribe(self, audio, partial):
        self.calls.append(("partial" if partial else "final", len(audio)))
        if self.texts is not None:
            return self.texts.pop(0) if self.texts else ""
        return f"{'p' if partial else 'f'}{len(audio) // FRAME}"

    async def emit(self, msg):
        self.events.append(msg)

    def session(self):
        return StreamSession(self.opts, transcribe=self.transcribe, vad_prob=fake_vad, emit=self.emit)


def types(events):
    return [e["type"] for e in events]


def test_phrase_commits_at_pause_with_preroll():
    h = Harness(preview=False, pause_ms=96)  # 3 frames
    async def go():
        s = h.session()
        await s.feed(pcm(0.0, 10) + pcm(0.9, 20) + pcm(0.0, 3))
        await s.finish()
    asyncio.run(go())
    finals = [e for e in h.events if e["type"] == "final"]
    assert len(finals) == 1 and finals[0]["seq"] == 0
    # pre-roll (6 frames = 200 ms) holds 4 silence frames + the 2 opening speech frames,
    # then 18 more speech frames and the 3 pause frames
    assert h.calls == [("final", (4 + 20 + 3) * FRAME)]
    assert types(h.events)[-1] == "ended" and h.events[-1]["reason"] == "stopped"


def test_partials_emitted_while_speaking():
    h = Harness(pause_ms=96)
    async def go():
        s = h.session()
        for _ in range(8):
            await s.feed(pcm(0.9, 10))
            await asyncio.sleep(0)
        await s.feed(pcm(0.0, 3))
        await s.finish()
    asyncio.run(go())
    partials = [e for e in h.events if e["type"] == "partial"]
    assert partials and all(p["seq"] == 0 for p in partials)
    assert types(h.events).index("final") > types(h.events).index("partial")


def test_no_partials_when_preview_off():
    h = Harness(preview=False, pause_ms=96)
    async def go():
        s = h.session()
        for _ in range(8):
            await s.feed(pcm(0.9, 10))
            await asyncio.sleep(0)
        await s.finish()
    asyncio.run(go())
    assert "partial" not in types(h.events)


def test_finals_are_ordered_and_postprocessed():
    h = Harness(texts=["Um, first Tmux.", "second."], preview=False, pause_ms=96, custom_words=("tmux",))
    async def go():
        s = h.session()
        await s.feed(pcm(0.9, 10) + pcm(0.0, 3) + pcm(0.9, 10) + pcm(0.0, 3))
        await s.finish()
    asyncio.run(go())
    finals = [(e["seq"], e["text"]) for e in h.events if e["type"] == "final"]
    assert finals == [(0, "First tmux."), (1, "Second.")]


def test_force_commit_splits_without_loss():
    h = Harness(preview=False, pause_ms=96, max_phrase_s=1.0)
    async def go():
        s = h.session()
        # 1.6 s continuous speech with one quieter (still speech) frame near the end of the first second
        await s.feed(pcm(0.9, 25) + pcm(0.6, 1) + pcm(0.9, 24) + pcm(0.0, 3))
        await s.finish()
    asyncio.run(go())
    lengths = [n for kind, n in h.calls if kind == "final"]
    assert len(lengths) == 2
    assert lengths[0] == 26 * FRAME  # cut right after the quieter frame
    assert sum(lengths) == (25 + 1 + 24 + 3) * FRAME  # nothing lost or duplicated


def test_silence_timeout_ends_session():
    h = Harness(preview=False, pause_ms=96, silence_timeout_s=1.0)
    async def go():
        s = h.session()
        await s.feed(pcm(0.9, 10) + pcm(0.0, 3))
        await s.feed(pcm(0.0, 40))
        await s.done.wait()
    asyncio.run(go())
    assert h.events[-1] == {"type": "ended", "reason": "silence"}


def test_session_limit():
    h = Harness(preview=False, pause_ms=96, max_session_s=1.0)
    async def go():
        s = h.session()
        await s.feed(pcm(0.0, 40))
        await s.done.wait()
    asyncio.run(go())
    assert h.events[-1] == {"type": "ended", "reason": "limit"}


def test_send_command_strips_words_and_emits_command():
    h = Harness(texts=["Fix the bug, send it."], preview=False, pause_ms=96, commands={"send": "send it", "stop": "stop listening"})
    async def go():
        s = h.session()
        await s.feed(pcm(0.9, 10) + pcm(0.0, 3))
        await s.finish()
    asyncio.run(go())
    assert [e for e in h.events if e["type"] in ("final", "command")] == [
        {"type": "final", "seq": 0, "text": "Fix the bug"},
        {"type": "command", "name": "send"},
    ]


def test_stop_command_ends_session():
    h = Harness(texts=["That's all. Stop listening."], preview=False, pause_ms=96, commands={"send": "send it", "stop": "stop listening"})
    async def go():
        s = h.session()
        await s.feed(pcm(0.9, 10) + pcm(0.0, 3))
        await s.done.wait()
    asyncio.run(go())
    assert h.events[-1] == {"type": "ended", "reason": "command"}
    assert {"type": "final", "seq": 0, "text": "That's all."} in h.events


def test_command_only_at_phrase_end():
    assert strip_command("I'll send it tomorrow.", {"send": "send it"}) == ("I'll send it tomorrow.", None)
    assert strip_command("Okay, SEND IT!", {"send": "send it"}) == ("Okay", "send")
    assert strip_command("send it", {"send": "send it"}) == ("", "send")


def test_partial_skipped_when_transcriber_busy():
    class Busy(Harness):
        async def transcribe(self, audio, partial):
            if partial:
                return None
            return await super().transcribe(audio, partial)
    h = Busy(pause_ms=96)
    async def go():
        s = h.session()
        for _ in range(5):
            await s.feed(pcm(0.9, 10))
            await asyncio.sleep(0)
        await s.finish()
    asyncio.run(go())
    assert "partial" not in types(h.events) and "final" in types(h.events)


def test_options_from_json_validates():
    o = StreamOptions.from_json({"pause_ms": 500, "silence_timeout_s": 8, "commands": {"send": "send it"}, "preview": False, "custom_words": ["tmux"]})
    assert (o.pause_ms, o.silence_timeout_s, o.preview, o.custom_words) == (500, 8.0, False, ("tmux",))
    with pytest.raises(ValueError):
        StreamOptions.from_json({"pause_ms": 50})
    with pytest.raises(ValueError):
        StreamOptions.from_json({"commands": {"launch": "go"}})
```

- [ ] **Step 2: Run** `uv run --project server --with pytest pytest tests/test_stream.py -q` → FAIL (`No module named 'parakeet_stream'`).

- [ ] **Step 3: Implement** — `server/parakeet_stream.py`:
```python
"""Streaming dictation session: VAD endpointing, live partials, ordered finals, voice commands.

Audio time (frames fed), not wall time, drives every decision so behavior is deterministic.
"""
from __future__ import annotations

import asyncio
import re
from collections import deque
from dataclasses import dataclass
from typing import Awaitable, Callable

import numpy as np

from parakeet_audio import SAMPLE_RATE
from parakeet_endpoint import FRAME, Endpointer
from parakeet_text import postprocess

FRAME_S = FRAME / SAMPLE_RATE
COMMAND_NAMES = ("send", "stop")


@dataclass(frozen=True)
class StreamOptions:
    pause_ms: int = 600
    silence_timeout_s: float | None = None
    commands: dict[str, str] | None = None
    preview: bool = True
    custom_words: tuple[str, ...] = ()
    remove_fillers: bool = True
    correction_threshold: float = 0.18
    max_phrase_s: float = 15.0
    max_session_s: float = 900.0
    preroll_ms: int = 200

    @classmethod
    def from_json(cls, raw: dict) -> "StreamOptions":
        try:
            pause_ms = int(raw.get("pause_ms", 600))
            timeout = raw.get("silence_timeout_s")
            timeout = None if timeout is None else float(timeout)
            commands = raw.get("commands")
            words = tuple(str(w) for w in raw.get("custom_words", []))
            threshold = float(raw.get("correction_threshold", 0.18))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid stream options: {exc}") from exc
        if not 300 <= pause_ms <= 1500:
            raise ValueError("pause_ms must be 300-1500")
        if timeout is not None and not 1 <= timeout <= 600:
            raise ValueError("silence_timeout_s must be 1-600 or null")
        if commands is not None:
            if not isinstance(commands, dict) or any(k not in COMMAND_NAMES or not isinstance(v, str) or not v.strip() for k, v in commands.items()):
                raise ValueError("commands must map send/stop to phrases")
        return cls(pause_ms=pause_ms, silence_timeout_s=timeout, commands=commands or None, preview=bool(raw.get("preview", True)),
                   custom_words=words, remove_fillers=bool(raw.get("remove_fillers", True)), correction_threshold=threshold)


def _words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", s.lower())


def strip_command(text: str, commands: dict[str, str]) -> tuple[str, str | None]:
    tokens = text.split()
    for name, phrase in commands.items():
        want = _words(phrase)
        if not want:
            continue
        got: list[str] = []
        i = len(tokens)
        while i > 0 and len(got) < len(want):
            i -= 1
            got = _words(tokens[i]) + got
        if got == want:
            return " ".join(tokens[:i]).rstrip(" ,;:-"), name
    return text, None


class StreamSession:
    def __init__(self, options: StreamOptions, *, transcribe: Callable[[np.ndarray, bool], Awaitable[str | None]],
                 vad_prob: Callable[[np.ndarray], float], emit: Callable[[dict], Awaitable[None]]) -> None:
        self._o = options
        self._transcribe = transcribe
        self._vad = vad_prob
        self._emit = emit
        self._ep = Endpointer(pause_frames=max(1, round(options.pause_ms / (FRAME_S * 1000))))
        self._pending = np.zeros(0, dtype=np.float32)
        self._preroll: deque[np.ndarray] = deque(maxlen=max(1, round(options.preroll_ms / (FRAME_S * 1000))))
        self._phrase: list[np.ndarray] | None = None
        self._probs: list[float] = []
        self._open_seq = 0
        self._frames = 0
        self._last_speech = 0
        self._partial_task: asyncio.Task | None = None
        self._partial_at = 0
        self._finals: asyncio.Task | None = None
        self._finals_pending = 0
        self._ending = False
        self._tasks: set[asyncio.Task] = set()
        self.done = asyncio.Event()

    # ---- input ----
    async def feed(self, pcm16: bytes) -> None:
        if self._ending:
            return
        samples = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        buf = np.concatenate([self._pending, samples])
        n = len(buf) // FRAME
        for i in range(n):
            await self._on_frame(buf[i * FRAME : (i + 1) * FRAME])
            if self._ending:
                return
        self._pending = buf[n * FRAME :]
        self._maybe_partial()

    async def _on_frame(self, frame: np.ndarray) -> None:
        self._frames += 1
        prob = self._vad(frame)
        event = self._ep.push(prob)
        if self._phrase is None:
            self._preroll.append(frame)
            if event == "start":
                self._phrase = list(self._preroll)
                self._probs = [prob] * len(self._phrase)
                self._preroll.clear()
                self._partial_at = 0
        else:
            self._phrase.append(frame)
            self._probs.append(prob)
            if event == "end":
                self._close(len(self._phrase))
            elif len(self._phrase) * FRAME_S >= self._o.max_phrase_s:
                self._force_cut()
        if self._phrase is not None:
            self._last_speech = self._frames
        if self._frames * FRAME_S >= self._o.max_session_s:
            await self.finish("limit")
        elif (self._phrase is None and self._o.silence_timeout_s is not None
              and (self._frames - self._last_speech) * FRAME_S >= self._o.silence_timeout_s):
            await self.finish("silence")

    # ---- phrases ----
    def _force_cut(self) -> None:
        window = min(len(self._probs), max(1, round(2.0 / FRAME_S)))
        start = len(self._probs) - window
        quiet = start + int(np.argmin(self._probs[start:]))
        self._close(quiet + 1)

    def _close(self, k: int) -> None:
        assert self._phrase is not None
        audio = np.concatenate(self._phrase[:k])
        rest, rest_probs = self._phrase[k:], self._probs[k:]
        seq = self._open_seq
        self._open_seq += 1
        self._finals_pending += 1
        self._finals = self._spawn(self._run_final(self._finals, seq, audio))
        if rest:
            self._phrase, self._probs, self._partial_at = rest, rest_probs, 0
        else:
            self._phrase, self._probs = None, []

    async def _run_final(self, prev: asyncio.Task | None, seq: int, audio: np.ndarray) -> None:
        if prev is not None:
            await asyncio.gather(prev, return_exceptions=True)
        try:
            raw = await self._transcribe(audio, False) or ""
        except Exception as exc:  # engine/lock failures surface to the client, session continues
            raw = ""
            await self._emit({"type": "error", "message": f"transcription failed: {exc}"})
        text = postprocess(raw, custom_words=list(self._o.custom_words), remove_fillers_=self._o.remove_fillers, threshold=self._o.correction_threshold)
        command = None
        if self._o.commands:
            text, command = strip_command(text, self._o.commands)
        self._finals_pending -= 1
        await self._emit({"type": "final", "seq": seq, "text": text})
        if command:
            await self._emit({"type": "command", "name": command})
            if command == "stop":
                self._spawn(self.finish("command"))

    def _maybe_partial(self) -> None:
        if (not self._o.preview or self._ending or self._phrase is None or self._finals_pending
                or (self._partial_task is not None and not self._partial_task.done())):
            return
        n = len(self._phrase)
        if n * FRAME_S < 0.5 or (n - self._partial_at) * FRAME_S < 0.25:
            return
        self._partial_at = n
        self._partial_task = self._spawn(self._run_partial(self._open_seq, np.concatenate(self._phrase)))

    async def _run_partial(self, seq: int, audio: np.ndarray) -> None:
        try:
            text = await self._transcribe(audio, True)
        except Exception:  # a failed preview is not worth surfacing; the final will report
            return
        if text is None or self._ending or seq != self._open_seq or self._phrase is None or self._finals_pending:
            return
        await self._emit({"type": "partial", "seq": seq, "text": text.strip()})

    # ---- lifecycle ----
    async def finish(self, reason: str = "stopped") -> None:
        if self._ending:
            await self.done.wait()
            return
        self._ending = True
        if self._phrase is not None:
            if len(self._pending):
                self._phrase.append(self._pending)
                self._pending = np.zeros(0, dtype=np.float32)
            self._close(len(self._phrase))
        if self._partial_task is not None:
            self._partial_task.cancel()
        if self._finals is not None:
            await asyncio.gather(self._finals, return_exceptions=True)
        await self._emit({"type": "ended", "reason": reason})
        self.done.set()

    def abort(self) -> None:
        self._ending = True
        for t in list(self._tasks):
            t.cancel()
        self.done.set()

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task
```

- [ ] **Step 4: Run** `uv run --project server --with pytest pytest tests -q` → all pass. If `test_partials_emitted_while_speaking` finds no partials because the fake transcriber resolves only after `finish`, add `await asyncio.sleep(0)` twice per loop iteration in the test — do not change scheduling rules.

- [ ] **Step 5: Commit** `feat(parakeet-stt): streaming session with partials, ordered finals, commands`

---

### Task 3: `/v1/stream` websocket route

**Files:**
- Modify: `plugins/parakeet-stt/server/parakeet_server.py`
- Create: `plugins/parakeet-stt/tests/test_stream_route.py`
- Modify: `plugins/parakeet-stt/tests/test_engine_integration.py` (real-model stream test)

**Interfaces:**
- Consumes: `StreamOptions`, `StreamSession` (Task 2); `ParakeetEngine.new_vad()` (Task 1).
- Produces: `create_app(cfg, engine, *, load_in_background=True, vad_factory=None)`; `async run_transcription(app, audio, *, partial: bool) -> str | None`; route `GET /v1/stream` (websocket).

- [ ] **Step 1: Failing tests** — `tests/test_stream_route.py`:
```python
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
```

Append to `tests/test_engine_integration.py`:
```python
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
```

- [ ] **Step 2: Run** `uv run --project server --with pytest pytest tests/test_stream_route.py -q` → FAIL (404 on ws_connect / unexpected kwarg `vad_factory`).

- [ ] **Step 3: Implement** in `server/parakeet_server.py`:

Imports: `from aiohttp import WSMsgType, web` and `from parakeet_stream import StreamOptions, StreamSession`. New key: `VAD_FACTORY = web.AppKey("vad_factory", object)`.

Replace the lock/executor block inside `transcriptions` with a call to a shared helper, and add the helper:
```python
class Busy(Exception):
    pass


async def run_transcription(app: web.Application, audio, *, partial: bool) -> str | None:
    """Serialize inference. Partials never wait: they return None if the model is busy."""
    lock, cfg, engine = app[LOCK], app[CFG], app[ENGINE]
    if partial:
        if lock.locked():
            return None
        await lock.acquire()
    else:
        try:
            await asyncio.wait_for(lock.acquire(), timeout=cfg.queue_timeout_s)
        except TimeoutError as exc:
            raise Busy() from exc
    try:
        return await asyncio.get_running_loop().run_in_executor(None, engine.transcribe, audio)
    finally:
        lock.release()
```
In `transcriptions`:
```python
    started = time.perf_counter()
    try:
        raw = await run_transcription(request.app, audio, partial=False) or ""
    except Busy:
        return error(503, "busy", "Server busy; retry shortly", "server_error")
    except Exception as exc:  # engine errors are opaque onnxruntime failures
        log.exception("transcription failed")
        return error(500, "transcription_failed", f"Transcription failed: {exc}", "server_error")
```

Middleware: skip the bearer check for the stream path —
```python
    if request.path.startswith("/v1/") and request.path != "/v1/stream" and cfg.api_key:
```

Stream handler:
```python
async def stream(request: web.Request) -> web.WebSocketResponse:
    cfg, engine = request.app[CFG], request.app[ENGINE]
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=1 << 20)
    await ws.prepare(request)

    async def reject(code: int, message: str) -> web.WebSocketResponse:
        await ws.send_json({"type": "error", "message": message})
        await ws.close(code=code, message=message.encode()[:120])
        return ws

    try:
        first = await ws.receive(timeout=10)
    except TimeoutError:
        return await reject(4400, "start message not received")
    try:
        start = first.json() if first.type == WSMsgType.TEXT else {}
    except ValueError:
        start = {}
    if start.get("type") != "start":
        return await reject(4400, "first message must be start")
    if cfg.api_key and not hmac.compare_digest(str(start.get("api_key") or "").encode(), cfg.api_key.encode()):
        return await reject(4401, "Invalid or missing API key")
    if not engine.ready:
        return await reject(4503, "Model is still loading; retry shortly")
    try:
        options = StreamOptions.from_json(start.get("options") or {})
    except ValueError as exc:
        return await reject(4400, str(exc))

    async def emit(msg: dict) -> None:
        if not ws.closed:
            await ws.send_json(msg)

    async def transcribe(audio, partial: bool):
        return await run_transcription(request.app, audio, partial=partial)

    session = StreamSession(options, transcribe=transcribe, vad_prob=request.app[VAD_FACTORY]().prob, emit=emit)
    await ws.send_json({"type": "ready"})
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                await session.feed(msg.data)
            elif msg.type == WSMsgType.TEXT:
                try:
                    kind = msg.json().get("type")
                except ValueError:
                    kind = None
                if kind == "stop":
                    await session.finish("stopped")
            if session.done.is_set():
                break
    finally:
        if not session.done.is_set():
            session.abort()  # client went away: drop queued work
    await ws.close()
    return ws
```
In `create_app`, add parameter `vad_factory=None`, set `app[VAD_FACTORY] = vad_factory or engine.new_vad`, and register `app.router.add_get("/v1/stream", stream)`.

- [ ] **Step 4: Run** `uv run --project server --with pytest pytest tests -q` → all pass; `PARAKEET_INTEGRATION=1 … tests/test_engine_integration.py -q` → 3 passed.

- [ ] **Step 5: Commit** `feat(parakeet-stt): /v1/stream websocket endpoint`

---

### Task 4: Plugin shared pieces — prefs, protocol, draft tail, resampler, press detector

**Files:**
- Modify: `plugins/parakeet-stt/bb/schemas.ts`, `bb/prefs.ts`, `bb/prefs.test.ts`
- Create: `bb/stream-protocol.ts` + test, `bb/draft-tail.ts` + test, `bb/pcm.ts` + test, `bb/press.ts` + test

**Interfaces:**
- Produces:
  ```ts
  // schemas.ts additions to prefsSchema
  mode: "continuous" | "oneshot"; livePreview: boolean; pauseMs: number; endOnSilence: boolean; silenceTimeoutS: number;
  voiceCommands: boolean; sendPhrase: string; stopPhrase: string; hideNativeMic: boolean;
  // stream-protocol.ts
  export type EndReason = "stopped" | "silence" | "command" | "limit" | "error";
  export type ServerEvent = { type: "ready" } | { type: "partial"; seq: number; text: string } | { type: "final"; seq: number; text: string } | { type: "command"; name: "send" | "stop" } | { type: "ended"; reason: EndReason } | { type: "error"; message: string };
  export function parseServerEvent(data: unknown): ServerEvent | null;
  export function streamOptionsFrom(p: Prefs): Record<string, unknown>;
  export function upstreamUrl(serverUrl: string): string;
  // draft-tail.ts
  export function replaceTail(draft: string, prevTail: string, text: string): { draft: string; tail: string };
  export function tailRange(draft: string, tail: string): { from: number; to: number } | null;
  export const liveTail: { get(): string; set(t: string): void };
  // pcm.ts
  export const FRAME_SAMPLES = 320;
  export class Resampler16k { constructor(inputRate: number); push(input: Float32Array): Int16Array[] }
  // press.ts
  export function createPressDetector(o: { holdMs: number; onTap(): void; onHoldStart(): void; onHoldEnd(): void; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void }): { down(): void; up(): void; cancel(): void };
  ```

- [ ] **Step 1: Failing tests.**

Append to `bb/prefs.test.ts`:
```ts
test("streaming defaults", () => {
  assert.equal(DEFAULT_PREFS.mode, "continuous");
  assert.equal(DEFAULT_PREFS.livePreview, true);
  assert.equal(DEFAULT_PREFS.pauseMs, 600);
  assert.equal(DEFAULT_PREFS.endOnSilence, false);
  assert.equal(DEFAULT_PREFS.silenceTimeoutS, 8);
  assert.equal(DEFAULT_PREFS.voiceCommands, false);
  assert.equal(DEFAULT_PREFS.sendPhrase, "send it");
  assert.equal(DEFAULT_PREFS.stopPhrase, "stop listening");
  assert.equal(DEFAULT_PREFS.hideNativeMic, true);
});

test("prefs saved before streaming existed load with streaming defaults", async () => {
  const store = new PrefsStore(memKv({ prefs: { shortcut: "alt+space", customWords: ["tmux"] } }));
  const p = await store.load();
  assert.equal(p.shortcut, "alt+space");
  assert.equal(p.mode, "continuous");
});
```

`bb/stream-protocol.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS } from "./prefs.ts";
import { parseServerEvent, streamOptionsFrom, upstreamUrl } from "./stream-protocol.ts";

test("parses known events and rejects junk", () => {
  assert.deepEqual(parseServerEvent('{"type":"partial","seq":2,"text":"hi"}'), { type: "partial", seq: 2, text: "hi" });
  assert.deepEqual(parseServerEvent('{"type":"ended","reason":"silence"}'), { type: "ended", reason: "silence" });
  assert.equal(parseServerEvent("nope"), null);
  assert.equal(parseServerEvent('{"type":"ended","reason":"bored"}'), null);
  assert.equal(parseServerEvent(new Uint8Array([1])), null);
});

test("options follow prefs", () => {
  assert.deepEqual(streamOptionsFrom({ ...DEFAULT_PREFS, customWords: ["tmux"] }), {
    pause_ms: 600, silence_timeout_s: null, commands: null, preview: true,
    custom_words: ["tmux"], remove_fillers: true, correction_threshold: 0.18,
  });
  const o = streamOptionsFrom({ ...DEFAULT_PREFS, endOnSilence: true, voiceCommands: true, livePreview: false });
  assert.equal(o.silence_timeout_s, 8);
  assert.deepEqual(o.commands, { send: "send it", stop: "stop listening" });
  assert.equal(o.preview, false);
});

test("upstream url", () => {
  assert.equal(upstreamUrl("https://stt.example.com/"), "wss://stt.example.com/v1/stream");
  assert.equal(upstreamUrl("http://127.0.0.1:6790"), "ws://127.0.0.1:6790/v1/stream");
});
```

`bb/draft-tail.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceTail, tailRange } from "./draft-tail.ts";

test("partials replace the live tail; commit makes it solid", () => {
  let r = replaceTail("Fix the", "", "bug in");
  assert.deepEqual(r, { draft: "Fix the bug in", tail: " bug in" });
  r = replaceTail(r.draft, r.tail, "bug in parsing");
  assert.deepEqual(r, { draft: "Fix the bug in parsing", tail: " bug in parsing" });
  const committed = replaceTail(r.draft, r.tail, "bug in parsing.");
  assert.equal(committed.draft, "Fix the bug in parsing.");
});

test("empty text clears the tail", () => {
  assert.deepEqual(replaceTail("a b", " b", ""), { draft: "a", tail: "" });
});

test("tail re-anchors after user edits", () => {
  // user typed after the live tail appeared
  const r = replaceTail("Fix the bug in! (edited)", " bug in", "bug in parsing");
  assert.equal(r.draft, "Fix the bug in! (edited) bug in parsing");
});

test("empty draft gets no leading space; newline counts as whitespace", () => {
  assert.deepEqual(replaceTail("", "", "Hi"), { draft: "Hi", tail: "Hi" });
  assert.deepEqual(replaceTail("a\n", "", "Hi"), { draft: "a\nHi", tail: "Hi" });
});

test("tailRange covers the tail words only", () => {
  assert.deepEqual(tailRange("Fix the bug in", " bug in"), { from: 8, to: 14 });
  assert.equal(tailRange("Fix the", " bug"), null);
  assert.equal(tailRange("Fix", ""), null);
});
```

`bb/pcm.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_SAMPLES, Resampler16k } from "./pcm.ts";

test("16 kHz input passes through in 20 ms frames", () => {
  const r = new Resampler16k(16000);
  const frames = r.push(new Float32Array(700).fill(0.5));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, FRAME_SAMPLES);
  assert.ok(Math.abs(frames[0][0] - 16384) <= 1);
  assert.equal(r.push(new Float32Array(0)).length, 0);
  assert.equal(r.push(new Float32Array(260)).length, 1); // 60 carried + 260
});

test("48 kHz downsamples 3:1 across calls without drift", () => {
  const r = new Resampler16k(48000);
  let out = 0;
  for (let i = 0; i < 300; i++) out += r.push(new Float32Array(128)).reduce((n, f) => n + f.length, 0);
  // 38400 input samples -> 12800 output samples; frames only emit when full
  assert.ok(12800 - out < FRAME_SAMPLES && out % FRAME_SAMPLES === 0);
});

test("clips out-of-range samples", () => {
  const f = new Resampler16k(16000).push(new Float32Array(320).fill(2))[0];
  assert.equal(f[0], 32767);
});
```

`bb/press.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPressDetector } from "./press.ts";

function setup() {
  const log: string[] = [];
  let fire: (() => void) | null = null;
  const d = createPressDetector({
    holdMs: 350,
    onTap: () => log.push("tap"),
    onHoldStart: () => log.push("hold-start"),
    onHoldEnd: () => log.push("hold-end"),
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => { fire = null; },
  });
  return { d, log, fire: () => fire?.() };
}

test("short press is a tap", () => {
  const s = setup();
  s.d.down(); s.d.up();
  assert.deepEqual(s.log, ["tap"]);
});

test("long press holds until release", () => {
  const s = setup();
  s.d.down(); s.fire(); s.d.up();
  assert.deepEqual(s.log, ["hold-start", "hold-end"]);
});

test("cancel during a hold ends it; cancel before the timer does nothing", () => {
  const a = setup();
  a.d.down(); a.fire(); a.d.cancel();
  assert.deepEqual(a.log, ["hold-start", "hold-end"]);
  const b = setup();
  b.d.down(); b.d.cancel(); b.fire();
  assert.deepEqual(b.log, []);
});
```

- [ ] **Step 2: Run** `node --test bb/stream-protocol.test.ts bb/draft-tail.test.ts bb/pcm.test.ts bb/press.test.ts bb/prefs.test.ts` → FAIL (modules missing; new prefs fields undefined).

- [ ] **Step 3: Implement.**

`bb/schemas.ts` — add to the `prefsSchema` object:
```ts
  mode: z.enum(["continuous", "oneshot"]),
  livePreview: z.boolean(),
  pauseMs: z.number().int().min(300).max(1500),
  endOnSilence: z.boolean(),
  silenceTimeoutS: z.number().int().min(3).max(60),
  voiceCommands: z.boolean(),
  sendPhrase: z.string().trim().min(1).max(40),
  stopPhrase: z.string().trim().min(1).max(40),
  hideNativeMic: z.boolean(),
```
`bb/prefs.ts` — add to `DEFAULT_PREFS`:
```ts
  mode: "continuous",
  livePreview: true,
  pauseMs: 600,
  endOnSilence: false,
  silenceTimeoutS: 8,
  voiceCommands: false,
  sendPhrase: "send it",
  stopPhrase: "stop listening",
  hideNativeMic: true,
```

`bb/stream-protocol.ts`:
```ts
// Messages on the page ↔ relay ↔ server stream. Shared by the relay (server) and the page.
import { z } from "zod";
import type { Prefs } from "./schemas.ts";

const endReason = z.enum(["stopped", "silence", "command", "limit", "error"]);
export type EndReason = z.infer<typeof endReason>;

const serverEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("partial"), seq: z.number().int(), text: z.string() }),
  z.object({ type: z.literal("final"), seq: z.number().int(), text: z.string() }),
  z.object({ type: z.literal("command"), name: z.enum(["send", "stop"]) }),
  z.object({ type: z.literal("ended"), reason: endReason }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

export function parseServerEvent(data: unknown): ServerEvent | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = serverEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function streamOptionsFrom(p: Prefs): Record<string, unknown> {
  return {
    pause_ms: p.pauseMs,
    silence_timeout_s: p.endOnSilence ? p.silenceTimeoutS : null,
    commands: p.voiceCommands ? { send: p.sendPhrase, stop: p.stopPhrase } : null,
    preview: p.livePreview,
    custom_words: p.customWords,
    remove_fillers: p.removeFillers,
    correction_threshold: p.correctionThreshold,
  };
}

export function upstreamUrl(serverUrl: string): string {
  const u = new URL(serverUrl.trim());
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/v1/stream`;
  return u.toString();
}
```

`bb/draft-tail.ts`:
```ts
// The live (dimmed) tail is always the draft's suffix. If the user edited the draft so it no longer
// ends with the tail, the next tail is appended after their edits.

function separator(base: string): string {
  return base === "" || /\s$/.test(base) ? "" : " ";
}

export function replaceTail(draft: string, prevTail: string, text: string): { draft: string; tail: string } {
  const base = prevTail && draft.endsWith(prevTail) ? draft.slice(0, draft.length - prevTail.length) : draft;
  const tail = text ? `${separator(base)}${text}` : "";
  return { draft: base + tail, tail };
}

export function tailRange(draft: string, tail: string): { from: number; to: number } | null {
  if (!tail || !draft.endsWith(tail)) return null;
  const lead = tail.length - tail.trimStart().length;
  return { from: draft.length - tail.length + lead, to: draft.length };
}

let current = "";
export const liveTail = {
  get: (): string => current,
  set: (t: string): void => { current = t; },
};
```

`bb/pcm.ts`:
```ts
// Float32 audio at the AudioContext rate → Int16 at 16 kHz in 20 ms frames, state carried across calls.
export const FRAME_SAMPLES = 320;

export class Resampler16k {
  #ratio: number;
  #pos = 0; // fractional read position into #carry + next input
  #carry: Float32Array = new Float32Array(0);
  #out: number[] = [];

  constructor(inputRate: number) {
    this.#ratio = inputRate / 16000;
  }

  push(input: Float32Array): Int16Array[] {
    const buf = new Float32Array(this.#carry.length + input.length);
    buf.set(this.#carry);
    buf.set(input, this.#carry.length);
    const step = this.#ratio;
    let pos = this.#pos;
    while (pos + (step > 1 ? step : 1) <= buf.length) {
      let v: number;
      if (step > 1) {
        // box filter over the input window this output sample covers
        const a = Math.floor(pos);
        const b = Math.min(buf.length, Math.floor(pos + step));
        let sum = 0;
        for (let i = a; i < b; i++) sum += buf[i];
        v = sum / Math.max(1, b - a);
      } else {
        const i = Math.floor(pos);
        const frac = pos - i;
        v = i + 1 < buf.length ? buf[i] * (1 - frac) + buf[i + 1] * frac : buf[i];
      }
      this.#out.push(Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
      pos += step;
    }
    const consumed = Math.floor(pos);
    this.#carry = buf.slice(consumed);
    this.#pos = pos - consumed;
    const frames: Int16Array[] = [];
    while (this.#out.length >= FRAME_SAMPLES) frames.push(Int16Array.from(this.#out.splice(0, FRAME_SAMPLES)));
    return frames;
  }
}
```

`bb/press.ts`:
```ts
// Tap vs press-and-hold on one button: a press held for holdMs becomes push-to-talk until release.
export function createPressDetector(o: {
  holdMs: number;
  onTap(): void;
  onHoldStart(): void;
  onHoldEnd(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}) {
  let timer: unknown = null;
  let holding = false;
  return {
    down() {
      if (timer !== null || holding) return;
      timer = o.setTimer(() => { timer = null; holding = true; o.onHoldStart(); }, o.holdMs);
    },
    up() {
      if (holding) { holding = false; o.onHoldEnd(); return; }
      if (timer !== null) { o.clearTimer(timer); timer = null; o.onTap(); }
    },
    cancel() {
      if (holding) { holding = false; o.onHoldEnd(); return; }
      if (timer !== null) { o.clearTimer(timer); timer = null; }
    },
  };
}
```

- [ ] **Step 4: Run** `npm test && npx tsc --noEmit` → all pass.

- [ ] **Step 5: Commit** `feat(parakeet-stt): streaming prefs, protocol, draft tail, resampler, press detector`

---

### Task 5: Stream relay in the plugin backend

**Files:**
- Create: `plugins/parakeet-stt/bb/stream-relay.ts`, `bb/stream-relay.test.ts`
- Modify: `plugins/parakeet-stt/bb/server.ts` (register websocket + GET `/prefs`)

**Interfaces:**
- Consumes: `streamOptionsFrom`, `upstreamUrl` (Task 4); `Prefs`.
- Produces: `export interface PageSocket { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void; readonly readyState: number }`; `export interface UpstreamSocket { binaryType: string; readyState: number; send(data: string | Uint8Array): void; close(code?: number, reason?: string): void; onopen: (() => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onclose: ((ev: { code: number; reason: string }) => void) | null; onerror: (() => void) | null }`; `export function createStreamRelay(deps: { config(): { serverUrl: string; apiKey: string }; prefs(): Prefs; connect(url: string): UpstreamSocket; log(msg: string): void }): () => { onMessage(page: PageSocket, data: string | Uint8Array): void; onClose(): void }`.

- [ ] **Step 1: Failing test** — `bb/stream-relay.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS } from "./prefs.ts";
import { createStreamRelay, type PageSocket, type UpstreamSocket } from "./stream-relay.ts";

function page() {
  const sent: (string | Uint8Array)[] = [];
  const s: PageSocket & { sent: typeof sent; closed: number | null } = {
    sent, closed: null, readyState: 1,
    send(d) { sent.push(d); },
    close(code) { this.closed = code ?? 1000; },
  };
  return s;
}

function upstream() {
  const sent: (string | Uint8Array)[] = [];
  const u: UpstreamSocket & { sent: typeof sent; closedWith: number | null; url?: string } = {
    sent, closedWith: null, binaryType: "blob", readyState: 0,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(d) { sent.push(d); },
    close(code) { this.closedWith = code ?? 1000; },
  };
  return u;
}

function relay(serverUrl = "https://stt.example") {
  const up = upstream();
  const handler = createStreamRelay({
    config: () => ({ serverUrl, apiKey: "k" }),
    prefs: () => ({ ...DEFAULT_PREFS, customWords: ["tmux"] }),
    connect: (url) => { up.url = url; return up; },
    log: () => {},
  })();
  return { up, handler };
}

test("start opens upstream with key and prefs, then pipes both ways", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  assert.equal(up.url, "wss://stt.example/v1/stream");
  up.readyState = 1; up.onopen!();
  const start = JSON.parse(up.sent[0] as string);
  assert.equal(start.type, "start");
  assert.equal(start.api_key, "k");
  assert.deepEqual(start.options.custom_words, ["tmux"]);
  handler.onMessage(p, new Uint8Array([1, 2]));
  assert.deepEqual(up.sent[1], new Uint8Array([1, 2]));
  up.onmessage!({ data: '{"type":"ready"}' });
  assert.deepEqual(p.sent, ['{"type":"ready"}']);
});

test("queues frames until upstream opens", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  handler.onMessage(p, new Uint8Array([7]));
  handler.onMessage(p, '{"type":"stop"}');
  assert.equal(up.sent.length, 0);
  up.readyState = 1; up.onopen!();
  assert.equal(JSON.parse(up.sent[0] as string).type, "start");
  assert.deepEqual(up.sent.slice(1), [new Uint8Array([7]), '{"type":"stop"}']);
});

test("abnormal upstream close tells the page", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  up.onclose!({ code: 1006, reason: "" });
  assert.deepEqual(p.sent.map((m) => JSON.parse(m as string).type), ["error", "ended"]);
  assert.equal(JSON.parse(p.sent[1] as string).reason, "error");
  assert.ok(p.closed !== null);
});

test("server rejection message is forwarded before ended", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  up.onmessage!({ data: '{"type":"error","message":"Invalid or missing API key"}' });
  up.onclose!({ code: 4401, reason: "Invalid or missing API key" });
  assert.equal(JSON.parse(p.sent[0] as string).message, "Invalid or missing API key");
  assert.deepEqual(p.sent.map((m) => JSON.parse(m as string).type), ["error", "ended"]); // one error, not two
});

test("no server url -> error + ended without connecting", () => {
  const { up, handler } = relay("");
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  assert.equal(up.url, undefined);
  assert.deepEqual(p.sent.map((m) => JSON.parse(m as string).type), ["error", "ended"]);
});

test("page closing closes upstream", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  handler.onClose();
  assert.equal(up.closedWith, 1000);
});

test("ended from server passes through and does not add a second ended", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  up.onmessage!({ data: '{"type":"ended","reason":"stopped"}' });
  up.onclose!({ code: 1000, reason: "" });
  assert.equal(p.sent.filter((m) => (m as string).includes('"ended"')).length, 1);
});
```

- [ ] **Step 2: Run** `node --test bb/stream-relay.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `bb/stream-relay.ts`:
```ts
// Relays one page stream to the Parakeet server's /v1/stream, adding the API key and prefs so the
// browser never sees the key. Frames sent before the upstream opens are queued (bounded).
import type { Prefs } from "./schemas.ts";
import { streamOptionsFrom, upstreamUrl } from "./stream-protocol.ts";

export interface PageSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface UpstreamSocket {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

const MAX_QUEUED_BYTES = 5 * 16000 * 2; // ~5 s of PCM16

export function createStreamRelay(deps: {
  config(): { serverUrl: string; apiKey: string };
  prefs(): Prefs;
  connect(url: string): UpstreamSocket;
  log(msg: string): void;
}) {
  return () => {
    let up: UpstreamSocket | null = null;
    let open = false;
    let finished = false;
    let sawError = false;
    let queuedBytes = 0;
    const queue: (string | Uint8Array)[] = [];

    const toPage = (page: PageSocket, msg: object) => { if (page.readyState === 1) page.send(JSON.stringify(msg)); };
    const end = (page: PageSocket, message: string | null) => {
      if (finished) return;
      finished = true;
      if (message) toPage(page, { type: "error", message });
      toPage(page, { type: "ended", reason: "error" });
      page.close(1011, "stream ended");
    };

    const openUpstream = (page: PageSocket) => {
      const { serverUrl, apiKey } = deps.config();
      if (!serverUrl.trim()) return end(page, "Parakeet STT server URL is not set");
      let url: string;
      try { url = upstreamUrl(serverUrl); } catch { return end(page, `invalid server URL ${serverUrl}`); }
      const sock = deps.connect(url);
      up = sock;
      sock.binaryType = "arraybuffer";
      sock.onopen = () => {
        open = true;
        sock.send(JSON.stringify({ type: "start", api_key: apiKey, options: streamOptionsFrom(deps.prefs()) }));
        for (const m of queue.splice(0)) sock.send(m);
        queuedBytes = 0;
      };
      sock.onmessage = (ev) => {
        if (typeof ev.data !== "string" || finished) return;
        if (ev.data.includes('"type":"ended"')) finished = true;
        if (ev.data.includes('"type":"error"')) sawError = true;
        if (page.readyState === 1) page.send(ev.data);
      };
      sock.onerror = () => deps.log("upstream stream error");
      sock.onclose = (ev) => {
        if (finished) { page.close(1000, "done"); return; }
        end(page, sawError ? null : ev.reason || `Parakeet STT stream closed (${ev.code})`);
      };
    };

    return {
      onMessage(page: PageSocket, data: string | Uint8Array) {
        if (finished) return;
        if (typeof data === "string") {
          let kind: unknown;
          try { kind = (JSON.parse(data) as { type?: unknown }).type; } catch { return; }
          if (kind === "start" && !up) return openUpstream(page);
          if (kind !== "stop" || !up) return;
        } else if (!up) {
          return;
        }
        if (open && up) up.send(data);
        else if (typeof data === "string" || queuedBytes + data.byteLength <= MAX_QUEUED_BYTES) {
          queue.push(data);
          if (typeof data !== "string") queuedBytes += data.byteLength;
        }
      },
      onClose() {
        finished = true;
        up?.close(1000, "page closed");
      },
    };
  };
}
```

`bb/server.ts` — after the RPC registration:
```ts
  bb.http.experimental_websocket("/stream", createStreamRelay({
    config: () => ({ serverUrl: current.serverUrl, apiKey: current.apiKey ?? "" }),
    prefs: () => prefs.get(),
    connect: (url) => new WebSocket(url) as unknown as UpstreamSocket,
    log: (m) => bb.log.warn(m),
  }));
  bb.http.route("GET", "/prefs", () => Response.json(prefs.get()));
```
with `import { createStreamRelay, type UpstreamSocket } from "./stream-relay.ts";`. Node ≥ 22's global `WebSocket` delivers `data` as `ArrayBuffer` for binary; the relay ignores binary from upstream (the server never sends binary).

- [ ] **Step 4: Run** `npm test && npx tsc --noEmit` → pass. `bb plugin reload parakeet-stt` → running.

- [ ] **Step 5: Commit** `feat(parakeet-stt): plugin websocket relay to /v1/stream`

---

### Task 6: Controller continuous mode

**Files:**
- Modify: `plugins/parakeet-stt/bb/dictation.ts`, `bb/dictation.test.ts`

**Interfaces:**
- Consumes: `EndReason` (Task 4).
- Produces:
  ```ts
  export type Mode = "continuous" | "oneshot";
  export type Phase = "idle" | "recording" | "transcribing" | "streaming" | "finishing";
  export interface Target { id: string; appendText(text: string): void; submit(): void; setLive(text: string): void; commitLive(text: string): void }
  export interface StreamHandlers { onPartial(text: string): void; onFinal(text: string): void; onCommand(name: "send" | "stop"): void; onEnded(reason: EndReason): void; onError(message: string): void }
  export interface StreamHandle { stop(): Promise<void>; cancel(): void }
  // DictationDeps additions
  startStream?(handlers: StreamHandlers, onInterrupt: (why: Interruption) => void): Promise<StreamHandle>;
  prefs(): { autoSubmit: boolean; trailingSpace: boolean; soundCues: boolean; mode: Mode; livePreview: boolean };
  // DictationController: start(targetId?: string, mode?: Mode)
  ```

- [ ] **Step 1: Update the harness and add failing tests.** In `bb/dictation.test.ts`, the harness `prefs` becomes `() => ({ autoSubmit: false, trailingSpace: false, soundCues: true, mode: "oneshot" as const, livePreview: true })` and every other `prefs: () => ({...})` literal in the file gains `mode: "oneshot" as const, livePreview: true`; every `register({...})` target gains `setLive() {}, commitLive() {}`. Append:
```ts
function streamHarness(over: Partial<DictationDeps> = {}) {
  const log: string[] = [];
  let handlers: import("./dictation.ts").StreamHandlers | null = null;
  let interrupt: ((w: Interruption) => void) | null = null;
  let draft = "Start.";
  let live = "";
  const deps: DictationDeps = {
    async startRecording() { log.push("oneshot:start"); return { async stop() { return new Blob(["x"]); }, cancel() {} }; },
    async transcribe() { return "one shot text"; },
    async startStream(h, onInterrupt) {
      handlers = h; interrupt = onInterrupt; log.push("stream:start");
      return {
        async stop() { log.push("stream:stop"); h.onEnded("stopped"); },
        cancel() { log.push("stream:cancel"); },
      };
    },
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: false, mode: "continuous", livePreview: true }),
    playSound: () => {},
    notify: (k, m) => log.push(`${k}:${m}`),
    now: () => 0,
    ...over,
  };
  const c = new DictationController(deps);
  c.register({
    id: "t1",
    appendText: (t) => { draft = `${draft} ${t}`; },
    submit: () => log.push("submit"),
    setLive: (t) => { live = t; },
    commitLive: (t) => { live = ""; if (t) draft = `${draft} ${t}`; },
  });
  return { c, log, h: () => handlers!, interrupt: (w: Interruption) => interrupt!(w), draft: () => draft, live: () => live };
}

test("continuous: partials set the live tail, finals commit, send submits, stop ends", async () => {
  const s = streamHarness();
  await s.c.toggle();
  assert.equal(s.c.snapshot().phase, "streaming");
  s.h().onPartial("hello wor");
  assert.equal(s.live(), "hello wor");
  s.h().onFinal("Hello world.");
  assert.equal(s.live(), "");
  assert.equal(s.draft(), "Start. Hello world.");
  s.h().onCommand("send");
  assert.ok(s.log.includes("submit"));
  await s.c.toggle();
  assert.equal(s.c.snapshot().phase, "idle");
  assert.ok(s.log.includes("stream:stop"));
});

test("continuous: live preview off ignores partials", async () => {
  const s = streamHarness({ prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: false, mode: "continuous", livePreview: false }) });
  await s.c.start();
  s.h().onPartial("ignored");
  assert.equal(s.live(), "");
});

test("continuous: connect failure falls back to one-shot", async () => {
  const s = streamHarness({ async startStream() { throw new Error("connect refused"); } });
  await s.c.start();
  assert.equal(s.c.snapshot().phase, "recording");
  assert.ok(s.log.includes("oneshot:start"));
  assert.ok(s.log.some((l) => l.startsWith("info:") && l.includes("one-shot")));
});

test("continuous: disconnect keeps the live text as solid and warns", async () => {
  const s = streamHarness();
  await s.c.start();
  s.h().onPartial("half a sen");
  s.h().onError("Parakeet STT stream closed (1006)");
  s.h().onEnded("error");
  assert.equal(s.c.snapshot().phase, "idle");
  assert.equal(s.draft(), "Start. half a sen");
  assert.ok(s.log.some((l) => l.includes("may be incomplete")));
});

test("continuous: silence end notifies", async () => {
  const s = streamHarness();
  await s.c.start();
  s.h().onEnded("silence");
  assert.equal(s.c.snapshot().phase, "idle");
  assert.ok(s.log.some((l) => l.startsWith("info:") && l.toLowerCase().includes("silence")));
});

test("continuous: cancel clears the tail and stops streaming", async () => {
  const s = streamHarness();
  await s.c.start();
  s.h().onPartial("draft words");
  s.c.cancel();
  assert.equal(s.live(), "");
  assert.ok(s.log.includes("stream:cancel"));
  assert.equal(s.c.snapshot().phase, "idle");
});

test("continuous: page hidden stops the stream gracefully", async () => {
  const s = streamHarness();
  await s.c.start();
  s.interrupt("hidden");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(s.log.includes("stream:stop"));
  assert.equal(s.c.snapshot().phase, "idle");
});

test("stop during stream connect stops once connected", async () => {
  let release!: () => void;
  const s = streamHarness({
    startStream: (h) => new Promise((resolve) => {
      release = () => resolve({ async stop() { h.onEnded("stopped"); }, cancel() {} });
    }),
  });
  const starting = s.c.start();
  const stopping = s.c.stop();
  release();
  await starting;
  await stopping;
  assert.equal(s.c.snapshot().phase, "idle");
});

test("explicit oneshot mode overrides the continuous default (press-and-hold)", async () => {
  const s = streamHarness();
  await s.c.start("t1", "oneshot");
  assert.equal(s.c.snapshot().phase, "recording");
  assert.ok(s.log.includes("oneshot:start") && !s.log.includes("stream:start"));
});
```

- [ ] **Step 2: Run** `node --test bb/dictation.test.ts` → the new tests FAIL (phase never `streaming`; `startStream` unused), existing ones still pass.

- [ ] **Step 3: Implement** in `bb/dictation.ts`:

Types:
```ts
import type { EndReason } from "./stream-protocol.ts";

export type Mode = "continuous" | "oneshot";
export type Phase = "idle" | "recording" | "transcribing" | "streaming" | "finishing";
export interface Target {
  id: string;
  appendText(text: string): void;
  submit(): void;
  /** Replace the dimmed live tail with `text` (empty clears it). */
  setLive(text: string): void;
  /** Replace the live tail with solid `text` (empty just clears the tail). */
  commitLive(text: string): void;
}
export interface StreamHandlers {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onCommand(name: "send" | "stop"): void;
  onEnded(reason: EndReason): void;
  onError(message: string): void;
}
export interface StreamHandle { stop(): Promise<void>; cancel(): void }
```
`DictationDeps`: add `startStream?(handlers: StreamHandlers, onInterrupt: (why: Interruption) => void): Promise<StreamHandle>;` and extend `prefs()` with `mode: Mode; livePreview: boolean`.

Controller fields: `#stream: StreamHandle | null = null; #live = "";`.

`toggle`:
```ts
  async toggle(targetId?: string): Promise<void> {
    const phase = this.#state.phase;
    if (phase === "idle") return this.start(targetId);
    if (phase === "recording" || phase === "streaming") return this.stop();
  }
```
`start` becomes a dispatcher; the old body moves to `#startOneShot(target)`:
```ts
  async start(targetId?: string, mode?: Mode): Promise<void> {
    const deps = this.#deps;
    if (this.#state.phase !== "idle" || !deps) return;
    const target = this.#resolve(targetId);
    if (!target) return;
    const wanted = mode ?? deps.prefs().mode;
    if (wanted === "continuous" && deps.startStream) return this.#startStream(deps, target);
    return this.#startOneShot(deps, target);
  }

  async #startStream(deps: DictationDeps, target: Target): Promise<void> {
    this.#set({ phase: "streaming", targetId: target.id, startedAt: deps.now() });
    this.#stopRequested = false;
    this.#live = "";
    const handlers: StreamHandlers = {
      onPartial: (text) => {
        if (!deps.prefs().livePreview || this.snapshot().phase === "idle") return;
        this.#live = text;
        target.setLive(text);
      },
      onFinal: (text) => { this.#live = ""; target.commitLive(text); },
      onCommand: (name) => { if (name === "send") target.submit(); },
      onError: (message) => deps.notify("error", message),
      onEnded: (reason) => this.#streamEnded(deps, target, reason),
    };
    let handle: StreamHandle;
    try {
      handle = await deps.startStream!(handlers, (why) => {
        if (this.snapshot().phase !== "streaming") return;
        deps.notify("info", why === "hidden" ? "Dictation stopped because the page was hidden." : "Dictation reached its limit.");
        void this.stop();
      });
    } catch (e) {
      this.#set(IDLE);
      deps.notify("info", `Streaming unavailable (${e instanceof Error ? e.message : String(e)}); using one-shot.`);
      return this.#startOneShot(deps, target);
    }
    if (this.snapshot().phase !== "streaming") {
      handle.cancel(); // cancelled while connecting
      return;
    }
    this.#stream = handle;
    this.#cue("start");
    if (this.#stopRequested) await this.stop();
  }

  #streamEnded(deps: DictationDeps, target: Target, reason: EndReason): void {
    if (this.snapshot().phase === "idle") return;
    if (reason === "error") {
      if (this.#live) target.commitLive(this.#live);
      deps.notify("info", "Dictation connection lost; the last phrase may be incomplete.");
      this.#cue("error");
    } else {
      if (reason === "silence") deps.notify("info", "Dictation stopped after silence.");
      if (reason === "limit") deps.notify("info", "Dictation reached the 15-minute limit.");
      this.#cue("stop");
    }
    this.#live = "";
    this.#stream = null;
    this.#set(IDLE);
  }
```
`#startOneShot(deps, target)` = the previous `start` body from `this.#set({ phase: "recording", … })` onward (unchanged).

`stop` — add the streaming branch at the top:
```ts
  async stop(): Promise<void> {
    if (this.#state.phase === "streaming") {
      if (!this.#stream) { this.#stopRequested = true; return; }
      const stream = this.#stream;
      this.#set({ ...this.#state, phase: "finishing" });
      await stream.stop();
      return;
    }
    // …existing one-shot stop body unchanged…
  }
```
`cancel` — add before the one-shot branch:
```ts
    if (this.#state.phase === "streaming" || this.#state.phase === "finishing") {
      const target = this.#resolve(this.#state.targetId ?? undefined);
      this.#stream?.cancel();
      this.#stream = null;
      this.#live = "";
      target?.setLive("");
      this.#set(IDLE);
      this.#cue("cancel");
      return;
    }
```
`finishing` handler interplay: `#streamEnded` accepts `finishing` (it only ignores `idle`).

- [ ] **Step 4: Run** `npm test && npx tsc --noEmit` → pass (all old and new controller tests).

- [ ] **Step 5: Commit** `feat(parakeet-stt): continuous streaming mode in the dictation controller`

---

### Task 7: Page streaming, gestures, live tail, native-mic toggle, settings

**Files:**
- Create: `plugins/parakeet-stt/bb/worklet.ts`, `bb/stream-client.ts`
- Modify: `bb/app.tsx`, `bb/dictation-prefs.ts`, `bb/page/parakeet-page.tsx`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces: `startBrowserStream(url: string, h: StreamHandlers, onInterrupt: (why: Interruption) => void): Promise<StreamHandle>`; `WORKLET_SOURCE: string`; `onDictationPrefs(fn: (p: Prefs) => void): () => void`.

- [ ] **Step 1: `bb/worklet.ts`:**
```ts
// AudioWorklet processor source, loaded from a Blob URL (no separate asset needed).
export const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;
```

- [ ] **Step 2: `bb/stream-client.ts`:**
```ts
// Browser side of continuous dictation: mic → AudioWorklet → 16 kHz PCM16 frames → plugin relay socket.
import type { Interruption, StreamHandle, StreamHandlers } from "./dictation.ts";
import { Resampler16k } from "./pcm.ts";
import { parseServerEvent } from "./stream-protocol.ts";
import { WORKLET_SOURCE } from "./worklet.ts";

const READY_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 30000;

export async function startBrowserStream(url: string, h: StreamHandlers, onInterrupt: (why: Interruption) => void): Promise<StreamHandle> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") throw new Error("this browser cannot stream audio");
  const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let ctx: AudioContext;
  try { ctx = new AudioContext({ sampleRate: 16000 }); } catch { ctx = new AudioContext(); }
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    media.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => undefined);
    URL.revokeObjectURL(moduleUrl);
    document.removeEventListener("visibilitychange", onVisibility);
  };
  const onVisibility = () => { if (document.visibilityState === "hidden") onInterrupt("hidden"); };

  try {
    await ctx.audioWorklet.addModule(moduleUrl);
  } catch (e) {
    release();
    throw e;
  }
  const source = ctx.createMediaStreamSource(media);
  const tap = new AudioWorkletNode(ctx, "pcm-tap");
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(tap).connect(sink).connect(ctx.destination);
  const resampler = new Resampler16k(ctx.sampleRate);

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let ready = false;
  let ended = false;
  let onEnd: (() => void) | null = null;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); release(); reject(new Error("stream did not become ready")); }, READY_TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({ type: "start" }));
    ws.onmessage = (ev) => {
      const e = parseServerEvent(ev.data);
      if (!e) return;
      if (!ready) {
        if (e.type === "ready") { ready = true; clearTimeout(timer); resolve(); return; }
        if (e.type === "error") { clearTimeout(timer); ws.close(); release(); reject(new Error(e.message)); }
        return;
      }
      switch (e.type) {
        case "partial": h.onPartial(e.text); break;
        case "final": h.onFinal(e.text); break;
        case "command": h.onCommand(e.name); break;
        case "error": h.onError(e.message); break;
        case "ended": ended = true; release(); h.onEnded(e.reason); onEnd?.(); ws.close(); break;
      }
    };
    ws.onclose = () => {
      if (!ready) { clearTimeout(timer); release(); reject(new Error("stream connection failed")); return; }
      if (!ended) { ended = true; release(); h.onError("Dictation stream closed unexpectedly"); h.onEnded("error"); onEnd?.(); }
    };
  });

  tap.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const frame of resampler.push(ev.data)) ws.send(frame.buffer);
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    stop: () => new Promise<void>((resolve) => {
      if (ended) return resolve();
      onEnd = resolve;
      tap.port.onmessage = null;
      media.getTracks().forEach((t) => t.stop()); // stop the mic now; wait for the server's final phrase
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
      setTimeout(() => { if (!ended) { ended = true; release(); ws.close(); h.onEnded("error"); resolve(); } }, STOP_TIMEOUT_MS);
    }),
    cancel: () => { ended = true; tap.port.onmessage = null; release(); ws.close(); },
  };
}
```

- [ ] **Step 3: `bb/dictation-prefs.ts`** — add listeners:
```ts
const listeners = new Set<(p: Prefs) => void>();
export function setDictationPrefs(next: Prefs): void { current = next; for (const l of listeners) l(next); }
export function onDictationPrefs(fn: (p: Prefs) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
```
(replacing the old `setDictationPrefs`).

- [ ] **Step 4: `bb/app.tsx` changes:**

1. Imports: `useMemo`; `createPressDetector` from `./press.ts`; `liveTail, replaceTail, tailRange` from `./draft-tail.ts`; `startBrowserStream` from `./stream-client.ts`; `onDictationPrefs` from `./dictation-prefs.ts`; `PLUGIN_BASE = \`/api/v1/plugins/${PLUGIN_ID}/http\``.
2. In `useControllerDeps`, add to `deps`:
```ts
      startStream: (h, onInterrupt) => {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        return startBrowserStream(`${proto}://${location.host}${PLUGIN_BASE}/stream`, h, onInterrupt);
      },
```
and change the sound URL to use `PLUGIN_BASE`.
3. A shared target factory used by both `useComposerTarget` and the plus-menu `run`:
```ts
function makeTarget(id: string, composer: () => ReturnType<typeof useComposer>): Target {
  return {
    id,
    appendText: (text) => composer().updateText((current) => appendDictation(current, text, prefsNow().trailingSpace)),
    submit: () => { void composer().experimental_submit({ experimental_data: {} }); },
    setLive: (text) => composer().updateText((d) => { const r = replaceTail(d, liveTail.get(), text); liveTail.set(r.tail); return r.draft; }),
    commitLive: (text) => composer().updateText((d) => { const r = replaceTail(d, liveTail.get(), text); liveTail.set(""); return r.draft; }),
  };
}
```
(`useComposerTarget` registers `makeTarget(id, () => ref.current)`; the plus menu registers `makeTarget(id, () => composer)`; import `type Target` from `./dictation.ts`.)
4. `MicAction` — gestures and states:
```tsx
function MicAction() {
  useControllerDeps();
  const id = useComposerTarget();
  const s = useDictationState();
  const mine = s.targetId === id;
  const live = mine && (s.phase === "recording" || s.phase === "streaming");
  const busy = mine && (s.phase === "transcribing" || s.phase === "finishing");
  const press = useMemo(() => createPressDetector({
    holdMs: 350,
    onTap: () => void controller.toggle(id),
    onHoldStart: () => void controller.start(id, "oneshot"),
    onHoldEnd: () => void controller.stop(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  }), [id]);
  const label = live ? "Stop dictation" : busy ? "Finishing…" : "Dictate — tap, or hold to talk";
  return (
    <Button
      type="button" variant="ghost" size="icon" aria-label={label} aria-pressed={live}
      disabled={busy}
      onPointerDown={(e) => { if (e.button === 0) press.down(); }}
      onPointerUp={() => press.up()}
      onPointerCancel={() => press.cancel()}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => { if (e.detail === 0) void controller.toggle(id); }}
      className={cn("touch-none select-none", live ? "text-red-500 animate-pulse" : busy ? "opacity-60 animate-pulse" : undefined)}
    >
      <Icon name="Mic" aria-hidden />
    </Button>
  );
}
```
(`cn` from `@/lib/utils`; `onClick` with `detail === 0` handles keyboard activation only.)
5. `RecordingBanner` — show streaming/finishing:
```tsx
  if (s.targetId !== id || s.phase === "idle") return null;
  const active = s.phase === "recording" || s.phase === "streaming";
  const label = s.phase === "streaming" ? `Listening (continuous)… ${elapsed}` : s.phase === "recording" ? `Listening… ${elapsed}` : s.phase === "finishing" ? "Finishing…" : "Transcribing…";
```
render `label` and show Stop/Cancel when `active`; `useSecondTick(active)`.
6. Composer customization — add the live-tail effect:
```ts
    richText: {
      effects: [{
        id: "live-tail",
        className: "opacity-50",
        match: (text) => { const r = tailRange(text, liveTail.get()); return r ? [r] : []; },
      }],
    },
```
7. Shortcut keydown: `const p = prefsNow().phase` logic unchanged, but Esc cancels when phase is `recording` or `streaming`; hold-to-talk start uses `controller.start(undefined, "oneshot")`.
8. Content script `native-mic` and prefs bootstrap:
```ts
  app.contentScripts.register({
    id: "native-mic",
    mount({ signal }) {
      const style = document.createElement("style");
      style.textContent = 'button[aria-label$=" voice input"]{display:none !important}';
      const apply = (p = prefsNow()) => {
        if (p.hideNativeMic) { if (!style.isConnected) document.head.appendChild(style); }
        else style.remove();
      };
      apply();
      const off = onDictationPrefs(apply);
      void fetch(`${PLUGIN_BASE}/prefs`, { signal }).then((r) => (r.ok ? r.json() : null)).then((p) => { if (p) setDictationPrefs(p); }).catch(() => undefined);
      signal.addEventListener("abort", () => { off(); style.remove(); });
    },
  });
```
(`setDictationPrefs` is already imported.)

- [ ] **Step 5: Settings page** — `bb/page/parakeet-page.tsx`: add a "Streaming" section after "Dictation":
```tsx
      <Section title="Continuous dictation" description="Tap the mic for your default mode; press and hold for one-shot push-to-talk.">
        <Row label="Default mode" htmlFor="mode">
          <select id="mode" className="rounded-md border bg-transparent px-2 py-1 text-sm" value={prefs.mode}
            onChange={(e) => void patch({ mode: e.target.value as Prefs["mode"] })}>
            <option value="continuous">Continuous (commit at each pause)</option>
            <option value="oneshot">One-shot (transcribe on stop)</option>
          </select>
        </Row>
        <SwitchRow id="preview" label="Live preview" hint="Show the phrase in progress, dimmed" checked={prefs.livePreview} onChange={(v) => void patch({ livePreview: v })} />
        <SliderRow id="pause" label="Pause before commit" value={prefs.pauseMs} min={300} max={1500} step={50} format={(v) => `${v} ms`} onChange={(v) => void patch({ pauseMs: v })} />
        <SwitchRow id="silence" label="End on silence" checked={prefs.endOnSilence} onChange={(v) => void patch({ endOnSilence: v })} />
        {prefs.endOnSilence && (
          <SliderRow id="silence-s" label="Silence timeout" value={prefs.silenceTimeoutS} min={3} max={60} step={1} format={(v) => `${v} s`} onChange={(v) => void patch({ silenceTimeoutS: v })} />
        )}
        <SwitchRow id="commands" label="Voice commands" hint="Say the phrase at the end of a sentence" checked={prefs.voiceCommands} onChange={(v) => void patch({ voiceCommands: v })} />
        {prefs.voiceCommands && (
          <>
            <Row label="Send phrase" htmlFor="send-phrase"><Input id="send-phrase" defaultValue={prefs.sendPhrase} onBlur={(e) => void patch({ sendPhrase: e.target.value })} /></Row>
            <Row label="Stop phrase" htmlFor="stop-phrase"><Input id="stop-phrase" defaultValue={prefs.stopPhrase} onBlur={(e) => void patch({ stopPhrase: e.target.value })} /></Row>
          </>
        )}
        <SwitchRow id="native" label="Hide bb's voice button" hint="Keep one mic in the composer" checked={prefs.hideNativeMic} onChange={(v) => void patch({ hideNativeMic: v })} />
      </Section>
```
and change the Auto-submit hint to "Send the message after a one-shot dictation".

- [ ] **Step 6: Build and verify** — `npx tsc --noEmit && npm test && bb plugin build . && bb plugin reload parakeet-stt`. In a headless browser on the bb page: bb's "Start voice input" button is not visible (computed `display: none`), our mic's aria-label is "Dictate — tap, or hold to talk", the settings page shows the Continuous dictation section.

- [ ] **Step 7: Commit** `feat(parakeet-stt): continuous streaming in the composer, hold-to-talk, one-mic toggle`

---

### Task 8: Deploy, end-to-end verification, docs

- [ ] **Step 1: Deploy the server** per the private runbook's redeploy step (sync `server/`, `uv sync --frozen`, restart), then `curl https://<stt>/health` → ready.
- [ ] **Step 2: Relay end-to-end** — a Node script (throwaway, in thread storage) that decodes `tests/fixtures/speech.webm` to PCM16 16 kHz with ffmpeg, connects to `ws://127.0.0.1:38886/api/v1/plugins/parakeet-stt/http/stream`, sends `{"type":"start"}`, streams 20 ms frames in real time followed by 1 s of silence, sends `stop`, and prints events. Expected: `ready`, ≥ 1 `partial`, a `final` containing "tmux session … before lunch", `ended` (`stopped`).
- [ ] **Step 3: Docs** — plugin `README.md`: add `/v1/stream` to the API section (protocol summary), the continuous-dictation settings, and the hold gesture; `PLUGIN_OVERVIEW.md`: continuous mode, live preview, voice commands, hold-to-talk, one mic. Private runbook: note the websocket passes through the existing reverse proxy unchanged.
- [ ] **Step 4:** Manual phone checks with the user: continuous dictation with live preview, lock mid-session, silence timeout, voice commands, press-and-hold one-shot, bb's mic hidden.
- [ ] **Step 5: Commit** `docs(parakeet-stt): streaming protocol and continuous dictation`
