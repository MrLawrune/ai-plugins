---
name: kokoro-tts
description: Deep reference for voice output in bb via Kokoro TTS -- the kokoro-tts directive, weight selection, verbosity modes, fallback behavior, and troubleshooting. The always-loaded contract comes with the agent instructions; consult this skill for details, examples, and debugging.
---

# Kokoro TTS -- Weighted Communication

## Two-Channel Communication

The user receives every response through two independent channels:

1. **Text (on screen)** -- Full technical detail. Write normally.
2. **Voice (spoken aloud)** -- The primary channel. The user is listening.

## The Directive Is an Override, Not a Mandate

If a reply ends with a kokoro-tts directive, the plugin obeys it. If not,
it speaks the FIRST SENTENCE of the reply as fallback. Nothing errors;
there is no penalty sound. Only a server that is down stops speech.

Consequences:
- On turns without a directive, write a speakable first sentence (plain
  English, no paths/code) -- it will be heard verbatim.
- Provide a directive when spoken content should differ from the opening
  sentence, or when you want a sound or silence instead of speech.

## Directive Format

The last line of the reply, on its own line after a blank line, never in a
code block:

    ::kokoro-tts{weight="speech" say="Spoken content here."}
    ::kokoro-tts{weight="sound:done"}
    ::kokoro-tts{weight="silent"}

Weights: `silent` | `sound:working` | `sound:done` | `sound:attention` | `speech`

The `say` value is one line in double quotes; write a double quote inside
it as `&quot;`. bb renders the directive as a card with the spoken text,
its status (Queued, Playing, Spoken, Interrupted, Muted, Not spoken, Error,
No record), Replay, and Stop while playing. HTML comments are never spoken.

## Weight Selection

- `speech` (default): reporting results, answering, asking, errors,
  plans, completions. When uncertain, speak.
- `silent`: mid-tool-loop with more calls queued and nothing to report.
- `sound:done`: a non-final step in a batch (you will speak at the end).
- `sound:working`: a soft tick; the Working tick switch can silence it.
- `sound:attention`: rarely needed -- the plugin pings on its own when an
  agent waits for a permission or an answer.

## Verbosity Modes

The mode is a ceiling the plugin enforces by downgrading weights. Speech
length limits are the model's responsibility.

| Mode | Ceiling | Speech limit |
|------|---------|-------------|
| `quiet` | silence only | n/a |
| `ambient` | sounds only | n/a |
| `brief` | speech | 1 sentence max **(default)** |
| `conversational` | speech | 2-4 sentences |
| `verbose` | speech | full detail |
| `full` | whole reply | none -- see below |

In `full` mode the server reads the reply itself, not a directive:
directives and weights are ignored, code blocks and tables are replaced with "Code block
skipped." / "Table skipped.", links read as their text, and paths and URLs
are dropped. Replies over about 6000 characters stop at a sentence end with
"The rest is on screen." Write the reply as speakable prose, and skip the
directive: in full mode the injected contract is a short version that says
so, to save tokens.

Mode switching mid-session ("go quiet", "go verbose"): acknowledge and
apply the new ceiling to your own weight/length choices for the rest of
the session. The server reads the mode on every turn; change it on the bb
Kokoro TTS page or with `PATCH /config`.

## Speech Content Rules

- ASCII only: plain hyphens, straight quotes, basic punctuation.
- No URLs, file paths, variable names, code syntax, or unicode symbols.
- Plain English ("the config file", not the path). Conversational tone.
- brief mode: 3-6 words for simple confirmations ("Done, tests pass.").

## Pipeline Reference

- **Routing**: the server's `POST /turn` parses the directive, applies the mode
  ceiling, and falls back to the first sentence (`server/kokoro_turn.py`).
  `POST /cue` gates the attention ping. Both take a per-request `mode` that
  overrides the configured one for that request.
