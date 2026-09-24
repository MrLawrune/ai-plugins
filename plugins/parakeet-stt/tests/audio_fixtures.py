import io

import av
import numpy as np

FORMATS = {
    "webm": ("libopus", "flt", 48000),
    "ogg": ("libopus", "flt", 48000),
    "mp4": ("aac", "fltp", 44100),
    "wav": ("pcm_s16le", "s16", 48000),
}


def encode_tone(container: str, seconds: float = 1.0, amplitude: float = 0.3) -> bytes:
    codec, fmt, rate = FORMATS[container]
    t = np.arange(int(rate * seconds)) / rate
    samples = (amplitude * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    if fmt == "s16":
        samples = (samples * 32767).astype(np.int16)
    buf = io.BytesIO()
    out = av.open(buf, "w", format=container)
    stream = out.add_stream(codec, rate=rate, layout="mono")
    step = stream.codec_context.frame_size or 1024
    for i in range(0, len(samples), step):
        frame = av.AudioFrame.from_ndarray(samples[i : i + step].reshape(1, -1), format=fmt, layout="mono")
        frame.sample_rate = rate
        for packet in stream.encode(frame):
            out.mux(packet)
    for packet in stream.encode(None):
        out.mux(packet)
    out.close()
    return buf.getvalue()
