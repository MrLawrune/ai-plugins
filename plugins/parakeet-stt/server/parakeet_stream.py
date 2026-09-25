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
from parakeet_commands import COMMAND_NAMES, parse, strip_command
from parakeet_endpoint import FRAME, Endpointer
from parakeet_text import postprocess

__all__ = ["StreamOptions", "StreamSession", "strip_command"]

FRAME_S = FRAME / SAMPLE_RATE
MAX_START_PHRASES = 10


@dataclass(frozen=True)
class StreamOptions:
    pause_ms: int = 600
    silence_timeout_s: float | None = None
    commands: dict[str, str] | None = None
    start: tuple[str, ...] = ()
    """Start phrases: when set, the session waits for one before inserting anything."""
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
            start = raw.get("start") or []
            if not isinstance(start, list) or len(start) > MAX_START_PHRASES or any(not isinstance(p, str) or not p.strip() for p in start):
                raise ValueError(f"start must be a list of up to {MAX_START_PHRASES} phrases")
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid stream options: {exc}") from exc
        if not 300 <= pause_ms <= 1500:
            raise ValueError("pause_ms must be 300-1500")
        if timeout is not None and not 1 <= timeout <= 600:
            raise ValueError("silence_timeout_s must be 1-600 or null")
        if commands is not None:
            if not isinstance(commands, dict) or any(k not in COMMAND_NAMES or not isinstance(v, str) or not v.strip() for k, v in commands.items()):
                raise ValueError("commands must map send/stop/clear to phrases")
        return cls(pause_ms=pause_ms, silence_timeout_s=timeout, commands=commands or None, start=tuple(p.strip() for p in start), preview=bool(raw.get("preview", True)),
                   custom_words=words, remove_fillers=bool(raw.get("remove_fillers", True)), correction_threshold=threshold)



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
        self._waiting = bool(options.start)
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
        was_waiting = self._waiting
        parsed = parse(text, self._o.commands or {}, self._o.start, self._waiting)
        self._waiting = parsed.waiting
        self._finals_pending -= 1
        for name in parsed.before:
            await self._emit({"type": "command", "name": name})
        started = "start" in parsed.before
        if started:
            await self._emit({"type": "state", "waiting": False})
        await self._emit({"type": "final", "seq": seq, "text": parsed.text})
        if parsed.after:
            await self._emit({"type": "command", "name": parsed.after})
        if parsed.waiting and (started or not was_waiting):
            await self._emit({"type": "state", "waiting": True})
        if parsed.after == "stop":
            self._spawn(self.finish("command"))

    def _maybe_partial(self) -> None:
        if (not self._o.preview or self._ending or self._waiting or self._phrase is None or self._finals_pending
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
        if text is None or self._ending or self._waiting or seq != self._open_seq or self._phrase is None or self._finals_pending:
            return
        text = text.strip()
        if self._o.commands:  # show what will be inserted, not the command words
            text = parse(text, self._o.commands, (), False).text
        await self._emit({"type": "partial", "seq": seq, "text": text})

    # ---- lifecycle ----
    async def announce(self) -> None:
        """Tell the client the initial state (only sessions with start phrases have one)."""
        if self._o.start:
            await self._emit({"type": "state", "waiting": True})

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
