"""Guard the single-ONNX-Runtime layout of the server's uv project.

kokoro-onnx's upstream metadata hard-requires `onnxruntime`. pyproject.toml
replaces that metadata via [[tool.uv.dependency-metadata]], which uv only
applies when its version matches the resolved kokoro-onnx. A mismatch makes
uv silently fall back to upstream metadata and install `onnxruntime` into
every group, next to onnxruntime-gpu / onnxruntime-openvino.
"""

import re
import tomllib
from pathlib import Path

SERVER = Path(__file__).parent.parent / "server"


def _req_name(req: str) -> str:
    return re.split(r"[\s;<>=!~\[@(]", req.strip(), maxsplit=1)[0].lower().replace("_", "-")


def _pyproject() -> dict:
    return tomllib.loads((SERVER / "pyproject.toml").read_text())


def _kokoro_pin(project: dict) -> str:
    deps = [d for d in project["project"]["dependencies"] if _req_name(d) == "kokoro-onnx"]
    assert len(deps) == 1, deps
    match = re.fullmatch(r"kokoro-onnx\s*==\s*([^\s;,]+)", deps[0].strip())
    assert match, f"kokoro-onnx must be pinned with ==, got {deps[0]!r}"
    return match.group(1)


def test_kokoro_onnx_pin_matches_dependency_metadata_without_onnxruntime():
    project = _pyproject()
    pin = _kokoro_pin(project)
    entries = [
        e for e in project["tool"]["uv"].get("dependency-metadata", [])
        if e["name"] == "kokoro-onnx"
    ]
    assert len(entries) == 1, entries
    assert entries[0].get("version") == pin
    names = {_req_name(r) for r in entries[0]["requires-dist"]}
    assert not any(n.startswith("onnxruntime") for n in names), names


def test_lock_kokoro_onnx_has_no_onnxruntime_dependency():
    lock = tomllib.loads((SERVER / "uv.lock").read_text())
    pin = _kokoro_pin(_pyproject())
    packages = [p for p in lock["package"] if p["name"] == "kokoro-onnx"]
    assert [p["version"] for p in packages] == [pin]
    dep_names = {d["name"] for d in packages[0].get("dependencies", [])}
    assert not any(n.startswith("onnxruntime") for n in dep_names), dep_names
