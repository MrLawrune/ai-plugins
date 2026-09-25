import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from kokoro_pause import MediaPauser  # noqa: E402


class FakeRunner:
    def __init__(self, players=None):
        self.players = dict(players or {})  # name -> status
        self.calls = []

    async def __call__(self, *args, timeout=3.0):
        self.calls.append(args)
        if args == ("playerctl", "-l"):
            return 0, "\n".join(self.players)
        if args[0] == "playerctl" and args[3] == "status":
            return 0, self.players[args[2]] + "\n"
        return 0, ""

    def commands(self):
        return [(c[2], c[3]) for c in self.calls if c[0] == "playerctl" and len(c) > 3 and c[3] in ("pause", "play")]


def run(coro):
    return asyncio.run(coro)


def test_keep_does_nothing():
    r = FakeRunner({"spotify": "Playing"})

    async def go():
        assert await MediaPauser(run=r).start("a", "keep") is False
    run(go())
    assert r.calls == []


def test_pauses_only_playing_players_and_resumes_only_those():
    r = FakeRunner({"spotify": "Playing", "firefox.instance1": "Paused", "vlc": "Playing"})

    async def go():
        p = MediaPauser(run=r, release_s=0.01)
        assert await p.start("a", "pause") is True
        await p.end("a")
        await asyncio.sleep(0.05)
        assert not p.applied
    run(go())
    assert r.commands() == [("spotify", "pause"), ("vlc", "pause"), ("spotify", "play"), ("vlc", "play")]


def test_back_to_back_replies_share_one_cycle():
    r = FakeRunner({"spotify": "Playing"})

    async def go():
        p = MediaPauser(run=r, release_s=0.02)
        await p.start("a", "pause")
        await p.start("b", "pause")
        await p.end("a")
        await asyncio.sleep(0.05)
        assert p.applied, "b still speaking"
        await p.end("b")
        await p.start("c", "pause")  # the next reply, within the release delay
        await asyncio.sleep(0.05)
        assert p.applied
        await p.end("c")
        await asyncio.sleep(0.05)
        assert not p.applied
    run(go())
    assert r.commands() == [("spotify", "pause"), ("spotify", "play")]


def test_safety_timeout_resumes_after_a_lost_end():
    r = FakeRunner({"spotify": "Playing"})

    async def go():
        p = MediaPauser(run=r, max_s=0.02)
        await p.start("a", "pause")
        await asyncio.sleep(0.06)
        assert not p.applied
    run(go())
    assert r.commands() == [("spotify", "pause"), ("spotify", "play")]


def test_without_playerctl_it_is_harmless():
    async def missing(*args, timeout=3.0):
        return 127, ""

    async def go():
        p = MediaPauser(run=missing, release_s=0.01)
        await p.start("a", "pause")
        await p.end("a")
    run(go())
