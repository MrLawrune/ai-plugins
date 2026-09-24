#!/bin/bash
# Verify each pinned model file's size and SHA-256 against upstream.
set -euo pipefail
manifest="${1:-plugins/kokoro-tts/server/models.json}"
jq -c '.files[]' "$manifest" | while read -r f; do
  name=$(jq -r .name <<<"$f"); url=$(jq -r .url <<<"$f")
  size=$(jq -r .size <<<"$f"); sha=$(jq -r .sha256 <<<"$f")
  tmp=$(mktemp); curl -fsSL -o "$tmp" "$url"
  [ "$(stat -c%s "$tmp")" = "$size" ] || { echo "$name: size changed" >&2; exit 1; }
  echo "$sha  $tmp" | sha256sum -c --quiet || { echo "$name: checksum changed" >&2; exit 1; }
  rm -f "$tmp"; echo "$name ok"
done
