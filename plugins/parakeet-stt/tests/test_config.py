import pytest

from parakeet_config import ConfigError, ServerConfig, is_loopback


def test_defaults():
    cfg = ServerConfig.from_env({})
    assert (cfg.host, cfg.port) == ("127.0.0.1", 6790)
    assert cfg.model == "nemo-parakeet-tdt-0.6b-v2"
    assert cfg.model_id == "parakeet-tdt-0.6b-v2"
    assert cfg.quantization == "int8"
    assert cfg.max_upload_bytes == 25 * 1024 * 1024
    assert (cfg.max_seconds, cfg.vad_above_seconds, cfg.queue_timeout_s) == (600, 90, 60)
    assert cfg.api_key is None


def test_non_loopback_requires_key():
    with pytest.raises(ConfigError, match="PARAKEET_API_KEY"):
        ServerConfig.from_env({"PARAKEET_HOST": "0.0.0.0"})
    cfg = ServerConfig.from_env({"PARAKEET_HOST": "0.0.0.0", "PARAKEET_API_KEY": "k"})
    assert cfg.api_key == "k"


def test_bad_number_is_config_error():
    with pytest.raises(ConfigError, match="PARAKEET_PORT"):
        ServerConfig.from_env({"PARAKEET_PORT": "abc"})


@pytest.mark.parametrize("host,expected", [("127.0.0.1", True), ("localhost", True), ("::1", True), ("0.0.0.0", False), ("10.1.2.3", False)])
def test_is_loopback(host, expected):
    assert is_loopback(host) is expected
