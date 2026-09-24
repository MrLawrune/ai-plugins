#!/bin/bash
# Kokoro TTS -- Stop hook. Sends the turn's final text to the server's
# /turn router; block parsing, mode ceiling, and fallback live server-side.

LOG="/tmp/kokoro-hook.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tts-config.sh
source "$SCRIPT_DIR/tts-config.sh"
# shellcheck source=tts-guard.sh
source "$SCRIPT_DIR/tts-guard.sh"

if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -c 524288 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

input=$(cat)
if ! echo "$input" | jq -e . >/dev/null 2>&1; then
  echo "[$(date)] Invalid JSON input, exiting" >> "$LOG"
  exit 0
fi

session_id=$(echo "$input" | jq -r '.session_id // "default"')
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty')
transcript_path="${transcript_path/#\~/$HOME}"
last_message=$(echo "$input" | jq -r '.last_assistant_message // empty')

if [ "$KOKORO_SERVER_UP" != "1" ]; then
  echo "[$(date)] ERROR: Kokoro server not responding" >> "$LOG"
  jq -n --arg msg "Kokoro TTS server not responding on port $PORT. In bb, open the Kokoro TTS page; otherwise it starts on your next Claude Code session (see the kokoro-tts skill, Troubleshooting)" \
    '{systemMessage: $msg}'
  exit 0
fi
# Legacy flag-file mute (hotkeys) is local to this machine; honor it here.
[ "$MUTED" = "true" ] && exit 0

if [ -n "$last_message" ]; then
  body=$(jq -n --arg t "$last_message" '{text: $t}')
else
  parsed=$(python3 "$SCRIPT_DIR/parse_transcript.py" "$transcript_path" 2>>"$LOG")
  kind=$(echo "$parsed" | jq -r '.kind // "empty"')
  if [ "$kind" = "intermediate" ]; then
    curl -s -X POST "$SERVER/cue" --max-time 2 -H "Content-Type: application/json" \
      -d "$(jq -n --arg id "$session_id" '{sound: "working", session_id: $id, playback: "server"}')" >/dev/null 2>&1
    exit 0
  fi
  [ "$kind" = "final" ] || exit 0
  body=$(echo "$parsed" | jq '{text: .text, final_text: .final_text}')
fi

req=$(echo "$body" | jq -c \
  --arg id "$session_id" --arg mode "${KOKORO_MODE:-}" --arg voice "${KOKORO_VOICE:-}" \
  --arg speed "${KOKORO_SPEED:-}" --arg lang "${KOKORO_LANG:-}" \
  '. + {session_id: $id, playback: "server", source: "claude-code"}
   + (if $mode  != "" then {mode: $mode} else {} end)
   + (if $voice != "" then {voice: $voice} else {} end)
   + (if $speed != "" then {speed: ($speed | tonumber)} else {} end)
   + (if $lang  != "" then {lang: $lang} else {} end)')
resp=$(curl -s -X POST "$SERVER/turn" --max-time 5 -H "Content-Type: application/json" -d "$req" 2>&1)
echo "[$(date)] /turn -> $resp" >> "$LOG"
exit 0
