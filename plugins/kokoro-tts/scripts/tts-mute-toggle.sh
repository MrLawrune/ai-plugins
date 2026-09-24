#!/bin/bash
# Toggle Kokoro TTS mute state on the server. Bind to a global hotkey.
# Muting also interrupts any active playback.

PORT="${KOKORO_PORT:-6789}"
resp=$(curl -sf -X POST "http://127.0.0.1:$PORT/mute" -H "Content-Type: application/json" -d '{}' 2>/dev/null)
if [ -z "$resp" ]; then
  notify-send -t 1500 -u low "Kokoro TTS" "Server not running"
  exit 1
fi
if [ "$(echo "$resp" | jq -r .muted)" = "true" ]; then
  notify-send -t 1500 -u low "Kokoro TTS" "Muted"
else
  notify-send -t 1500 -u low "Kokoro TTS" "Unmuted"
fi
