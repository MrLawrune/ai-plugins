#!/usr/bin/env python3
"""Persistent Kokoro TTS HTTP server.

Keeps the ONNX model resident in memory and serves TTS requests via HTTP.
Supports per-session playback tracking with interrupt capability.

Uses a threading.Event for safe cross-thread cancellation and a single-thread
executor for all sounddevice calls, avoiding portaudio corruption.
"""

import asyncio
import json
from pathlib import Path
import html
from collections import deque
import queue
from statistics import median
import logging
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.parse
import wave

import numpy as np
from aiohttp import web

HEADLESS = os.environ.get("KOKORO_HEADLESS", "") not in ("", "0", "false")
if not HEADLESS:
    import sounddevice as sd
else:  # synthesis-only node (no audio hardware)
    sd = None  # type: ignore[assignment]

import mistune

from kokoro_config import (
    DEFAULTS,
    ConfigError,
    ConfigStore,
    blend_voice,
    voice_metadata,
)
from kokoro_engine import SAMPLE_RATE, EngineError, LocalEngine, RemoteEngine, available_providers
from kokoro_turn import route_cue, route_turn

SERVER_VERSION = "0.1.1"
PREVIEW_TEXT = "This is how I will sound when reading your updates."
from mistune.plugins.formatting import strikethrough as strikethrough_plugin

log = logging.getLogger("kokoro-server")


# --- Markdown stripping ---

class PlainTextRenderer(mistune.HTMLRenderer):
    def text(self, text):
        return text

    def emphasis(self, text):
        return text

    def strong(self, text):
        return text

    def codespan(self, text):
        return ""

    def block_code(self, code, info=None):
        return ""

    def link(self, text, url, title=None):
        return text or ""

    def image(self, alt, url, title=None):
        return alt or ""

    def heading(self, text, level, **attrs):
        return text + ". "

    def paragraph(self, text):
        return text + " "

    def list(self, text, ordered, **attrs):
        return text

    def list_item(self, text, **attrs):
        return text.strip() + ". "

    def thematic_break(self):
        return ""

    def block_quote(self, text):
        return text

    def linebreak(self):
        return " "

    def softbreak(self):
        return " "

    def block_html(self, html_text):
        return ""

    def inline_html(self, html_text):
        return ""

    def strikethrough(self, text):
        return text


_md_renderer = PlainTextRenderer()
_md_parser = mistune.create_markdown(renderer=_md_renderer, plugins=[strikethrough_plugin])


def strip_markdown(text: str) -> str:
    text = re.sub(r"https?://[^\s\)]+", "", text)
    text = re.sub(r"`[~/][^`]+`", "", text)
    text = re.sub(r"(?:^|\s)~/[a-zA-Z0-9_./-]+", " ", text)
    text = re.sub(r"(?:^|\s)/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_./-]*", " ", text)
    text = re.sub(r"^\|.*\|$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\|[-:\s|]+\|\s*$", "", text, flags=re.MULTILINE)

    result = _md_parser(text)

    result = re.sub(r"`", "", result)
    result = re.sub(r"\[\]|\(\)", "", result)
    result = re.sub(r"\s+", " ", result)
    result = "".join(
        c for c in result
        if unicodedata.category(c) != "So" and not (0xFE00 <= ord(c) <= 0xFE0F)
    )
    result = html.unescape(result)
    result = re.sub(r"\s+", " ", result)
    return result.strip()


def validate_overrides(overrides: dict, voices: list[str]) -> dict:
    """Per-request overrides share the config validator; speed may arrive as a string."""
    if "speed" in overrides and isinstance(overrides["speed"], str):
        try:
            overrides["speed"] = float(overrides["speed"])
        except ValueError:
            pass
    from kokoro_config import validate_patch
    return validate_patch(overrides, voices)


def sentence_chunks(text: str, max_chars: int = 220) -> list[str]:
    """Split text at sentence boundaries into groups of at most max_chars.

    Synthesis time scales with input length, so speaking sentence groups as
    they finish cuts time-to-first-audio without adding gaps: synthesis is
    faster than realtime on every supported provider.
    """
    parts = [p.strip() for p in re.split(r"(?<=[.!?;:])\s+", text.strip()) if p.strip()]
    out: list[str] = []
    cur = ""
    for part in parts:
        if cur and len(cur) + 1 + len(part) > max_chars:
            out.append(cur)
            cur = part
        else:
            cur = f"{cur} {part}".strip()
    if cur:
        out.append(cur)
    return out or ([text.strip()] if text.strip() else [])


