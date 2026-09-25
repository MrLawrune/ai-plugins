"""Persisted runtime configuration for the Kokoro TTS server.

Pure module: no aiohttp, no sounddevice. Validation happens at the boundary so
handlers pass typed values inward.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

log = logging.getLogger("kokoro-server.config")

MODES = ("quiet", "ambient", "brief", "conversational", "verbose", "full")
OTHER_AUDIO = ("keep", "pause")
PROVIDERS = ("cpu", "cuda", "openvino", "remote")
SPEED_RANGE = (0.5, 2.0)
GAIN_RANGE = (0.0, 2.0)

DEFAULTS: dict[str, Any] = {
    "voice": "af_sky",
    "speed": 1.0,
    "lang": "en-us",
    "trim": True,
    "mode": "brief",
    "speech_gain": 1.0,
    "sound_volume": 1.0,
    "working_sound": True,
    "attention_sound": True,
    "strip_markdown": True,
    "output_device": None,
    "lead_in_ms": 300,
    "gap_ms": 60,
    # other media on this computer while speech plays here: keep | pause
    "other_audio": "keep",
    # engine
    "provider": "cpu",
    "remote_url": None,
    "fallback_to_cpu": True,
    "idle_unload_minutes": 10,
    "intra_op_threads": 0,
    "gpu_mem_limit_mb": 0,
}

# Voice name prefix -> (kokoro lang code, espeak lang, human label)
LANG_BY_PREFIX: dict[str, tuple[str, str]] = {
    "a": ("en-us", "American English"),
    "b": ("en-gb", "British English"),
    "e": ("es", "Spanish"),
    "f": ("fr-fr", "French"),
    "h": ("hi", "Hindi"),
    "i": ("it", "Italian"),
    "j": ("ja", "Japanese"),
    "p": ("pt-br", "Brazilian Portuguese"),
    "z": ("cmn", "Mandarin Chinese"),
}


class ConfigError(ValueError):
    def __init__(self, errors: dict[str, str]):
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))
        self.errors = errors


def _num(value: Any, lo: float, hi: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    if not (lo <= f <= hi):
        return None
    return f


def _validate_voice(value: Any, voices: list[str]) -> tuple[Any, str | None]:
    if isinstance(value, str):
        if value not in voices:
            return None, f"unknown voice {value!r}"
        return value, None
    if isinstance(value, dict):
        if not value:
            return None, "blend must name at least one voice"
        out: dict[str, float] = {}
        for name, weight in value.items():
            if name not in voices:
                return None, f"unknown voice {name!r}"
            w = _num(weight, 0.0, float("inf"))
            if w is None:
                return None, f"weight for {name!r} must be a non-negative number"
            out[name] = w
        if sum(out.values()) <= 0:
            return None, "blend weights must sum to more than zero"
        return out, None
    return None, "voice must be a name or a {name: weight} map"


def validate_patch(patch: dict[str, Any], voices: list[str]) -> dict[str, Any]:
    """Return a normalized copy of patch or raise ConfigError with per-key messages."""
    errors: dict[str, str] = {}
    out: dict[str, Any] = {}
    for key, value in patch.items():
        if key not in DEFAULTS:
            errors[key] = "unknown setting"
            continue
        if key == "voice":
            v, err = _validate_voice(value, voices)
            if err:
                errors[key] = err
            else:
                out[key] = v
        elif key == "speed":
            v = _num(value, *SPEED_RANGE)
            if v is None:
                errors[key] = f"must be a number between {SPEED_RANGE[0]} and {SPEED_RANGE[1]}"
            else:
                out[key] = v
        elif key in ("speech_gain", "sound_volume"):
            v = _num(value, *GAIN_RANGE)
            if v is None:
                errors[key] = f"must be a number between {GAIN_RANGE[0]} and {GAIN_RANGE[1]}"
            else:
                out[key] = v
        elif key == "mode":
            if value not in MODES:
                errors[key] = f"must be one of {', '.join(MODES)}"
            else:
                out[key] = value
        elif key == "other_audio":
            if value not in OTHER_AUDIO:
                errors[key] = f"must be one of {', '.join(OTHER_AUDIO)}"
            else:
                out[key] = value
        elif key == "lang":
            if not isinstance(value, str) or not value.strip():
                errors[key] = "must be a non-empty espeak language code"
            else:
                out[key] = value.strip()
        elif key in ("trim", "working_sound", "attention_sound", "strip_markdown"):
            if not isinstance(value, bool):
                errors[key] = "must be true or false"
            else:
                out[key] = value
        elif key == "output_device":
            if value is None or (isinstance(value, int) and not isinstance(value, bool) and value >= 0):
                out[key] = value
            else:
                errors[key] = "must be a device index or null"
        elif key == "provider":
            if value not in PROVIDERS:
                errors[key] = f"must be one of {', '.join(PROVIDERS)}"
            else:
                out[key] = value
        elif key == "remote_url":
            if value is None:
                out[key] = None
            elif isinstance(value, str) and value.strip().startswith(("http://", "https://")):
                out[key] = value.strip().rstrip("/")
            else:
                errors[key] = "must be an http(s) URL or null"
        elif key == "fallback_to_cpu":
            if not isinstance(value, bool):
                errors[key] = "must be true or false"
            else:
                out[key] = value
        elif key in ("lead_in_ms", "gap_ms"):
            hi = 2000 if key == "lead_in_ms" else 1000
            if isinstance(value, bool) or not isinstance(value, int) or not (0 <= value <= hi):
                errors[key] = f"must be an integer between 0 and {hi}"
            else:
                out[key] = value
        elif key in ("idle_unload_minutes", "intra_op_threads", "gpu_mem_limit_mb"):
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                errors[key] = "must be a non-negative integer"
            else:
                out[key] = value
    if errors:
        raise ConfigError(errors)
    return out


class ConfigStore:
    """Loads, validates, patches, and persists the config file."""

    def __init__(self, path: str | os.PathLike[str], voices: list[str]):
        self.path = Path(path)
        self.voices = voices
        self._cfg: dict[str, Any] = dict(DEFAULTS)
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            log.warning("Ignoring unreadable config %s: %s", self.path, e)
            return
        if not isinstance(raw, dict):
            log.warning("Ignoring non-object config %s", self.path)
            return
        for key, value in raw.items():
            try:
                self._cfg.update(validate_patch({key: value}, self.voices))
            except ConfigError as e:
                log.warning("Dropping persisted setting %s: %s", key, e)

    def get(self) -> dict[str, Any]:
        return dict(self._cfg)

    def patch(self, patch: dict[str, Any]) -> dict[str, Any]:
        clean = validate_patch(patch, self.voices)
        self._cfg.update(clean)
        self._save()
        return self.get()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".config-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self._cfg, f, indent=2, sort_keys=True)
                f.write("\n")
            os.replace(tmp, self.path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def blend_voice(
    voice: str | dict[str, float],
    get_style: Callable[[str], NDArray[np.float32]],
) -> NDArray[np.float32]:
    """Resolve a voice name or weighted map to a style array."""
    if isinstance(voice, str):
        return get_style(voice)
    total = float(sum(voice.values()))
    acc: NDArray[np.float32] | None = None
    for name, weight in voice.items():
        part = get_style(name).astype(np.float32) * np.float32(weight / total)
        acc = part if acc is None else acc + part
    assert acc is not None
    return acc.astype(np.float32)


def voice_metadata(voices: list[str]) -> list[dict[str, str]]:
    out = []
    for name in sorted(voices):
        prefix = name[:1]
        gender_code = name[1:2]
        lang, label = LANG_BY_PREFIX.get(prefix, ("en-us", "Unknown"))
        out.append({
            "name": name,
            "lang_code": prefix,
            "lang": lang,
            "language": label,
            "gender": {"f": "female", "m": "male"}.get(gender_code, "unknown"),
        })
    return out
