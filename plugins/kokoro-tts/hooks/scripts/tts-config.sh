#!/bin/bash
# Shared config loader for Kokoro hooks. Source this file.
# Reads GET /config from the server; env vars KOKORO_* override when set.
# Sets: PORT SERVER KOKORO_SERVER_UP VOICE_JSON SPEED MODE LANG_CODE
#       WORKING_SOUND ATTENTION_SOUND MUTED
# Requires: curl, jq. Never fails the caller; falls back to defaults.

PORT="${KOKORO_PORT:-6789}"
SERVER="http://127.0.0.1:$PORT"

_kk_cfg=$(curl -sf --max-time 1 "$SERVER/config" 2>/dev/null)
if [ -n "$_kk_cfg" ] && echo "$_kk_cfg" | jq -e '.config' >/dev/null 2>&1; then
  KOKORO_SERVER_UP=1
  VOICE_JSON=$(echo "$_kk_cfg" | jq -c '.config.voice')
  SPEED=$(echo "$_kk_cfg" | jq -r '.config.speed')
  MODE=$(echo "$_kk_cfg" | jq -r '.config.mode')
  LANG_CODE=$(echo "$_kk_cfg" | jq -r '.config.lang')
  WORKING_SOUND=$(echo "$_kk_cfg" | jq -r '.config.working_sound')
  ATTENTION_SOUND=$(echo "$_kk_cfg" | jq -r '.config.attention_sound')
  MUTED=$(echo "$_kk_cfg" | jq -r '.muted')
else
  KOKORO_SERVER_UP=0
  VOICE_JSON='"af_sky"'
  SPEED=1.0
  MODE=brief
  LANG_CODE=en-us
  WORKING_SOUND=true
  ATTENTION_SOUND=true
  MUTED=false
fi

# Env overrides (legacy + per-session control)
[ -n "$KOKORO_VOICE" ] && VOICE_JSON=$(jq -cn --arg v "$KOKORO_VOICE" '$v')
[ -n "$KOKORO_SPEED" ] && SPEED="$KOKORO_SPEED"
[ -n "$KOKORO_MODE" ] && MODE="$KOKORO_MODE"
[ -n "$KOKORO_LANG" ] && LANG_CODE="$KOKORO_LANG"

# Legacy flag file still mutes (hotkeys from older setups)
[ -f "${XDG_RUNTIME_DIR:-/tmp}/kokoro-muted" ] && MUTED=true
unset _kk_cfg