# --- Thread-safe audio playback ---

def play_samples_interruptible(samples: np.ndarray, sr: int, cancel: threading.Event):
    """Play audio samples, checking cancel event. All sd calls on same thread."""
    if cancel.is_set():
        return
    sd.play(samples, samplerate=sr)
    while sd.get_stream().active:
        if cancel.is_set():
            sd.stop()
            return
        cancel.wait(timeout=0.05)


def play_queue_interruptible(q: "queue.Queue[np.ndarray | None]", sr: int, cancel: threading.Event):
    """Play frames from q on ONE output stream until a None sentinel; stop on cancel.

    A single stream per utterance avoids the start/stop click and the gap that
    per-chunk sd.play() calls introduce, and keeps Bluetooth sinks awake between
    sentence groups. While the queue is empty the stream is fed silence, so a
    stream opened before synthesis finishes wakes a suspended sink during the
    synthesis wait instead of clipping the first word.
    """
    if cancel.is_set():
        return
    idle_block = np.zeros((1024, 1), dtype=np.float32)  # ~43 ms at 24 kHz
    with sd.OutputStream(samplerate=sr, channels=1, dtype="float32", blocksize=2048) as stream:
        while not cancel.is_set():
            try:
                frame = q.get_nowait()
            except queue.Empty:
                stream.write(idle_block)
                continue
            if frame is None:
                break
            # write in slices so cancel is honored within long frames
            for i in range(0, len(frame), 4800):
                if cancel.is_set():
                    return
                stream.write(np.ascontiguousarray(frame[i:i + 4800], dtype=np.float32).reshape(-1, 1))


# --- Speech log ---

STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state"))) / "kokoro-tts"


def _norm_text(text: str) -> str:
    return " ".join(text.split())


class SpeechLog:
    """Bounded history of /speak requests and what became of them.

    Status lifecycle: queued -> playing -> done | interrupted | error,
    or straight to muted | empty. Persisted as JSONL (one line per status
    change; the last line for an id wins on reload) so chat clients can
    show whether a block was actually spoken, across server restarts.
    """

    def __init__(self, path: Path, maxlen: int = 300):
        self.path = path
        self.entries: deque[dict] = deque(maxlen=maxlen)
        self._next_id = 1
        self._load()

    def _load(self):
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            return
        by_id: dict[int, dict] = {}
        for line in lines[-3000:]:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if isinstance(e, dict) and isinstance(e.get("id"), int):
                if e.get("status") in ("queued", "playing"):
                    e["status"] = "interrupted"  # server died mid-speech
                by_id[e["id"]] = e
        for e in sorted(by_id.values(), key=lambda x: x["id"]):
            self.entries.append(e)
        if by_id:
            self._next_id = max(by_id) + 1

    def _append(self, entry: dict):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            if self.path.stat().st_size > 2_000_000:
                self._compact()
        except OSError as e:
            log.warning("speech log write failed: %s", e)

    def _compact(self):
        tmp = self.path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            for e in self.entries:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
        os.replace(tmp, self.path)

    def add(self, text: str, session_id: str) -> dict:
        entry = {
            "id": self._next_id,
            "ts": time.time(),
            "session_id": session_id,
            "text": _norm_text(text)[:2000],
            "status": "queued",
        }
        self._next_id += 1
        self.entries.append(entry)
        self._append(entry)
        return entry

    def update(self, entry: dict, status: str, **extra):
        entry["status"] = status
        entry.update(extra)
        self._append(entry)

    def recent(self, limit: int) -> list[dict]:
        items = list(self.entries)[-limit:]
        return items

    def get(self, entry_id: int) -> dict | None:
        for e in reversed(self.entries):
            if e["id"] == entry_id:
                return e
        return None


# --- Server ---

