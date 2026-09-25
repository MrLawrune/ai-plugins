#!/bin/bash
# SessionStart: ensure the Kokoro server is up, then inject the voice
# contract as additionalContext so it only loads when the plugin is enabled.
# On a clean machine this fetches the voice model in the background first;
# the server starts on a later session once the model is in place.

PORT="${KOKORO_PORT:-6789}"
SERVER="http://127.0.0.1:$PORT"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(dirname "$SCRIPT_DIR")")}"
CONTRACT="$SCRIPT_DIR/../context/tts-contract.md"
CONTRACT_FULL="$SCRIPT_DIR/../context/tts-contract-full.md"
MANIFEST="${KOKORO_MODELS_MANIFEST:-$PLUGIN_DIR/server/models.json}"
DATA_DIR="${KOKORO_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/kokoro-tts}"
UV_INSTALL_COMMAND="curl -LsSf https://astral.sh/uv/install.sh | sh"
LOG="/tmp/kokoro-hook.log"

# Prints the hook output: the voice contract, plus an optional user-facing
# systemMessage ($1).
emit_context() {
  local msg="${1:-}"
  if [ -f "$CONTRACT" ]; then
    # shellcheck source=tts-config.sh
    source "$SCRIPT_DIR/tts-config.sh"
    # Full mode reads the whole reply and ignores blocks: a short contract
    # that tells the agent not to spend tokens on them.
    local contract="$CONTRACT"
    [ "$MODE" = "full" ] && [ -f "$CONTRACT_FULL" ] && contract="$CONTRACT_FULL"
    sed "s/{{MODE}}/$MODE/g" "$contract" | jq -Rs --arg msg "$msg" \
      '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: .}}
       + (if $msg != "" then {systemMessage: $msg} else {} end)'
  else
    echo "[$(date)] WARNING: contract file missing: $CONTRACT" >> "$LOG"
    [ -n "$msg" ] && jq -n --arg msg "$msg" '{systemMessage: $msg}'
  fi
}

# uv from PATH, else the installer's default locations.
find_uv() {
  if [ -n "${KOKORO_UV:-}" ]; then
    [ -x "$KOKORO_UV" ] && echo "$KOKORO_UV"
    return
  fi
  command -v uv 2>/dev/null && return
  for c in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
}

# True when every manifest file is in the data dir at its expected size
# (tts-fetch-models.sh verifies checksums when it downloads).
models_present() {
  local name size f
  while IFS=$'\t' read -r name size; do
    [ -n "$name" ] || continue
    f="$DATA_DIR/$name"
    [ -f "$f" ] && [ "$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null)" = "$size" ] || return 1
  done < <(jq -r '.files[] | [.name, (.size | tostring)] | @tsv' "$MANIFEST" 2>/dev/null)
  return 0
}

model_file() { jq -r --arg ext "$1" '.files[] | select(.name | endswith($ext)) | .name' "$MANIFEST" 2>/dev/null | head -n1; }

if curl -sf --max-time 1 "$SERVER/health" >/dev/null 2>&1; then
  echo "[$(date)] Kokoro server already running" >> "$LOG"
  # shellcheck source=tts-guard.sh
  source "$SCRIPT_DIR/tts-guard.sh"
  emit_context
  exit 0
fi

echo "[$(date)] Kokoro server not running, starting..." >> "$LOG"

server_pid=""
# An installed systemd user unit (optional; see the skill's Troubleshooting)
# is the single canonical instance. Otherwise run the server from the plugin.
if systemctl --user list-unit-files kokoro-tts-server.service --no-legend 2>/dev/null | grep -q kokoro; then
  systemctl --user start kokoro-tts-server.service >> "$LOG" 2>&1
  echo "[$(date)] Started via systemd unit" >> "$LOG"
else
  # The model fetch only needs curl + sha256sum/shasum + jq, not uv, so kick it
  # off regardless of whether uv is installed: on a clean machine that's missing
  # both, the download runs while the user installs uv, and the server can start
  # as soon as the *next* session sees both ready -- two sessions, not three.
  fetch_started=0
  if ! models_present; then
    nohup bash "$SCRIPT_DIR/tts-fetch-models.sh" >> "$LOG" 2>&1 &
    echo "[$(date)] Model files missing; fetching in the background (PID $!)" >> "$LOG"
    fetch_started=1
  fi

  UV="$(find_uv)"
  if [ -z "$UV" ]; then
    echo "[$(date)] uv not found; not starting the server" >> "$LOG"
    msg="Kokoro TTS needs uv to run its server. Install it with: $UV_INSTALL_COMMAND -- then start a new session."
    if [ "$fetch_started" = 1 ]; then
      msg="Downloading the Kokoro voice model (about 355 MB) in the background. $msg"
    fi
    emit_context "$msg"
    exit 0
  fi
  if [ "$fetch_started" = 1 ]; then
    emit_context "Downloading the Kokoro voice model (about 355 MB) in the background; speech starts on a later session once it finishes."
    exit 0
  fi
  KOKORO_MODEL="${KOKORO_MODEL:-$DATA_DIR/$(model_file .onnx)}" \
  KOKORO_VOICES="${KOKORO_VOICES:-$DATA_DIR/$(model_file .bin)}" \
    nohup "$UV" run --project "$PLUGIN_DIR/server" python "$PLUGIN_DIR/server/kokoro_server.py" >> "$LOG" 2>&1 &
  server_pid=$!
  echo "[$(date)] Started via nohup (PID $server_pid)" >> "$LOG"
fi

for i in $(seq 1 15); do
  if curl -sf "$SERVER/health" >/dev/null 2>&1; then
    echo "[$(date)] Server healthy after ${i}s" >> "$LOG"
    # shellcheck source=tts-guard.sh
    source "$SCRIPT_DIR/tts-guard.sh"
    emit_context
    exit 0
  fi
  if [ -n "$server_pid" ] && ! kill -0 "$server_pid" 2>/dev/null; then
    echo "[$(date)] WARNING: server process exited during startup (see above)" >> "$LOG"
    break
  fi
  sleep 1
done

echo "[$(date)] WARNING: server not healthy within 15s" >> "$LOG"
emit_context
exit 0
