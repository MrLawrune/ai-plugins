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
        self._silero = None

    def load(self) -> None:
        import onnx_asr
        import onnxruntime as ort

        opts = ort.SessionOptions()
        if self._cfg.threads > 0:
            opts.intra_op_num_threads = self._cfg.threads
        self._model = onnx_asr.load_model(self._cfg.model, quantization=self._cfg.quantization, sess_options=opts)
        vad = onnx_asr.load_vad("silero")
        self._vad_model = self._model.with_vad(vad)
        self._silero = vad._model  # onnxruntime session; onnx-asr is pinned (0.12.0)
        self.ready = True
        log.info("loaded %s (%s)", self._cfg.model, self._cfg.quantization or "fp32")

    def transcribe(self, audio: np.ndarray) -> str:
        if not self.ready or self._model is None or self._vad_model is None:
            raise RuntimeError("model not loaded")
        if len(audio) <= self._cfg.vad_above_seconds * SAMPLE_RATE:
            return str(self._model.recognize(audio, sample_rate=SAMPLE_RATE)).strip()
        parts = (seg.text.strip() for seg in self._vad_model.recognize(audio, sample_rate=SAMPLE_RATE))
        return " ".join(p for p in parts if p)

    def new_vad(self):
        from parakeet_endpoint import SileroStream

        if self._silero is None:
            raise RuntimeError("model not loaded")
        return SileroStream(self._silero)
