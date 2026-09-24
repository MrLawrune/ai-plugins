#!/bin/bash
# Release parakeet-stt: bump versions, test, build, commit, tag parakeet-stt/vX.Y.Z, push.
set -euo pipefail

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 X.Y.Z" >&2; exit 2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="parakeet-stt/v$version"
cd "$root"

[ -z "$(git status --porcelain -- .)" ] || { echo "working tree not clean in $root" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "tag $tag already exists" >&2; exit 1; }

jq --arg v "$version" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json
# Only the [project] table's version (the first unindented `version =` line).
sed -i -E "0,/^version = \"[^\"]+\"/s//version = \"$version\"/" server/pyproject.toml
sed -i -E "s/^SERVER_VERSION = \"[^\"]+\"/SERVER_VERSION = \"$version\"/" server/parakeet_server.py
# uv.lock records the project version; re-lock (resolution only, no sync).
uv lock --project server
npm version "$version" --no-git-tag-version --allow-same-version >/dev/null

# Test against a scratch environment so server/.venv is left untouched.
tmp_venv="$(mktemp -d)"
trap 'rm -rf "$tmp_venv"' EXIT
UV_PROJECT_ENVIRONMENT="$tmp_venv" uv run --frozen --project server --with pytest pytest tests -q
npm test
npx tsc --noEmit
bb plugin build .

git add package.json package-lock.json server/pyproject.toml server/uv.lock server/parakeet_server.py
git commit -m "chore(parakeet-stt): release $version"
git tag -a "$tag" -m "parakeet-stt $version"
git push origin HEAD "$tag"
echo "released $tag"
