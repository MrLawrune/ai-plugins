#!/bin/bash
# Source from a hook. Exits the hook when this Claude Code session runs
# inside a BB thread and the kokoro-tts BB plugin is voicing it (its
# heartbeat on the server is fresh). Prevents every turn being spoken twice.

_kk_server="${SERVER:-http://127.0.0.1:${KOKORO_PORT:-6789}}"
if [ -n "$BB_THREAD_ID" ] \
  && curl -sf --max-time 1 "$_kk_server/health" 2>/dev/null | jq -e '.bb_plugin_active == true' >/dev/null 2>&1; then
  exit 0
fi
unset _kk_server
