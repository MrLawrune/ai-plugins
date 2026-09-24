#!/bin/bash
# Release kokoro-tts: bump versions, test, build, commit, tag kokoro-tts/vX.Y.Z, push.
set -euo pipefail

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 X.Y.Z" >&2; exit 2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="kokoro-tts/v$version"
cd "$root"

[ -z "$(git status --porcelain -- .)" ] || { echo "working tree not clean in $root" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "tag $tag already exists" >&2; exit 1; }

jq --arg v "$version" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json
jq --arg v "$version" '.version = $v' .claude-plugin/plugin.json > p.tmp && mv p.tmp .claude-plugin/plugin.json
# Only the [project] table's version -- the first unindented `version =`
# line. A plain global `s///` would also rewrite the
# [[tool.uv.dependency-metadata]] kokoro-onnx version pin further down,
# breaking it (tests/test_runtime_groups.py guards this).
sed -i -E "0,/^version = \"[^\"]+\"/s//version = \"$version\"/" server/pyproject.toml
sed -i -E "s/^SERVER_VERSION = \"[^\"]+\"/SERVER_VERSION = \"$version\"/" server/kokoro_server.py
# uv.lock records the project version; re-lock (resolution only, no sync).
uv lock --project server
npm version "$version" --no-git-tag-version --allow-same-version >/dev/null

# A plain `uv run --project server` syncs the default `cpu` group into
# server/.venv, which would overwrite a GPU runtime already installed there.
# Run the test suite against a scratch environment instead.
tmp_venv="$(mktemp -d)"
trap 'rm -rf "$tmp_venv"' EXIT
UV_PROJECT_ENVIRONMENT="$tmp_venv" uv run --frozen --project server --with pytest pytest tests -q
npm test
npx tsc --noEmit
bb plugin build .

git add package.json package-lock.json .claude-plugin/plugin.json server/pyproject.toml server/uv.lock server/kokoro_server.py
git commit -m "chore(kokoro-tts): release $version"
git tag -a "$tag" -m "kokoro-tts $version"
git push origin HEAD "$tag"
echo "released $tag"
