#!/bin/bash
# Interrupt all active TTS playback. Bind to a global hotkey.
curl -sf -X POST "http://127.0.0.1:${KOKORO_PORT:-6789}/interrupt-all" >/dev/null 2>&1
