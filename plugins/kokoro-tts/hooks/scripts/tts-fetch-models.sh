#!/bin/bash
# Download the Kokoro model files listed in server/models.json into the data
# dir, verifying each against its sha256. Resumable (curl -C -), safe to run
# from several sessions at once (lock dir), and a no-op once everything is
# in place. Writes <name>.sha256 markers like the bb plugin does, so both
# share one verified copy.
#
# Env: KOKORO_MODELS_MANIFEST  manifest path (default: <plugin>/server/models.json)
#      KOKORO_DATA_DIR         target dir (default: $XDG_DATA_HOME/kokoro-tts,
#                              else ~/.local/share/kokoro-tts)
# Requires: bash, curl, jq, sha256sum (or shasum). Exit 0 when all files are
# verified (or another fetch holds the lock), 1 on failure.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
MANIFEST="${KOKORO_MODELS_MANIFEST:-$PLUGIN_DIR/server/models.json}"
DATA_DIR="${KOKORO_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/kokoro-tts}"
# A plain file, not a directory: its content (the owning pid) must exist the
# instant the file becomes visible at $LOCK, so a concurrent reader can never
# observe a lock that exists but whose pid hasn't been written yet.
LOCK="$DATA_DIR/.fetch-models.lock"

log() { echo "[$(date)] tts-fetch-models: $*"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

size_of() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null || echo -1; }

[ -f "$MANIFEST" ] || { log "manifest not found: $MANIFEST"; exit 1; }
mkdir -p "$DATA_DIR" || { log "cannot create $DATA_DIR"; exit 1; }

# ln is atomic and, unlike mkdir followed by a separate pid write, fails
# outright if $LOCK already exists -- there is no window where a concurrent
# reader can see a lock with an empty or missing pid and wrongly judge it stale.
acquire_lock() {
  local tmp="$DATA_DIR/.fetch-models.lock.$$.tmp"
  echo $$ > "$tmp" || return 1
  ln "$tmp" "$LOCK" 2>/dev/null
  local rc=$?
  rm -f "$tmp"
  return $rc
}

# A lock left by a process that no longer exists is taken over.
if ! acquire_lock; then
  holder=$(cat "$LOCK" 2>/dev/null)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    log "another fetch (pid $holder) is already running"
    exit 0
  fi
  rm -f "$LOCK"
  acquire_lock || { log "lost the lock race"; exit 0; }
fi
trap 'rm -f "$LOCK"' EXIT

# True when $1 has size $2 and hash $3 (trusting a matching .sha256 marker).
verified() {
  local target="$1" size="$2" sha="$3"
  [ -f "$target" ] && [ "$(size_of "$target")" = "$size" ] || return 1
  [ "$(cat "$target.sha256" 2>/dev/null)" = "$sha" ] && return 0
  [ "$(sha256_of "$target")" = "$sha" ] || return 1
  printf '%s' "$sha" > "$target.sha256"
}

fetch_one() {
  local name="$1" url="$2" size="$3" sha="$4"
  local target="$DATA_DIR/$name" part="$DATA_DIR/$name.part"
  verified "$target" "$size" "$sha" && return 0
  log "downloading $name ($size bytes)"
  [ -f "$part" ] && [ "$(size_of "$part")" -gt "$size" ] && rm -f "$part"
  if [ "$(size_of "$part")" != "$size" ]; then
    curl -fsSL --retry 3 -C - -o "$part" "$url"
    rc=$?
    # 33: the server ignores byte ranges -- start the file over.
    if [ "$rc" = 33 ]; then
      rm -f "$part"
      curl -fsSL --retry 3 -o "$part" "$url"
      rc=$?
    fi
    [ "$rc" = 0 ] || { log "download of $name failed (curl exit $rc)"; return 1; }
  fi
  if [ "$(sha256_of "$part")" != "$sha" ]; then
    rm -f "$part"
    log "checksum mismatch for $name; the download was discarded"
    return 1
  fi
  mv -f "$part" "$target" && printf '%s' "$sha" > "$target.sha256"
  log "verified $name"
}

status=0
while IFS=$'\t' read -r name url size sha; do
  [ -n "$name" ] || continue
  fetch_one "$name" "$url" "$size" "$sha" || status=1
done < <(jq -r '.files[] | [.name, .url, (.size | tostring), .sha256] | @tsv' "$MANIFEST")
exit $status
