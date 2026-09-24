#!/bin/bash
# Stops ongoing TTS playback when the user submits a new prompt

PORT="${KOKORO_PORT:-6789}"
SERVER="http://127.0.0.1:$PORT"
LOG="/tmp/kokoro-hook.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tts-guard.sh
source "$SCRIPT_DIR/tts-guard.sh"

input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // "default"' 2>/dev/null)
[ -z "$session_id" ] && session_id="default"

curl -s --max-time 2 -X POST "$SERVER/interrupt" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg s "$session_id" '{session_id:$s}')" \
  >> "$LOG" 2>&1
echo "[$(date)] Sent interrupt for session $session_id" >> "$LOG"

exit 0
