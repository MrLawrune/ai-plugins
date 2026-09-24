"""Synthesis engines for the Kokoro TTS server.

LocalEngine wraps kokoro-onnx with a selectable ONNX Runtime execution
provider (cpu, cuda, openvino), optional thread and GPU memory limits, and
idle unload for GPU providers. RemoteEngine forwards synthesis to another
instance of this server's /synthesize endpoint and falls back to a local CPU
engine when the remote is unreachable.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator
from typing import Any

import numpy as np
from numpy.typing import NDArray

log = logging.getLogger("kokoro-server.engine")

PROVIDERS = ("cpu", "cuda", "openvino", "remote")
LOCAL_PROVIDERS = ("cpu", "cuda", "openvino")
SAMPLE_RATE = 24000


class EngineError(RuntimeError):
    pass


def _ort():
    import onnxruntime as rt
    return rt


def available_providers() -> dict[str, bool]:
    """Which local providers this process can build right now."""
    rt = _ort()
    have = set(rt.get_available_providers())
    return {
        "cpu": True,
        "cuda": "CUDAExecutionProvider" in have,
        "openvino": "OpenVINOExecutionProvider" in have,
    }


def build_session(
    model_path: str,
    provider: str,
    intra_op_threads: int = 0,
    gpu_mem_limit_mb: int = 0,
):
    """Create an ONNX Runtime session for the requested provider or raise EngineError."""
    rt = _ort()
    so = rt.SessionOptions()
    if intra_op_threads > 0:
        so.intra_op_num_threads = intra_op_threads
    if provider == "cpu":
        providers: list[Any] = ["CPUExecutionProvider"]
    elif provider == "cuda":
        if "CUDAExecutionProvider" not in rt.get_available_providers():
            raise EngineError("CUDA provider not available: install onnxruntime-gpu and the CUDA libraries")
        preload = getattr(rt, "preload_dlls", None)
        if preload:
            try:
                preload(cuda=True, cudnn=True, msvc=False)
            except Exception as e:  # pragma: no cover - depends on host libs
                log.warning("preload_dlls failed: %s", e)
        opts: dict[str, Any] = {"arena_extend_strategy": "kSameAsRequested"}
        if gpu_mem_limit_mb > 0:
            opts["gpu_mem_limit"] = int(gpu_mem_limit_mb) * 1024 * 1024
        providers = [("CUDAExecutionProvider", opts), "CPUExecutionProvider"]
    elif provider == "openvino":
        if "OpenVINOExecutionProvider" not in rt.get_available_providers():
            raise EngineError("OpenVINO provider not available: install onnxruntime-openvino")
        device = os.environ.get("KOKORO_OPENVINO_DEVICE", "GPU")
        providers = [("OpenVINOExecutionProvider", {"device_type": device}), "CPUExecutionProvider"]
    else:
        raise EngineError(f"unknown local provider {provider!r}")
    sess = rt.InferenceSession(model_path, so, providers=providers)
    active = sess.get_providers()
    wanted = {"cpu": "CPUExecutionProvider", "cuda": "CUDAExecutionProvider", "openvino": "OpenVINOExecutionProvider"}[provider]
    if active[0] != wanted:
        raise EngineError(f"{provider} requested but session fell back to {active[0]}")
    return sess


class LocalEngine:
    """Owns a kokoro-onnx instance; can rebuild for another provider and idle-unload."""

    def __init__(self, model_path: str, voices_path: str, provider: str = "cpu",
                 intra_op_threads: int = 0, gpu_mem_limit_mb: int = 0, idle_unload_minutes: int = 0):
        self.model_path = model_path
        self.voices_path = voices_path
        self.provider = provider
        self.intra_op_threads = intra_op_threads
        self.gpu_mem_limit_mb = gpu_mem_limit_mb
        self.idle_unload_minutes = idle_unload_minutes
        self._kokoro = None
        self._voices: NDArray | None = None
        self._lock = asyncio.Lock()
        self.last_used = time.time()
        self.load_ms: float | None = None
        self.loaded_provider: str | None = None

    # --- lifecycle ---

    def _load(self) -> None:
        from kokoro_onnx import Kokoro
        t = time.perf_counter()
        sess = build_session(self.model_path, self.provider, self.intra_op_threads, self.gpu_mem_limit_mb)
        self._kokoro = Kokoro.from_session(sess, self.voices_path)
        if self._voices is None:
            self._voices = self._kokoro.voices
        self.loaded_provider = self.provider
        self.load_ms = (time.perf_counter() - t) * 1000
        log.info("Engine loaded: provider=%s threads=%s in %.0fms", self.provider, self.intra_op_threads or "auto", self.load_ms)
        if self.provider != "cpu":
            # warm the GPU graph so the first real request is not slow
            try:
                self._kokoro.create("Ready.", voice=self.get_voice_style("af_sky"), speed=1.0)
            except Exception:
                log.exception("warmup failed")

    def ensure_loaded(self) -> None:
        if self._kokoro is None:
            self._load()
        self.last_used = time.time()

    def unload(self) -> None:
        if self._kokoro is not None:
            log.info("Engine unloaded (provider=%s)", self.loaded_provider)
        self._kokoro = None
        self.loaded_provider = None

    @property
    def loaded(self) -> bool:
        return self._kokoro is not None

    def reconfigure(self, provider: str, intra_op_threads: int, gpu_mem_limit_mb: int, idle_unload_minutes: int) -> None:
        """Apply new settings; rebuild the session now so errors surface to the caller."""
        changed = (provider, intra_op_threads, gpu_mem_limit_mb) != (self.provider, self.intra_op_threads, self.gpu_mem_limit_mb)
        self.idle_unload_minutes = idle_unload_minutes
        if not changed:
            return
        old = (self.provider, self.intra_op_threads, self.gpu_mem_limit_mb)
        self.provider, self.intra_op_threads, self.gpu_mem_limit_mb = provider, intra_op_threads, gpu_mem_limit_mb
        self.unload()
        try:
            self._load()
        except Exception:
            self.provider, self.intra_op_threads, self.gpu_mem_limit_mb = old
            self.unload()
            raise

    def maybe_idle_unload(self) -> bool:
        if self.idle_unload_minutes <= 0 or not self.loaded or self.provider == "cpu":
            return False
        if time.time() - self.last_used >= self.idle_unload_minutes * 60:
            self.unload()
            return True
        return False

    # --- voices ---

    def voices(self) -> list[str]:
        if self._voices is None:
            self._voices = np.load(self.voices_path)
        return sorted(self._voices.keys())

    def get_voice_style(self, name: str) -> NDArray[np.float32]:
        if self._voices is None:
            self._voices = np.load(self.voices_path)
        return self._voices[name]

    # --- synthesis ---

    async def stream(self, text: str, style: NDArray[np.float32], speed: float, lang: str, trim: bool) -> AsyncIterator[tuple[NDArray[np.float32], int]]:
        async with self._lock:
            self.ensure_loaded()
        assert self._kokoro is not None
        async for samples, sr in self._kokoro.create_stream(text, voice=style, speed=speed, lang=lang, trim=trim):
            self.last_used = time.time()
            yield samples, sr

    def create(self, text: str, style: NDArray[np.float32], speed: float, lang: str, trim: bool) -> tuple[NDArray[np.float32], int]:
        self.ensure_loaded()
        assert self._kokoro is not None
        return self._kokoro.create(text, voice=style, speed=speed, lang=lang, trim=trim)

    def info(self) -> dict:
        return {
            "kind": "local",
            "provider": self.provider,
            "loaded": self.loaded,
            "loaded_provider": self.loaded_provider,
            "intra_op_threads": self.intra_op_threads,
            "gpu_mem_limit_mb": self.gpu_mem_limit_mb,
            "idle_unload_minutes": self.idle_unload_minutes,
            "load_ms": self.load_ms,
            "available": available_providers(),
        }


class RemoteEngine:
    """Forwards synthesis to another kokoro server's POST /synthesize."""

    def __init__(self, url: str, fallback: LocalEngine | None, timeout_s: float = 15.0):
        self.url = url.rstrip("/")
        self.fallback = fallback
        self.timeout_s = timeout_s
        self.last_error: str | None = None
        self.last_latency_ms: float | None = None
        self._session = None

    async def _http(self):
        import aiohttp
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.timeout_s))
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def health(self) -> dict | None:
        try:
            http = await self._http()
            async with http.get(f"{self.url}/health", timeout=3) as r:
                if r.status != 200:
                    return None
                return await r.json()
        except Exception as e:
            self.last_error = str(e)
            return None

    async def stream(self, text: str, voice: Any, speed: float, lang: str, trim: bool) -> AsyncIterator[tuple[NDArray[np.float32], int]]:
        """Yield one chunk per sentence-group as the remote streams them back.

        The response is read at playback pace, so a long reply outlasts any
        whole-request timeout: only connecting and each read are bounded.
        Once audio has been yielded, a failure is raised rather than handed
        to the fallback, which would replay the reply from the start.
        """
        import aiohttp
        yielded = False
        try:
            http = await self._http()
            t = time.perf_counter()
            async with http.post(f"{self.url}/synthesize", json={
                "text": text, "voice": voice, "speed": speed, "lang": lang, "trim": trim,
            }, headers={"X-Kokoro-Hop": "1"}, timeout=aiohttp.ClientTimeout(
                total=None, sock_connect=self.timeout_s, sock_read=self.timeout_s,
            )) as r:
                if r.status != 200:
                    raise EngineError(f"remote returned {r.status}: {(await r.text())[:200]}")
                sr = int(r.headers.get("X-Sample-Rate", SAMPLE_RATE))
                first = True
                # Frames: 4-byte little-endian length prefix, then float32 samples.
                buf = b""
                async for data in r.content.iter_any():
                    buf += data
                    while len(buf) >= 4:
                        n = int.from_bytes(buf[:4], "little")
                        if len(buf) < 4 + n:
                            break
                        frame, buf = buf[4:4 + n], buf[4 + n:]
                        if first:
                            self.last_latency_ms = (time.perf_counter() - t) * 1000
                            first = False
                        yielded = True
                        yield np.frombuffer(frame, dtype=np.float32), sr
            self.last_error = None
        except Exception as e:
            self.last_error = str(e)
            log.warning("Remote synthesis failed (%s); fallback=%s", e, bool(self.fallback) and not yielded)
            if self.fallback is None or yielded:
                raise
            from kokoro_config import blend_voice
            style = blend_voice(voice, self.fallback.get_voice_style)
            async for chunk in self.fallback.stream(text, style, speed, lang, trim):
                yield chunk

    def info(self) -> dict:
        return {
            "kind": "remote",
            "provider": "remote",
            "url": self.url,
            "last_error": self.last_error,
            "last_latency_ms": self.last_latency_ms,
            "fallback": self.fallback.info() if self.fallback else None,
        }
