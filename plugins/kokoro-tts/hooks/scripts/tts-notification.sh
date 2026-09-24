#!/bin/bash
# Plays the attention ping on Claude Code Notification events
# (permission prompts, idle waiting). No model involvement, no tokens.

LOG="/tmp/kokoro-hook.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tts-config.sh
source "$SCRIPT_DIR/tts-config.sh"
# shellcheck source=tts-guard.sh
source "$SCRIPT_DIR/tts-guard.sh"
[ "$MUTED" = "true" ] && exit 0

input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // "default"' 2>/dev/null)
[ -z "$session_id" ] && session_id="default"

curl -s --max-time 2 -X POST "$SERVER/cue" -H "Content-Type: application/json" \
  -d "$(jq -nc --arg s "$session_id" '{sound: "attention", session_id: $s, playback: "server"}')" \
  >/dev/null 2>&1
echo "[$(date)] Notification cue for session $session_id" >> "$LOG"
exit 0