- **In bb** (any agent provider): the plugin voices root threads on turn end,
  stops speech when you send a message, pings on permission prompts, and injects this
  contract as agent instructions. Audio plays in the bb window you used last
  (`playback=client`, default) or on the server host's speakers
  (`playback=server`). The Playback devices card picks the window: follow,
  pinned device, or all; a click or keypress marks a window as last used.
  Replies play one at a time: a reply from another thread waits (already
  synthesized) until the current one ends, and a newer reply in the same
  thread replaces its queued one. If the window holding the output drops
  off (follow or pinned; a phone losing signal or freezing), its replies are
  synthesized and held for up to 15 minutes and play when it reconnects (a
  reply cut off mid-way replays from the start); using another device under
  follow takes the output and the held replies. The server pings every
  window every 25 s, since a hidden page's own timers are throttled. A phone
  browser can't play with the screen locked for long: Chrome freezes the
  page, so held replies play when you open it again.
  "Pause other media while speech plays here" (`other_audio`: keep or
  pause) shows only in a bb window on the computer running bb (its browser
  address is one of that computer's) when the server supports it (Linux with
  playerctl). It applies while speech plays in such a window or on that
  computer's speakers; replies to other devices never touch it. Only players
  that were playing get paused, and only those resume.
- **Repeats**: the server stays silent when a thread reports the same
  reply again (stopping a thread re-reports its last reply).
- **Server**: the plugin installs and runs it (uv, verified model
  download to the data dir, CPU or GPU runtime, audio probe) unless a server
  already answers at the configured URL.
- **Data dir**: `~/.local/share/kokoro-tts` (models, `venv-cpu`, `venv-gpu`).
  Config: `~/.config/kokoro-tts/config.json`. Speech log:
  `~/.local/state/kokoro-tts/speech-log.jsonl`.
- **Endpoints**: `/turn`, `/cue`, `/play-sound`, `/preview`, `/replay`,
  `/interrupt`, `/interrupt-all`, `/cleanup`, `/mute` (`{"muted": bool}`),
  `/config`, `/voices`, `/devices`, `/engine`, `/synthesize`, `/speech-log`
  (`?session_id=` for one thread), `/speech-log/status`, `/other-audio`,
  `/health` (version, engine, latency, `started_by`). `/turn`, `/cue`,
  `/play-sound`, `/replay`, `/interrupt`, and `/cleanup` require a
  `session_id` (the bb thread id).
- **Remote node**: `KOKORO_HEADLESS=1 KOKORO_HOST=0.0.0.0` serves
  `/synthesize`; point another server at it with provider=remote.
  Warning: the server has no authentication. Binding beyond loopback lets
  anyone who can reach the port speak through it, read the speech log, and
  change its config. Only do this on a trusted network, preferably bound to
  one private address with the port firewalled to the hosts that need it.
- **Request guard**: the server refuses (403) any request with an `Origin`
  header, and, when bound to loopback, any `Host` other than `127.0.0.1`,
  `localhost`, or `[::1]`, so web pages can't drive it. Behind a reverse
  proxy, set the upstream `Host` (Caddy: `header_up Host
  {upstream_hostport}`), or bind to a non-loopback address instead.
- **Tests** (from the plugin root; the scratch environment keeps the test
  run from syncing the `cpu` group into `server/.venv`, which would break a
  live GPU server there):
  `UV_PROJECT_ENVIRONMENT=$(mktemp -d) uv run --frozen --project server --with pytest pytest tests -q`
  and `npm test`.

## Troubleshooting

Open the Kokoro TTS page: the Server card shows setup state and the
exact fix command for any failure.

No audio:
1. Server health: `curl http://127.0.0.1:6789/health`
2. Muted? `curl http://127.0.0.1:6789/health | jq .muted`
3. Server log: the plugin's log in bb (lines tagged `[server]`)
4. Direct test (plays on the server host's speakers, even while muted): `curl -X POST http://127.0.0.1:6789/preview -H "Content-Type: application/json" -d '{"text":"test"}'`

Garbled audio: non-ASCII characters in speech content -- check the log.
