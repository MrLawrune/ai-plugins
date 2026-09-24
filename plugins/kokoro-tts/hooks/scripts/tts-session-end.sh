#!/bin/bash
# Cleanup TTS session tracking on session end

PORT="${KOKORO_PORT:-6789}"
SERVER="http://127.0.0.1:$PORT"
LOG="/tmp/kokoro-hook.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tts-guard.sh
source "$SCRIPT_DIR/tts-guard.sh"

input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // "default"' 2>/dev/null)
[ -z "$session_id" ] && session_id="default"
reason=$(echo "$input" | jq -r '.reason // "unknown"' 2>/dev/null)

echo "[$(date)] SessionEnd: $session_id (reason: $reason)" >> "$LOG"

curl -s --max-time 2 -X POST "$SERVER/cleanup" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg s "$session_id" '{session_id:$s}')" \
  >> "$LOG" 2>&1

exit 0
