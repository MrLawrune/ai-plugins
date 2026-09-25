"""Phrase endpointing over per-frame speech probabilities, plus a streaming Silero wrapper."""
from __future__ import annotations

import numpy as np

FRAME = 512  # samples per VAD frame at 16 kHz (32 ms)
_CONTEXT = 64


class Endpointer:
    """A phrase opens after `start_frames` frames >= `on` and closes after `pause_frames` quiet frames.
    During a pause, a noise blip shorter than `resume_frames` holds the count instead of restarting it."""

    def __init__(self, pause_frames: int, start_frames: int = 2, on: float = 0.5, off: float = 0.35, resume_frames: int = 3) -> None:
        self.pause_frames, self.start_frames, self.on, self.off = pause_frames, start_frames, on, off
        self.resume_frames = resume_frames
        self.active = False
        self._run = 0
        self._quiet = 0
        self._loud = 0

    def push(self, prob: float) -> str | None:
        if not self.active:
            self._run = self._run + 1 if prob >= self.on else 0
            if self._run >= self.start_frames:
                self.active, self._quiet = True, 0
                return "start"
            return None
        if prob < self.off:
            self._loud = 0
            self._quiet += 1
        else:
            self._loud += 1
            if self._loud >= self.resume_frames:
                self._quiet = 0  # sustained sound: speech resumed (a shorter blip just pauses the count)
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
