"""Decode any browser recording (webm/opus, ogg, mp4/aac, wav, mp3) to 16 kHz mono float32."""
from __future__ import annotations

import io

import av
import numpy as np

SAMPLE_RATE = 16000


class AudioDecodeError(Exception):
    pass


def decode_to_mono16k(data: bytes) -> np.ndarray:
    if not data:
        raise AudioDecodeError("empty audio")
    try:
        with av.open(io.BytesIO(data)) as container:
            if not container.streams.audio:
                raise AudioDecodeError("no audio stream")
            resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)
            chunks: list[np.ndarray] = []
            for frame in container.decode(audio=0):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1))
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray().reshape(-1))
    except av.error.FFmpegError as exc:
        raise AudioDecodeError(f"could not decode audio: {exc}") from exc
    if not chunks:
        raise AudioDecodeError("no audio frames")
    return np.concatenate(chunks).astype(np.float32, copy=False)
