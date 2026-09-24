import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from kokoro_config import (  # noqa: E402
    DEFAULTS,
    ConfigError,
    ConfigStore,
    LANG_BY_PREFIX,
    blend_voice,
    validate_patch,
    voice_metadata,
)

VOICES = ["af_sky", "af_bella", "am_adam", "bf_emma", "jf_alpha", "zm_yunxi"]


def test_defaults_are_complete():
    assert DEFAULTS["voice"] == "af_sky"
    assert DEFAULTS["speed"] == 1.0
    assert DEFAULTS["mode"] == "brief"
    assert DEFAULTS["output_device"] is None
    assert "muted" not in DEFAULTS  # runtime-only


def test_validate_accepts_valid_patch():
    patch = {"voice": "am_adam", "speed": 1.5, "lang": "en-gb", "mode": "quiet"}
    assert validate_patch(patch, VOICES) == patch


def test_validate_rejects_unknown_key():
    with pytest.raises(ConfigError) as e:
        validate_patch({"bogus": 1}, VOICES)
    assert "bogus" in e.value.errors


@pytest.mark.parametrize("key,value", [
    ("speed", 0.4), ("speed", 2.1), ("speed", "fast"),
    ("mode", "loud"),
    ("voice", "xx_nobody"),
    ("voice", {"af_sky": -1}),
    ("voice", {"xx_nobody": 1}),
    ("voice", {}),
    ("speech_gain", 3),
    ("sound_volume", -0.1),
    ("trim", "yes"),
    ("output_device", "pipewire"),
    ("lang", ""),
    ("provider", "tpu"),
    ("remote_url", "tts-host:6789"),
    ("remote_url", 5),
    ("idle_unload_minutes", -1),
    ("intra_op_threads", 2.5),
    ("gpu_mem_limit_mb", True),
    ("fallback_to_cpu", "no"),
    ("lead_in_ms", 5000),
    ("gap_ms", -1),
])
def test_validate_rejects_bad_values(key, value):
    with pytest.raises(ConfigError) as e:
        validate_patch({key: value}, VOICES)
    assert key in e.value.errors


def test_validate_accepts_blend_and_int_device():
    patch = {"voice": {"af_sky": 2, "am_adam": 1}, "output_device": 4}
    out = validate_patch(patch, VOICES)
    assert out["voice"] == {"af_sky": 2.0, "am_adam": 1.0}
    assert out["output_device"] == 4


def test_validate_coerces_int_speed_to_float():
    assert validate_patch({"speed": 1}, VOICES)["speed"] == 1.0


def test_store_roundtrip(tmp_path):
    path = tmp_path / "config.json"
    store = ConfigStore(path, VOICES)
    assert store.get() == DEFAULTS
    store.patch({"voice": "bf_emma", "speed": 0.8})
    assert store.get()["voice"] == "bf_emma"
    reloaded = ConfigStore(path, VOICES)
    assert reloaded.get()["voice"] == "bf_emma"
    assert reloaded.get()["speed"] == 0.8
    assert json.loads(path.read_text())["voice"] == "bf_emma"


def test_store_ignores_corrupt_file(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{not json")
    store = ConfigStore(path, VOICES)
    assert store.get() == DEFAULTS


def test_store_drops_unknown_and_invalid_persisted_values(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"voice": "xx_gone", "speed": 1.7, "legacy": 1}))
    store = ConfigStore(path, VOICES)
    cfg = store.get()
    assert cfg["voice"] == "af_sky"
    assert cfg["speed"] == 1.7
    assert "legacy" not in cfg


def test_store_patch_is_atomic_on_error(tmp_path):
    store = ConfigStore(tmp_path / "c.json", VOICES)
    with pytest.raises(ConfigError):
        store.patch({"speed": 1.2, "mode": "loud"})
    assert store.get()["speed"] == 1.0


def test_blend_single_name_returns_style():
    styles = {"af_sky": np.ones((3, 2), dtype=np.float32), "am_adam": np.zeros((3, 2), dtype=np.float32)}
    out = blend_voice("af_sky", styles.__getitem__)
    assert np.array_equal(out, styles["af_sky"])


def test_blend_normalizes_weights():
    styles = {"af_sky": np.ones((3, 2), dtype=np.float32), "am_adam": np.zeros((3, 2), dtype=np.float32)}
    out = blend_voice({"af_sky": 3, "am_adam": 1}, styles.__getitem__)
    assert np.allclose(out, 0.75)
    assert out.dtype == np.float32


def test_voice_metadata():
    meta = voice_metadata(VOICES)
    by_name = {m["name"]: m for m in meta}
    assert by_name["af_sky"] == {"name": "af_sky", "lang_code": "a", "lang": "en-us", "language": "American English", "gender": "female"}
    assert by_name["bf_emma"]["lang"] == "en-gb"
    assert by_name["jf_alpha"]["language"] == "Japanese"
    assert by_name["zm_yunxi"]["gender"] == "male"
    assert set(LANG_BY_PREFIX) == {"a", "b", "e", "f", "h", "i", "j", "p", "z"}


def test_engine_defaults_and_validation():
    assert DEFAULTS["provider"] == "cpu"
    assert DEFAULTS["remote_url"] is None
    out = validate_patch({"provider": "remote", "remote_url": "http://192.168.1.50:6789/", "idle_unload_minutes": 0, "intra_op_threads": 6, "gpu_mem_limit_mb": 1024}, VOICES)
    assert out["remote_url"] == "http://192.168.1.50:6789"
    assert out["intra_op_threads"] == 6
    assert validate_patch({"remote_url": None}, VOICES) == {"remote_url": None}


def test_sentence_chunks():
    sys.path.insert(0, str(Path(__file__).parent.parent / "server"))
    from kokoro_server import sentence_chunks
    assert sentence_chunks("One. Two! Three?") == ["One. Two! Three?"]
    long = " ".join(f"Sentence number {i} is here." for i in range(20))
    chunks = sentence_chunks(long, max_chars=100)
    assert all(len(c) <= 100 for c in chunks)
    assert " ".join(chunks) == long
    assert sentence_chunks("   ") == []


def test_speech_log_persists_and_reloads(tmp_path):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
    from kokoro_server import SpeechLog

    path = tmp_path / "speech-log.jsonl"
    log = SpeechLog(path)
    e = log.add("Hello   there.", "s1")
    assert e["text"] == "Hello there." and e["status"] == "queued"
    log.update(e, "done", first_audio_ms=400)
    e2 = log.add("Second", "s1")  # stays queued: simulates crash mid-speech

    reloaded = SpeechLog(path)
    entries = reloaded.recent(10)
    assert [x["id"] for x in entries] == [e["id"], e2["id"]]
    assert entries[0]["status"] == "done" and entries[0]["first_audio_ms"] == 400
    assert entries[1]["status"] == "interrupted"
    assert reloaded.add("Third", "s2")["id"] == e2["id"] + 1