class KokoroServer:
    def __init__(self, model_path: str, voices_path: str, config_path: str, port: int):
        self.model_path = model_path
        self.voices_path = voices_path
        self.port = port
        self.started_at = time.time()
        probe = LocalEngine(model_path, voices_path, "cpu")
        self.config = ConfigStore(config_path, probe.voices())
        self.muted = False
        self.last_first_audio_ms: float | None = None
        self.latency_samples: deque[float] = deque(maxlen=20)
        self.spoken_count = 0
        self.speech_log = SpeechLog(STATE_DIR / "speech-log.jsonl")
        self.active_playbacks: dict[str, asyncio.Task] = {}
        self.cancel_events: dict[str, threading.Event] = {}
        self.bb_plugin_seen = 0.0
        self._audio_executor = None
        self.engine: LocalEngine | RemoteEngine = self._make_engine(self.config.get())
        try:
            self._local_engine().ensure_loaded()
        except EngineError as e:
            log.error("Configured provider failed (%s); falling back to cpu", e)
            self.config.patch({"provider": "cpu"})
            self.engine = self._make_engine(self.config.get())
            self._local_engine().ensure_loaded()
        if not HEADLESS:
            self._apply_output_device(self.config.get()["output_device"])

    # --- engine management ---

    def _make_engine(self, cfg: dict) -> LocalEngine | RemoteEngine:
        local_kw = dict(
            intra_op_threads=cfg["intra_op_threads"],
            gpu_mem_limit_mb=cfg["gpu_mem_limit_mb"],
            idle_unload_minutes=cfg["idle_unload_minutes"],
        )
        if cfg["provider"] == "remote":
            if not cfg["remote_url"]:
                raise EngineError("provider 'remote' needs remote_url")
            fallback = LocalEngine(self.model_path, self.voices_path, "cpu", **local_kw) if cfg["fallback_to_cpu"] else None
            return RemoteEngine(cfg["remote_url"], fallback)
        return LocalEngine(self.model_path, self.voices_path, cfg["provider"], **local_kw)

    def _local_engine(self) -> LocalEngine:
        """The engine that holds voices and can synthesize without the network."""
        if isinstance(self.engine, LocalEngine):
            return self.engine
        if self.engine.fallback is not None:
            return self.engine.fallback
        return LocalEngine(self.model_path, self.voices_path, "cpu")

    async def _swap_engine(self, cfg: dict) -> None:
        """Build the engine for cfg; raise EngineError (leaving the old engine) on failure."""
        new = self._make_engine(cfg)
        if isinstance(new, LocalEngine):
            await asyncio.get_running_loop().run_in_executor(None, new.ensure_loaded)
        else:
            if await new.health() is None and new.fallback is None:
                raise EngineError(f"remote {new.url} unreachable: {new.last_error}")
        old = self.engine
        self.engine = new
        if isinstance(old, RemoteEngine):
            await old.close()
        elif isinstance(old, LocalEngine):
            old.unload()

    async def idle_unload_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            try:
                for eng in (self.engine, getattr(self.engine, "fallback", None)):
                    if isinstance(eng, LocalEngine) and eng.maybe_idle_unload():
                        log.info("Idle unload: %s", eng.provider)
            except Exception:
                log.exception("idle unload check failed")

    async def engine_status(self) -> dict:
        info = self.engine.info()
        if isinstance(self.engine, RemoteEngine):
            info["remote_health"] = await self.engine.health()
        return info

    # --- config helpers ---

    def _apply_output_device(self, device):
        try:
            sd.default.device = (None, device)
            log.info("Output device set to %s", "system default" if device is None else device)
        except Exception:
            log.exception("Failed to set output device %s", device)

    def _resolve_voice(self, voice):
        return blend_voice(voice, self._local_engine().get_voice_style)

    async def _synth_stream(self, text: str, voice, speed: float, lang: str, trim: bool):
        """Yield (samples, sr) per sentence group from whichever engine is active."""
        for chunk in sentence_chunks(text):
            if isinstance(self.engine, RemoteEngine):
                async for samples, sr in self.engine.stream(chunk, voice, speed, lang, trim):
                    yield samples, sr
            else:
                style = self._resolve_voice(voice)
                async for samples, sr in self.engine.stream(chunk, style, speed, lang, trim):
                    yield samples, sr

    def _restart_block(self) -> dict:
        return {
            "model_path": self.model_path,
            "voices_path": self.voices_path,
            "port": self.port,
            "config_path": str(self.config.path),
            "headless": HEADLESS,
        }

    def _config_response(self) -> dict:
        return {
            "config": self.config.get(),
            "defaults": DEFAULTS,
            "muted": self.muted,
            "providers_available": available_providers(),
            "restart_required": self._restart_block(),
            "restart_command": (
                "When bb manages the server, turn Manage server off and on again on the Server card "
                "(or reload the Kokoro TTS plugin). Otherwise, restart it the way you started it."
            ),
        }

    def _get_audio_executor(self):
        if self._audio_executor is None:
            from concurrent.futures import ThreadPoolExecutor
            self._audio_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="audio")
        return self._audio_executor

    async def _play_stream(self, text: str, voice, speed: float, lang: str,
                           trim: bool, gain: float, session_id: str, entry: dict | None = None):
        cancel = self.cancel_events.get(session_id)
        if not cancel:
            if entry:
                self.speech_log.update(entry, "interrupted")
            return
        cfg = self.config.get()
        q: "queue.Queue[np.ndarray | None]" = queue.Queue()
        loop = asyncio.get_running_loop()
        executor = self._get_audio_executor()
        player = None
        try:
            t0 = time.perf_counter()
            first = True
            # Open the output stream now, before synthesis returns anything: the
            # player emits silence until audio arrives, so a suspended
            # (Bluetooth) sink wakes during the synthesis wait.
            stream_sr = SAMPLE_RATE
            player = loop.run_in_executor(executor, play_queue_interruptible, q, stream_sr, cancel)
            async for samples, sr in self._synth_stream(text, voice, speed, lang, trim):
                if cancel.is_set():
                    break
                if gain != 1.0:
                    samples = np.clip(samples * gain, -1.0, 1.0)
                if first:
                    self.last_first_audio_ms = (time.perf_counter() - t0) * 1000
                    self.latency_samples.append(self.last_first_audio_ms)
                    self.spoken_count += 1
                    log.info("First audio after %.0fms (%d chars, provider=%s)", self.last_first_audio_ms, len(text), cfg["provider"])
                    if entry:
                        self.speech_log.update(entry, "playing", first_audio_ms=round(self.last_first_audio_ms))
                    if sr != stream_sr:
                        # Rare: engine produced a different rate. Restart the player at that rate.
                        log.warning("Engine sample rate %d != %d; reopening stream", sr, stream_sr)
                        q.put(None)
                        await player
                        q = queue.Queue()
                        stream_sr = sr
                        player = loop.run_in_executor(executor, play_queue_interruptible, q, stream_sr, cancel)
                    # Extra lead-in silence on top of the pre-opened stream.
                    if cfg["lead_in_ms"] > 0:
                        q.put(np.zeros(int(sr * cfg["lead_in_ms"] / 1000), dtype=np.float32))
                    first = False
                else:
                    if cfg["gap_ms"] > 0:
                        q.put(np.zeros(int(sr * cfg["gap_ms"] / 1000), dtype=np.float32))
                q.put(np.asarray(samples, dtype=np.float32))
            q.put(None)
            if player is not None:
                await player
            if entry:
                self.speech_log.update(entry, "interrupted" if cancel.is_set() else "done")
        except asyncio.CancelledError:
            log.info("Playback cancelled for session %s", session_id)
            cancel.set()
            if entry:
                self.speech_log.update(entry, "interrupted")
        except Exception as e:
            log.exception("Playback error for session %s", session_id)
            cancel.set()
            if entry:
                self.speech_log.update(entry, "error", error=str(e)[:200])
        finally:
            q.put(None)
            self.active_playbacks.pop(session_id, None)
            self.cancel_events.pop(session_id, None)

    def _cancel_session(self, session_id: str):
        cancel = self.cancel_events.get(session_id)
        if cancel:
            cancel.set()
        existing = self.active_playbacks.get(session_id)
        if existing and not existing.done():
            existing.cancel()

    async def handle_speak(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)

        text = data.get("text", "").strip()
        if not text:
            return web.json_response({"error": "empty text"}, status=400)

        session_id = data.get("session_id", "default")
        return await self._speak(text, data, session_id)

    async def _speak(self, text: str, data: dict, session_id: str) -> web.Response:
        body, status = await self._start_speech(text, data, session_id)
        return web.json_response(body, status=status)

    async def _start_speech(self, text: str, data: dict, session_id: str) -> tuple[dict, int]:
        if HEADLESS:
            return {"error": "headless node: use /synthesize"}, 501
        entry = self.speech_log.add(text, session_id) if session_id != "preview" else None
        if self.muted:
            if entry:
                self.speech_log.update(entry, "muted")
            return {"status": "muted", "session_id": session_id}, 200

        cfg = self.config.get()
        overrides = {k: data[k] for k in ("voice", "speed", "lang", "trim", "speech_gain", "strip_markdown") if k in data}
        try:
            overrides = validate_overrides(overrides, self.config.voices)
        except ConfigError as e:
            if entry:
                self.speech_log.update(entry, "error", error="invalid parameters")
            return {"error": "invalid parameters", "fields": e.errors}, 400
        cfg.update(overrides)

        if cfg["strip_markdown"]:
            text = strip_markdown(text)
            if not text:
                if entry:
                    self.speech_log.update(entry, "empty")
                return {"status": "empty_after_strip"}, 200

        was_active = session_id in self.active_playbacks and not self.active_playbacks[session_id].done()
        self._cancel_session(session_id)
        if was_active:
            await asyncio.sleep(0.1)

        cancel = threading.Event()
        self.cancel_events[session_id] = cancel
        task = asyncio.create_task(self._play_stream(
            text, cfg["voice"], cfg["speed"], cfg["lang"], cfg["trim"], cfg["speech_gain"], session_id, entry,
        ))
        self.active_playbacks[session_id] = task

        return {"status": "playing", "session_id": session_id}, 200

    async def handle_speech_log(self, request: web.Request) -> web.Response:
        try:
            limit = max(1, min(int(request.query.get("limit", "100")), 500))
        except ValueError:
            limit = 100
        return web.json_response({"entries": self.speech_log.recent(limit)})

    async def handle_preview(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            data = {}
        text = (data.get("text") or PREVIEW_TEXT).strip()
        was_muted = self.muted
        self.muted = False  # preview must be audible
        try:
            return await self._speak(text, data, "preview")
        finally:
            self.muted = was_muted

    # --- config endpoints ---

    async def handle_get_config(self, request: web.Request) -> web.Response:
        return web.json_response(self._config_response())

    async def handle_patch_config(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        if not isinstance(data, dict):
            return web.json_response({"error": "body must be an object"}, status=400)
        before = self.config.get()
        try:
            after = self.config.patch(data)
        except ConfigError as e:
            return web.json_response({"error": "invalid config", "fields": e.errors}, status=400)
        engine_keys = ("provider", "remote_url", "fallback_to_cpu", "idle_unload_minutes", "intra_op_threads", "gpu_mem_limit_mb")
        if any(after[k] != before[k] for k in engine_keys):
            try:
                await self._swap_engine(after)
            except (EngineError, Exception) as e:
                log.warning("Engine change rejected: %s", e)
                self.config.patch({k: before[k] for k in engine_keys})
                return web.json_response({"error": "engine change failed", "fields": {"provider": str(e)}}, status=400)
        if not HEADLESS and after["output_device"] != before["output_device"]:
            self._apply_output_device(after["output_device"])
        log.info("Config updated: %s", sorted(data))
        return web.json_response(self._config_response())

    async def handle_synthesize(self, request: web.Request) -> web.StreamResponse:
        """Stream float32 PCM frames (4-byte LE length prefix each) for remote playback nodes."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        text = (data.get("text") or "").strip()
        if not text:
            return web.json_response({"error": "empty text"}, status=400)
        cfg = self.config.get()
        overrides = {k: data[k] for k in ("voice", "speed", "lang", "trim") if k in data}
        try:
            overrides = validate_overrides(overrides, self.config.voices)
        except ConfigError as e:
            return web.json_response({"error": "invalid parameters", "fields": e.errors}, status=400)
        cfg.update(overrides)
        if isinstance(self.engine, RemoteEngine) and request.headers.get("X-Kokoro-Hop"):
            return web.json_response({"error": "remote-backed node reached via another node"}, status=409)
        resp = web.StreamResponse(headers={"Content-Type": "application/octet-stream", "X-Sample-Rate": "24000"})
        await resp.prepare(request)
        t0 = time.perf_counter()
        n = 0
        try:
            async for samples, sr in self._synth_stream(text, cfg["voice"], cfg["speed"], cfg["lang"], cfg["trim"]):
                frame = np.ascontiguousarray(samples, dtype=np.float32).tobytes()
                await resp.write(len(frame).to_bytes(4, "little") + frame)
                n += 1
        except Exception as e:
            log.exception("synthesize failed")
            if n == 0:
                # nothing sent yet: the client will see an empty body; log is the record
                pass
        await resp.write_eof()
        log.info("/synthesize %d chars -> %d frames in %.0fms", len(text), n, (time.perf_counter() - t0) * 1000)
        return resp

    async def handle_engine(self, request: web.Request) -> web.Response:
        return web.json_response(await self.engine_status())

    async def handle_voices(self, request: web.Request) -> web.Response:
        return web.json_response({"voices": voice_metadata(self.config.voices)})

    async def handle_devices(self, request: web.Request) -> web.Response:
        if HEADLESS:
            return web.json_response({"devices": [], "selected": None})
        try:
            default_out = sd.default.device[1]
            if default_out is None or default_out < 0:
                default_out = sd.query_hostapis(sd.default.hostapi)["default_output_device"]
            devices = [
                {"index": i, "name": d["name"], "default": i == default_out,
                 "channels": d["max_output_channels"]}
                for i, d in enumerate(sd.query_devices())
                if d["max_output_channels"] > 0
            ]
        except Exception as e:
            return web.json_response({"error": f"device query failed: {e}"}, status=500)
        return web.json_response({"devices": devices, "selected": self.config.get()["output_device"]})

    async def handle_mute(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        muted = data.get("muted")
        if muted is None:
            muted = not self.muted
        if not isinstance(muted, bool):
            return web.json_response({"error": "muted must be boolean"}, status=400)
        self.muted = muted
        if muted:
            for sid in list(self.active_playbacks):
                self._cancel_session(sid)
        return web.json_response({"status": "ok", "muted": self.muted})

    async def handle_interrupt(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)

        session_id = data.get("session_id", "default")
        existing = self.active_playbacks.get(session_id)
        if existing and not existing.done():
            self._cancel_session(session_id)
            return web.json_response({"status": "interrupted", "session_id": session_id})
        return web.json_response({"status": "nothing_playing", "session_id": session_id})

    async def handle_cleanup(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)

        session_id = data.get("session_id", "default")
        self._cancel_session(session_id)
        self.active_playbacks.pop(session_id, None)
        self.cancel_events.pop(session_id, None)
        return web.json_response({"status": "cleaned", "session_id": session_id})

    async def handle_interrupt_all(self, request: web.Request) -> web.Response:
        sessions = [
            sid for sid, task in self.active_playbacks.items()
            if not task.done()
        ]
        for sid in sessions:
            self._cancel_session(sid)
        return web.json_response({
            "status": "interrupted",
            "sessions_cancelled": len(sessions),
        })

    async def handle_play_sound(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)

        if HEADLESS:
            return web.json_response({"error": "headless node"}, status=501)
        sound = data.get("sound", "").strip()
        valid_sounds = {"working", "done", "attention", "error"}
        if sound not in valid_sounds:
            return web.json_response(
                {"error": f"invalid sound, must be one of: {', '.join(sorted(valid_sounds))}"},
                status=400,
            )

        body, status = await self._start_sound(
            sound, data.get("session_id", "default"),
            float(data["volume"]) if "volume" in data else None,
        )
        return web.json_response(body, status=status)

    async def _start_sound(self, sound: str, session_id: str, volume: float | None = None) -> tuple[dict, int]:
        if HEADLESS:
            return {"error": "headless node"}, 501
        if self.muted:
            return {"status": "muted", "sound": sound, "session_id": session_id}, 200
        if volume is None:
            volume = self.config.get()["sound_volume"]

        assets_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
        wav_path = os.path.join(assets_dir, f"{sound}.wav")

        if not os.path.isfile(wav_path):
            return {"error": f"asset not found: {sound}.wav"}, 404

        with wave.open(wav_path, "rb") as wf:
            frames = wf.readframes(wf.getnframes())
            samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
            sr = wf.getframerate()

        if volume != 1.0:
            samples = np.clip(samples * volume, -1.0, 1.0)
        lead = self.config.get()["lead_in_ms"]
        if lead > 0:
            samples = np.concatenate([np.zeros(int(sr * lead / 1000), dtype=np.float32), samples])

        self._cancel_session(session_id)
        cancel = threading.Event()
        self.cancel_events[session_id] = cancel
        executor = self._get_audio_executor()
        loop = asyncio.get_running_loop()

        async def _play():
            try:
                await loop.run_in_executor(executor, play_samples_interruptible, samples, sr, cancel)
            finally:
                self.active_playbacks.pop(session_id, None)
                self.cancel_events.pop(session_id, None)

        task = asyncio.create_task(_play())
        self.active_playbacks[session_id] = task

        return {"status": "playing", "sound": sound, "session_id": session_id}, 200

    async def handle_turn(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        if not isinstance(data, dict):
            return web.json_response({"error": "body must be an object"}, status=400)
        text = data.get("text")
        final_text = data.get("final_text")
        # Malformed turns are never an error for the caller (a hook or bb):
        # they just stay silent.
        if not isinstance(text, str) or not (final_text is None or isinstance(final_text, str)):
            return web.json_response({"action": "silent"})
        text = text.strip()
        if not text:
            return web.json_response({"action": "silent"})
        if self.muted:
            return web.json_response({"action": "silent", "muted": True})
        session_id = str(data.get("session_id") or "default")
        playback = "client" if data.get("playback") == "client" else "server"
        cfg = self.config.get()
        mode = data.get("mode")
        if not isinstance(mode, str) or not mode:
            mode = cfg["mode"]
        result = route_turn(text, mode, final_text)

        if playback == "server":
            if result["action"] == "speech":
                overrides = {k: data[k] for k in ("voice", "speed", "lang") if k in data}
                body, status = await self._start_speech(result["text"], overrides, session_id)
                if body.get("status") == "empty_after_strip":
                    await self._start_sound("done", session_id)
                    result = {"action": "sound", "sound": "done"}
                elif status != 200:
                    return web.json_response(body, status=status)
            elif result["action"] == "sound":
                await self._start_sound(result["sound"], session_id)
            return web.json_response(result)

        if result["action"] == "speech":
            spoken = strip_markdown(result["text"]) if cfg["strip_markdown"] else result["text"]
            if not spoken:
                result = {"action": "sound", "sound": "done"}
            else:
                entry = self.speech_log.add(spoken, session_id)
                result = {"action": "speech", "text": spoken, "entry_id": entry["id"],
                          "speech_gain": cfg["speech_gain"]}
        if result["action"] == "sound":
            result["sound_volume"] = cfg["sound_volume"]
        return web.json_response(result)

    async def handle_cue(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        if not isinstance(data, dict):
            return web.json_response({"error": "body must be an object"}, status=400)
        if self.muted:
            return web.json_response({"action": "silent", "muted": True})
        cfg = self.config.get()
        result = route_cue(str(data.get("sound", "")), data.get("mode") or cfg["mode"], cfg)
        if result["action"] == "sound":
            if data.get("playback") == "client":
                result["sound_volume"] = cfg["sound_volume"]
            else:
                await self._start_sound(result["sound"], str(data.get("session_id") or "default"))
        return web.json_response(result)

    async def handle_speech_log_status(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        if not isinstance(data, dict):
            return web.json_response({"error": "body must be an object"}, status=400)
        status = data.get("status")
        if status not in ("playing", "done", "interrupted", "error") or not isinstance(data.get("id"), int):
            return web.json_response({"error": "invalid status update"}, status=400)
        entry = self.speech_log.get(data["id"])
        if entry is None:
            return web.json_response({"error": "unknown entry"}, status=404)
        extra = {}
        if isinstance(data.get("first_audio_ms"), (int, float)):
            extra["first_audio_ms"] = round(data["first_audio_ms"])
            self.latency_samples.append(float(data["first_audio_ms"]))
            self.last_first_audio_ms = float(data["first_audio_ms"])
        if isinstance(data.get("error"), str):
            extra["error"] = data["error"][:200]
        if status == "done":
            self.spoken_count += 1
        self.speech_log.update(entry, status, **extra)
        return web.json_response({"status": "ok"})

    async def handle_runtime(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        if not isinstance(data, dict):
            return web.json_response({"error": "body must be an object"}, status=400)
        self.bb_plugin_seen = time.time() if data.get("bb_plugin") is True else 0.0
        return web.json_response({"status": "ok"})

    def _output_device_ok(self) -> bool:
        if HEADLESS:
            return False
        try:
            sd.query_devices(kind="output")
            return True
        except Exception:
            return False

    async def handle_health(self, request: web.Request) -> web.Response:
        active = {k: not v.done() for k, v in self.active_playbacks.items()}
        cfg = self.config.get()
        eng = self.engine.info()
        return web.json_response({
            "status": "ok",
            "version": SERVER_VERSION,
            "model": os.path.basename(self.model_path),
            "voices": self.config.voices,
            "active_sessions": sum(1 for v in active.values() if v),
            "provider": cfg["provider"],
            "engine": eng,
            "headless": HEADLESS,
            "output_device": cfg["output_device"],
            "muted": self.muted,
            "last_first_audio_ms": self.last_first_audio_ms,
            "latency": {
                "last_ms": self.last_first_audio_ms,
                "median_ms": median(self.latency_samples) if self.latency_samples else None,
                "samples": len(self.latency_samples),
                "spoken": self.spoken_count,
            },
            "uptime_s": int(time.time() - self.started_at),
            "bb_plugin_active": time.time() - self.bb_plugin_seen < 60,
            "output_device_ok": self._output_device_ok(),
        })


_LOOPBACK_NAMES = frozenset({"127.0.0.1", "localhost", "::1"})


def _host_name(host_header: str) -> str | None:
    """Hostname part of a Host header ("[::1]:6789" -> "::1"); None if malformed."""
    try:
        return urllib.parse.urlsplit("//" + host_header).hostname
    except ValueError:
        return None


def local_request_guard(bind_host: str):
    """Middleware against cross-origin and DNS-rebinding requests.

    Every legitimate client (the Claude Code hooks via curl, the bb plugin
    backend via Node fetch) is a non-browser client that sends no Origin
    header, so any request carrying one came from a web page and is refused.
    When the server is bound to loopback, a Host header naming anything other
    than a loopback name means a rebound DNS name pointed a page at us.
    """
    loopback_only = bind_host in _LOOPBACK_NAMES

    @web.middleware
    async def guard(request: web.Request, handler):
        if "Origin" in request.headers:
            return web.json_response({"error": "cross-origin requests are not allowed"}, status=403)
        if loopback_only:
            raw = request.headers.get("Host")
            if raw is not None and _host_name(raw) not in _LOOPBACK_NAMES:
                return web.json_response({"error": "unexpected Host header"}, status=403)
        return await handler(request)

    return guard


def build_app(server: "KokoroServer", host: str | None = None) -> web.Application:
    bind_host = host if host is not None else os.environ.get("KOKORO_HOST", "127.0.0.1")
    app = web.Application(middlewares=[local_request_guard(bind_host)])
    app.router.add_post("/speak", server.handle_speak)
    app.router.add_post("/interrupt", server.handle_interrupt)
    app.router.add_post("/interrupt-all", server.handle_interrupt_all)
    app.router.add_post("/cleanup", server.handle_cleanup)
    app.router.add_get("/health", server.handle_health)
    app.router.add_post("/play-sound", server.handle_play_sound)
    app.router.add_post("/preview", server.handle_preview)
    app.router.add_get("/config", server.handle_get_config)
    app.router.add_patch("/config", server.handle_patch_config)
    app.router.add_get("/voices", server.handle_voices)
    app.router.add_get("/devices", server.handle_devices)
    app.router.add_post("/mute", server.handle_mute)
    app.router.add_post("/synthesize", server.handle_synthesize)
    app.router.add_get("/engine", server.handle_engine)
    app.router.add_get("/speech-log", server.handle_speech_log)
    app.router.add_post("/turn", server.handle_turn)
    app.router.add_post("/cue", server.handle_cue)
    app.router.add_post("/speech-log/status", server.handle_speech_log_status)
    app.router.add_post("/runtime", server.handle_runtime)
    return app


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    model_path = os.environ.get(
        "KOKORO_MODEL",
        os.path.expanduser("~/.local/share/kokoro-tts/kokoro-v1.0.onnx"),
    )
    voices_path = os.environ.get(
        "KOKORO_VOICES",
        os.path.expanduser("~/.local/share/kokoro-tts/voices-v1.0.bin"),
    )
    port = int(os.environ.get("KOKORO_PORT", "6789"))
    config_path = os.environ.get(
        "KOKORO_CONFIG",
        os.path.join(
            os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")),
            "kokoro-tts", "config.json",
        ),
    )

    host = os.environ.get("KOKORO_HOST", "127.0.0.1")
    server = KokoroServer(model_path, voices_path, config_path, port)
    app = build_app(server, host)

    async def _start_bg(app):
        app["idle_task"] = asyncio.create_task(server.idle_unload_loop())

    async def _stop_bg(app):
        app["idle_task"].cancel()
        if isinstance(server.engine, RemoteEngine):
            await server.engine.close()

    app.on_startup.append(_start_bg)
    app.on_cleanup.append(_stop_bg)

    log.info("Starting Kokoro TTS server on %s:%d (headless=%s)", host, port, HEADLESS)
    web.run_app(app, host=host, port=port, print=None)


if __name__ == "__main__":
    main()
