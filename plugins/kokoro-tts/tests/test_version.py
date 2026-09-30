"""Every manifest that carries the plugin version names the same release."""

import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).parent.parent


def test_plugin_versions_agree():
    package = json.loads((ROOT / "package.json").read_text())["version"]
    lock = json.loads((ROOT / "package-lock.json").read_text())
    pyproject = tomllib.loads((ROOT / "server" / "pyproject.toml").read_text())["project"]["version"]
    uv_lock = tomllib.loads((ROOT / "server" / "uv.lock").read_text())
    locked = next(p["version"] for p in uv_lock["package"] if p["name"] == "kokoro-tts-server")
    server = re.search(r'^SERVER_VERSION = "([^"]+)"', (ROOT / "server" / "kokoro_server.py").read_text(), re.M)[1]
    assert {package, lock["version"], lock["packages"][""]["version"], pyproject, locked, server} == {"0.3.3"}
