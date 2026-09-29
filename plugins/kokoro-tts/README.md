# kokoro-tts

A BB plugin (`bb/`) built around a persistent local Kokoro TTS server
(`server/`). It voices every root thread the same way, whichever agent
provider runs it. The Python
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

## Chat card

Agents end a reply with a directive line:

    ::kokoro-tts{weight="speech" say="All tests pass."}

bb renders it as a card showing the spoken text and what the server's speech
log says happened to it: Queued (also shown by the thread's newest card while
its turn is on its way to the server), Playing, Spoken (with the voice and
time to first audio), Interrupted (also for an entry left queued or playing
for over 20 minutes), Muted, Not spoken (a turn logged the card's text but
its log entry did not show up within 25 s), Error, or No record (no log entry
and no turn for this reply since the card appeared, as for older messages
and sub-thread replies, which are not voiced). Replay speaks the reply again
through `POST /replay`, in the window where replies play and logged under the
thread; Stop appears while it plays and stops that thread's speech only.
Sound weights show a one-line chip with the sound name; `silent` renders
nothing.

Without a directive the server speaks the reply's first sentence. HTML
comments are never spoken.

The speech log lives at `~/.local/state/kokoro-tts/speech-log.jsonl` and is served
by `GET /speech-log` (`?session_id=` for one thread; cards fetch their own
thread's). Cards match log entries by thread and normalized spoken text.

## Server traffic

The plugin keeps the server's config and mute state cached: it updates from
every settings change made in bb and refreshes once a minute, retrying from
5 s up to 60 s while the server is unreachable. The agent instructions'
verbosity mode, preview and cue volumes, and the attention ping in browser
playback read the cache instead of asking the server.

## Layout

- `bb/` -- BB plugin: backend (`server.ts` composes `supervisor.ts`, `voice.ts`, `hub.ts`, `rpc.ts`), sidebar page, plugin settings, the player content script (`player/`), and the chat card (`card/`).
- `server/` -- Python Kokoro server (`uv` project; `models.json` pins model files).
- `contract/` -- the voice contracts agents get as instructions (`tts-contract.md`, and `tts-contract-full.md` for full mode); `skills/` -- the kokoro-tts reference skill.

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
