"""Pause other media on this computer while Kokoro speaks, then resume it.

Uses MPRIS through playerctl, the standard media-player control on Linux
desktops (music apps, browser media, video players). Only players that were
playing get paused, and only those are resumed. Elsewhere, or without
playerctl, it reports itself unsupported and does nothing.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import sys
from typing import Awaitable, Callable

log = logging.getLogger("kokoro-server.other-audio")

OTHER_AUDIO = ("keep", "pause")

Runner = Callable[..., Awaitable[tuple[int, str]]]


def pause_supported() -> bool:
    return sys.platform.startswith("linux") and shutil.which("playerctl") is not None


async def run_cmd(*args: str, timeout: float = 3.0) -> tuple[int, str]:
    """Runs a command; returns (exit code, stdout). A missing tool gives 127."""
    if shutil.which(args[0]) is None:
        return 127, ""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        return proc.returncode or 0, out.decode(errors="replace")
    except (asyncio.TimeoutError, OSError):
        return 1, ""


class MediaPauser:
    """Reference-counted: back-to-back replies share one pause/resume cycle."""

    def __init__(self, run: Runner = run_cmd, release_s: float = 0.5, max_s: float = 600.0):
        self._run = run
        self._release_s = release_s
        self._max_s = max_s
        self._active: set[str] = set()
        self._paused: list[str] = []  # MPRIS player names
        self._applied = False
        self._release: asyncio.TimerHandle | None = None
        self._safety: asyncio.TimerHandle | None = None
        self._lock = asyncio.Lock()

    @property
    def applied(self) -> bool:
        return self._applied

    async def start(self, key: str, mode: str) -> bool:
        """Speech `key` began. Returns whether other media is being held paused for it."""
        if mode != "pause":
            return False
        async with self._lock:
            self._active.add(key)
            self._cancel_release()
            if self._applied:
                return True
            self._applied = True
            await self._pause()
            # Never leave media paused if an end is lost.
            loop = asyncio.get_running_loop()
            self._safety = loop.call_later(self._max_s, lambda: asyncio.ensure_future(self._resume(force=True)))
            return True

    async def end(self, key: str) -> None:
        """Speech `key` finished; resume shortly after the last one ends."""
        async with self._lock:
            if key not in self._active:
                return
            self._active.discard(key)
            if self._active or not self._applied:
                return
            self._cancel_release()
            loop = asyncio.get_running_loop()
            self._release = loop.call_later(self._release_s, lambda: asyncio.ensure_future(self._resume(force=False)))

    async def _resume(self, force: bool) -> None:
        async with self._lock:
            if self._active and not force:
                return  # the next reply started during the release delay
            self._active.clear()
            self._cancel_release()
            if self._safety is not None:
                self._safety.cancel()
                self._safety = None
            for player in self._paused:
                await self._run("playerctl", "-p", player, "play")
            self._paused = []
            self._applied = False

    def _cancel_release(self) -> None:
        if self._release is not None:
            self._release.cancel()
            self._release = None

    async def _pause(self) -> None:
        code, out = await self._run("playerctl", "-l")
        if code != 0:
            return
        for player in [p.strip() for p in out.splitlines() if p.strip()]:
            _, status = await self._run("playerctl", "-p", player, "status")
            if status.strip() != "Playing":
                continue
            code, _ = await self._run("playerctl", "-p", player, "pause")
            if code == 0:
                self._paused.append(player)
