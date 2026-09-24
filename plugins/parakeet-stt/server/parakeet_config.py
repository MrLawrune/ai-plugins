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
