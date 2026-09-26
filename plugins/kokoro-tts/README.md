# kokoro-tts

A BB plugin (`bb/`) and a companion Claude Code plugin (`skills/`, `hooks/`)
built around a persistent local Kokoro TTS server (`server/`). The Python
server owns the config file, validation, and playback; the BB plugin is a
typed RPC proxy plus a "Kokoro TTS" sidebar page and plugin settings. See `PLUGIN_OVERVIEW.md`
for the end-user pitch.

## Settings

The Kokoro TTS sidebar page holds:

- Listening: mode, speed, and volume.
- Voice: a single voice or a weighted blend, with a sample button.
- Sounds: cue volume, working tick, attention ping, test buttons.
- Where it plays: this browser or the server host; open bb windows grouped
  by device, with Play on set to the last-used window, a pinned device, or
  every window; rename this device; pause other media while speech plays
  here (on the computer running bb, on Linux with playerctl).

Its header shows the server status with Stop and Mute buttons.

Server, runtime, synthesis engine, tuning, and diagnostics live under
Settings > Plugins > Kokoro TTS and work while the server is down: setup
state (model download, uv install), the Manage server toggle, the Runtime
pick (CPU or GPU), and the synthesis engine (local or a remote node).

Changes PATCH `/config` immediately and apply on the next spoken turn.

## Chat chips

A content script replaces raw `TTS_RESPONSE` blocks in BB chat with a small chip
showing the spoken sentence (or the sound name). The icon reflects what the
server's speech log says happened to that block:

| Icon | State |
|------|-------|
| Speaking head, accent color | Spoken. Hover shows time to first audio |
| Speaking head, pulsing | Speaking now |
| Speaking head, dimmed | Waiting for the Stop hook, or a message older than the log |
| Stop circle, amber | Interrupted |
| X circle, red | Not spoken within 25 s, or playback error |
| Speaker | Sound cue |
| Muted speaker | Silent turn, or muted when sent |

The speech log lives at `~/.local/state/kokoro-tts/speech-log.jsonl` and is served
by `GET /speech-log`. Chips match log entries by normalized spoken text.

## Layout

- `bb/` -- BB plugin: backend (`server.ts` composes `supervisor.ts`, `voice.ts`, `hub.ts`, `rpc.ts`), sidebar page, plugin settings, player and chip content scripts (`player/`, `chips/`).
- `server/` -- Python Kokoro server (`uv` project; `models.json` pins model files).
- `hooks/` -- Claude Code hooks; `skills/` -- shared skill; `.claude-plugin/` -- Claude Code manifest.

## Claude Code without bb

The hooks run the server themselves. SessionStart starts it with `uv run`
from the plugin (or starts a `kokoro-tts-server.service` user unit, if one
is installed). On a clean machine it first fetches the model files listed
in `server/models.json` in the background (`hooks/scripts/tts-fetch-models.sh`:
resumable, checksum-verified, into `~/.local/share/kokoro-tts`) and tells the
user speech starts on a later session; without `uv` it prints the install
command instead.

Hook diagnostics go to `~/.local/state/kokoro-tts/hook.log`
(`KOKORO_HOOK_LOG` overrides the path). Inside a bb thread with the bb plugin
loaded, the hooks do nothing and bb runs the server. The "server not
responding" notice appears once per session and never inside bb.

## Remote node

A headless node (`KOKORO_HOST=0.0.0.0`) can serve speech to other machines.
Nodes and clients negotiate terminated frames with `X-Kokoro-Frames: 2`;
older nodes keep working. `/health` lists `started_by`, naming the launcher
that started the server.

## Server security

The server has no authentication and trusts only local, non-browser
clients: it refuses (403) any request carrying an `Origin` header, and,
when bound to loopback, any `Host` header other than `127.0.0.1`,
`localhost`, or `[::1]` (DNS rebinding). `KOKORO_HOST=0.0.0.0` (a headless
remote node) exposes it to every host that can reach the port -- anyone
there can make it speak, read the speech log, and change its config. Only
bind beyond loopback on a trusted network, and firewall the port.
Behind a reverse proxy, the loopback Host check applies to the request the
server receives: set the upstream `Host` (Caddy: `header_up Host
{upstream_hostport}`), or bind the server to a non-loopback address instead.

## Develop

    npm install && npm test && npx tsc --noEmit
    UV_PROJECT_ENVIRONMENT=$(mktemp -d) uv run --frozen --project server --with pytest pytest tests -q
    bb plugin install path:$PWD --yes    # then: bb plugin dev .

Keep the scratch `UV_PROJECT_ENVIRONMENT`: a plain `uv run --project server`
syncs the `cpu` group into `server/.venv`, overwriting a GPU runtime there.

## Release

    scripts/release.sh 0.1.1
