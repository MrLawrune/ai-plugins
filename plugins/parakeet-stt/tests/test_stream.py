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
