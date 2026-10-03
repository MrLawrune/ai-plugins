# Kokoro TTS pipeline reference

How a finished reply becomes audio, and the engines underneath it. Read
this for questions about routing, queueing, playback devices, the engines
and failover, a remote synthesis node, or where data lives.

## Routing

- The plugin handles each thread's turns one at a time. When a turn ends it
  parses the directive, applies the mode ceiling, and falls back to the
  first sentence. It gates the attention ping the same way. A thread or
  project override chooses the mode for that thread.
- The plugin voices root threads, and child threads when enabled, on turn
  end. Sending a message stops speech. It pings on permission prompts and
  questions, and injects the voice contract as agent instructions for any
  agent provider (none for a thread whose voice is Off).
- Mute comes first: a muted turn is not logged and is not remembered as a
  repeat.
- Repeats: the plugin stays silent when a thread reports the same reply
  again (stopping a thread re-reports its last reply).
- A reply with nothing left to say after markup is stripped plays the done
  cue instead.

## Playback

- Audio always plays in a bb window.
- Route picks the window: the one used last (a click or keypress marks a
  window as used), a pinned device, or every open window.
- Replies play one at a time. A reply from another thread waits until the
  current one ends; a newer reply in the same thread replaces its queued
  one. At most 16 replies wait; beyond that the oldest is dropped and logged
  as interrupted.
- A reply is synthesized when it starts playing, not while it waits.
- If the window holding the output drops off (last-used or pinned; a phone
  losing signal or freezing), its replies are held for up to 15 minutes and
  play when it reconnects. A reply cut off mid-way replays from the start.
  Using another device under last-used takes the output and the held
  replies.
- The plugin pings every window every 25 s, since a hidden page's own
  timers are throttled. A phone browser can't play with the screen locked
  for long: Chrome freezes the page, so held replies play when it reopens.
- "Pause other media while speech plays here" (keep or pause) shows only in
  a bb window on the computer running bb, on Linux with playerctl. It
  applies while speech plays in such a window; replies to other devices
  never touch it. Only players that were playing get paused, and only those
  resume.

## Engines

- Settings > Plugins > Kokoro TTS sets a main engine and an optional backup.
  Each is this computer (the local Kokoro server) or "Another server" at a
  URL. Both use the voice settings.
- The plugin sends each reply to an engine one sentence group at a time and
  adds the lead-in silence and the sentence gap itself.
- Failover happens only before a reply's first audio. Unreachable (refused
  connection, HTTP 5xx, or no first audio in time): the backup takes the
  reply, and the main engine is skipped for 30 s before one reply tries it
  again. An engine gets 8 s to start speaking, or 30 s when it may be
  loading its model (its health said not loaded, or it has not spoken in
  10 minutes, or in its shorter idle-unload time from its health, and its
  last attempt was answered).
  A refused request (HTTP 4xx, such as an unknown voice): the backup takes
  that reply; the main engine stays in use.
- A local backup behind a remote main engine is cold: its server is stopped
  (Standby on the settings page) while the main server works. The first
  reply that fails over starts it and waits up to 30 s for it to answer, so
  the first fallback is heard after about the main engine's timeout plus
  the start; replies failing over meanwhile share that start, and a fresh
  server gets the 8 s budget (it loads its model before it answers). A
  start that fails or takes longer fails that reply as unreachable. While
  it runs, the main server's health is checked every minute: once it
  answers, replies return to it, and the local server stops after 10
  minutes without a backup reply, never mid-reply.
- No engine could speak the reply (no backup, or the backup failed too):
  an error cue plays and the log entry gives the reason (`unreachable ...`
  when no engine answered). The cue uses the reply's own mode (thread,
  project, or global), so quiet mode and mute silence it. A failure after
  some audio played, and a replay, play no cue.
- A reply speaks at most 6000 characters, cut at a sentence or line end,
  and at most 64 MiB of audio (about 11 minutes); past that it stops and
  is logged `reply too long`.
- An engine that would forward to another server is refused; point it at
  the synthesizing server directly.

## Local server

- The plugin installs and runs it (uv, verified model download to the data
  dir, CPU or GPU runtime) unless a server already answers at the
  configured URL, in which case it is reported as external and the plugin
  does not restart it. As the main engine it runs always; as a cold backup
  only while the main server fails.
- The plugin uses its `/synthesize`, `/voices`, and `/health`, and its
  `/config` runtime fields (provider, CPU threads, GPU memory cap, idle
  unload), which the settings page shows only for the managed local engine.
- Data dir: `~/.local/share/kokoro-tts` (models, `venv-cpu`, `venv-gpu`).
  Server config: `~/.config/kokoro-tts/config.json`.

## Plugin data

- Voice settings, mute, and per-thread and per-project voice settings are
  stored by the plugin in bb.
- Speech log: the plugin's database, `~/.bb/plugins/kokoro-tts/data.db`.
  Each entry holds the spoken text (up to 2000 characters), status, voice,
  engine, and time to first audio; never audio. History settings bound it
  by age (1-90 days, default 7) and count (100-10000, default 1000). A
  deleted thread's entries are deleted; an archived thread keeps them.
  Clear history deletes them all.

## Remote synthesis node

`KOKORO_HEADLESS=1 KOKORO_HOST=0.0.0.0` serves synthesis to other machines;
set it as their main or backup engine with "Another server".

Warning: the server has no authentication. Binding beyond loopback lets
anyone who can reach the port synthesize through it and change its config.
Only do this on a trusted network, preferably bound to one private address
with the port firewalled to the hosts that need it.

## Request guard

The server refuses (403) any request with an `Origin` header, and, when
bound to loopback, any `Host` other than `127.0.0.1`, `localhost`, or
`[::1]`, so web pages can't drive it. Behind a reverse proxy, set the
upstream `Host` (Caddy: `header_up Host {upstream_hostport}`), or bind to a
non-loopback address instead.
