# Kokoro TTS pipeline reference

How a finished reply becomes audio, and the server underneath it. Read this
for questions about routing, queueing, playback devices, the server's HTTP
API, a remote synthesis node, or where data lives.

## Routing

- The server's `POST /turn` parses the directive, applies the mode ceiling,
  and falls back to the first sentence. `POST /cue` gates the attention
  ping. Both take a per-request `mode` that overrides the configured one
  for that request; the plugin sends it only when a thread or project
  override chose the mode.
- The plugin voices root threads, and child threads when enabled, on turn
  end. Sending a message stops speech. It pings on permission prompts and
  questions, and injects the voice contract as agent instructions for any
  agent provider (none for a thread whose voice is Off).
- Repeats: the server stays silent when a thread reports the same reply
  again (stopping a thread re-reports its last reply).

## Playback

- Play audio: in a bb window (default) or on the server host's speakers.
  A host with no audio device offers only the bb window.
- Route picks the window: the one used last (a click or keypress marks a
  window as used), a pinned device, or every open window.
- Replies play one at a time. A reply from another thread waits, already
  synthesized, until the current one ends; a newer reply in the same thread
  replaces its queued one.
- If the window holding the output drops off (last-used or pinned; a phone
  losing signal or freezing), its replies are synthesized and held for up
  to 15 minutes and play when it reconnects. A reply cut off mid-way
  replays from the start. Using another device under last-used takes the
  output and the held replies.
- The server pings every window every 25 s, since a hidden page's own
  timers are throttled. A phone browser can't play with the screen locked
  for long: Chrome freezes the page, so held replies play when it reopens.
- "Pause other media while speech plays here" (keep or pause) shows only in
  a bb window on the computer running bb, when the server supports it
  (Linux with playerctl). It applies while speech plays in such a window or
  on that computer's speakers; replies to other devices never touch it.
  Only players that were playing get paused, and only those resume.

## Server

- The plugin installs and runs it (uv, verified model download to the data
  dir, CPU or GPU runtime, audio probe) unless a server already answers at
  the configured URL, in which case it is reported as external and the
  plugin does not restart it.
- Data dir: `~/.local/share/kokoro-tts` (models, `venv-cpu`, `venv-gpu`).
  Config: `~/.config/kokoro-tts/config.json`. Speech log:
  `~/.local/state/kokoro-tts/speech-log.jsonl`.
- Global settings can also be changed with `PATCH /config`.

## Endpoints

`/turn`, `/cue`, `/play-sound`, `/preview`, `/replay`, `/interrupt`,
`/interrupt-all`, `/cleanup`, `/mute` (`{"muted": bool}`), `/config`,
`/voices`, `/devices`, `/engine`, `/synthesize`, `/speech-log`
(`?session_id=` for one thread), `/speech-log/status`, `/other-audio`,
`/health` (version, engine, muted, latency, `started_by`).

`/turn`, `/cue`, `/play-sound`, `/replay`, `/interrupt`, and `/cleanup`
require a `session_id` (the bb thread id).

## Remote synthesis node

`KOKORO_HEADLESS=1 KOKORO_HOST=0.0.0.0` serves `/synthesize` only; point
another server at it with the remote engine (Server and engine settings,
provider `remote`).

Warning: the server has no authentication. Binding beyond loopback lets
anyone who can reach the port speak through it, read the speech log, and
change its config. Only do this on a trusted network, preferably bound to
one private address with the port firewalled to the hosts that need it.

## Request guard

The server refuses (403) any request with an `Origin` header, and, when
bound to loopback, any `Host` other than `127.0.0.1`, `localhost`, or
`[::1]`, so web pages can't drive it. Behind a reverse proxy, set the
upstream `Host` (Caddy: `header_up Host {upstream_hostport}`), or bind to a
non-loopback address instead.
