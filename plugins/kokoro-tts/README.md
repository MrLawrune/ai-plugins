# kokoro-tts

A BB plugin (`bb/`) that voices every root thread the same way, whichever
agent provider runs it. The plugin decides what to say and when: it reads
each finished turn, applies the thread's voice mode, keeps the speech log,
and streams audio to a BB window. Audio always plays in a BB window. A
Kokoro TTS server (`server/`) only synthesizes: the plugin sends it one
chunk of text at a time and gets audio back. See `PLUGIN_OVERVIEW.md` for
the end-user pitch.

## Settings

The Kokoro TTS sidebar page holds:

- Listening: mode, speed, and volume.
- Voice: a single voice or a weighted blend, with a sample button.
- Sounds: cue volume, working tick, attention ping, test buttons.
- History: how long the speech log keeps entries (1-90 days, default 7) and
  how many it keeps (100-10000, default 1000), and Clear history, which
  deletes every entry. The log keeps what was said, never audio.
- Where it plays: open bb windows grouped by device, with Route set to the
  last-used window, a pinned device, or every window; rename this device;
  pause other media while speech plays here (on the computer running bb, on
  Linux with playerctl).

Its header shows the engine status with Stop and Mute buttons.

Engines, setup, runtime, tuning, and diagnostics live under Settings >
Plugins > Kokoro TTS and work while every engine is down: setup state
(model download, uv install), the Manage server toggle, the main and backup
engines, and the Runtime pick (CPU or GPU) with its tuning for the local
server.

Settings are stored by the plugin and apply on the next spoken turn.
Runtime and tuning changes go to the local server's `/config`.

## Engines

The main engine synthesizes every reply. It is either "This computer
(managed)", the Kokoro server the plugin runs on the computer running bb,
or "Another server" at a URL. An optional backup engine, set the same way,
takes over when the main one fails before the reply's first audio:

- Unreachable main engine (connection refused, HTTP 5xx, or no first audio
  in time): the reply goes to the backup, and the main engine is skipped
  for 30 s before one reply tries it again. An engine gets 8 s to start
  speaking, or 30 s when it may be loading its model: its health said the
  model is not loaded, or it has not spoken in the last 10 minutes (a GPU
  engine unloads when idle) and its last attempt did not go unanswered.
- Main engine refuses the request (HTTP 4xx, such as an unknown voice): the
  reply goes to the backup, and the main engine stays in use.
- No engine could speak the reply (no backup, or the backup failed too):
  the reply ends with an error cue and its log entry gives the reason
  (`unreachable ...` when no engine answered). The cue follows the reply's
  own mode, as set for its thread or project or globally, so it is silent
  in quiet mode, and while muted. A reply that fails after some of it
  played, and a replay, get no cue.

Once a reply has played audio it stays on that engine. A reply speaks at
most 6000 characters (cut at a sentence or line end) and at most about 11
minutes of audio; past that it stops and is logged `reply too long`. Both engines use the
voice settings. The settings page shows each engine's reachability and
whether the main engine is being skipped.

The thread header's Voice control sets a mode, or Off, for the thread and
for its project. A thread's own setting wins, then its nearest parent
thread's, then its project's, then the global mode. Child threads speak only
when an ancestor or the project has Child threads set to Voice, or when the
child has its own mode. Off means no speech, no sounds, and no voice
instructions. Mode changes reach an agent's instructions when its session
restarts; Off and the mode's limit apply to the next reply. These settings
live in the plugin's storage. A thread's settings go when the thread is
deleted.

## Chat card

Agents end a reply with a directive line:

    ::kokoro-tts{weight="speech" say="All tests pass."}

bb renders it as a card showing the spoken text and what the speech log says
happened to it: Queued (also shown by the thread's newest card while
its turn is being prepared), Playing, Spoken (with the voice and
time to first audio), Interrupted (also for an entry left queued or playing
for over 20 minutes), Muted (also when mute kept its turn from being
voiced), Voice off, Not spoken (the verbosity mode or a repeated reply kept
it quiet, or a turn logged its text but the log entry did not show up
within 25 s), Error, or No record (no log entry and no turn for this reply
since the card appeared, as for older messages). In a thread whose voice is
off, including sub-threads that are not voiced, the newest reply's card reads
Voice off.
Replay speaks the reply again in the window where replies play, logged under
the thread; Stop appears while it plays and stops that thread's speech only.
Sound weights show a one-line chip with the sound name; `silent` renders
nothing.

Without a directive the plugin speaks the reply's first sentence. HTML
comments are never spoken.

The speech log lives in the plugin's database. Each card fetches its own
thread's entries (the newest 50) and matches them by normalized spoken text.
Entries are pruned to the History limits, and a deleted thread's entries go
with it; an archived thread keeps them. Clear history empties the log and
every open card refreshes.

## Layout

- `bb/` -- BB plugin: backend (`server.ts` composes `supervisor.ts`, `voice.ts`, `hub.ts`, `rpc.ts`), the turn coordinator, settings, and speech log (`coord/`), the engine chain (`engines/`), sidebar page, plugin settings, the player content script (`player/`), and the chat card (`card/`).
- `server/` -- Python Kokoro server the plugin synthesizes with (`uv` project; `models.json` pins model files).
- `contract/` -- the voice contracts agents get as instructions (`tts-contract.md`, and `tts-contract-full.md` for full mode); `skills/` -- the kokoro-tts reference skill.

## Remote node

A headless server (`KOKORO_HEADLESS=1 KOKORO_HOST=0.0.0.0`) synthesizes for
bb on other machines: set it as their main or backup engine. The plugin
asks it for `/synthesize`, `/voices`, and `/health`, and negotiates
terminated frames with `X-Kokoro-Frames: 2`; servers without them keep
working. A server that would forward to another one refuses the plugin's
requests; point the engine at the synthesizing server directly. `/health`
lists `started_by`, naming the launcher that started the server.

## Server security

The server has no authentication and trusts only local, non-browser
clients: it refuses (403) any request carrying an `Origin` header, and,
when bound to loopback, any `Host` header other than `127.0.0.1`,
`localhost`, or `[::1]` (DNS rebinding). `KOKORO_HOST=0.0.0.0` (a headless
remote node) exposes it to every host that can reach the port -- anyone
there can make it synthesize and change its config. Only
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

## Uninstalling

`bb plugin remove kokoro-tts` deletes the plugin's BB settings, secrets,
and schedules, and the plugin files for a git or npm install. It keeps:

- the plugin's data directory, `~/.bb/plugins/kokoro-tts/` (the speech log
  in `data.db`, and logs);
- the plugin's stored rows in bb's database (voice settings, mute, device
  preferences, per-thread and per-project voice settings), which a later
  install picks up again;
- `~/.local/share/kokoro-tts` (models and runtimes, a few hundred MB, or
  about 3 GB with the GPU runtime);
- `~/.config/kokoro-tts/config.json` (the local server's config);
- `~/.local/state/kokoro-tts/speech-log.jsonl` (the local server's log).

Stop the local server (or bb) first, then delete what you don't need:

    rm -rf ~/.local/share/kokoro-tts
    rm -rf ~/.config/kokoro-tts
    rm -rf ~/.local/state/kokoro-tts
    rm -rf ~/.bb/plugins/kokoro-tts

With bb stopped, delete the stored rows:

    sqlite3 ~/.bb/bb.db "DELETE FROM plugin_kv WHERE plugin_id = 'kokoro-tts'"

