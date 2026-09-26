#!/bin/bash
# Source from a hook: LOG is a private per-user log (override: KOKORO_HOOK_LOG).
LOG="${KOKORO_HOOK_LOG:-${XDG_STATE_HOME:-$HOME/.local/state}/kokoro-tts/hook.log}"
mkdir -p "${LOG%/*}" 2>/dev/null
