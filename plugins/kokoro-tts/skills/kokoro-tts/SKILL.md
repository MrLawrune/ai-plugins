---
name: kokoro-tts
description: Deep reference for Claude Code voice output via Kokoro TTS -- TTS_RESPONSE block format, weight selection, verbosity modes, fallback behavior, and troubleshooting. The always-loaded contract is injected by the SessionStart hook; consult this skill for details, examples, and debugging.
---

# Kokoro TTS -- Weighted Communication

## Two-Channel Communication

The user receives every response through two independent channels:

1. **Text (on screen)** -- Full technical detail. Write normally.
2. **Voice (spoken aloud)** -- The primary channel. The user is listening.

## The TTS_RESPONSE Block Is an Override, Not a Mandate

If a response ends with a TTS_RESPONSE block, the hook obeys it. If not,
the hook speaks the FIRST SENTENCE of the response as fallback. Nothing
errors; there is no penalty sound. Only a server that is down stops speech,
and the Stop hook then shows a message instead.

Consequences:
- On turns without a block, write a speakable first sentence (plain
  English, no paths/code) -- it will be heard verbatim.
- Provide a block when spoken content should differ from the opening
  sentence, or when you want a sound or silence instead of speech.

## Block Format

Speech:

    <!-- TTS_RESPONSE weight="speech"
    Spoken content here. Plain ASCII English only.
    TTS_RESPONSE -->

Sound or silence (self-closing):

    <!-- TTS_RESPONSE weight="sound:done" -->
    <!-- TTS_RESPONSE weight="silent" -->

Weights: `silent` | `sound:working` | `sound:done` | `sound:attention` | `speech`

## Weight Selection

- `speech` (default): reporting results, answering, asking, errors,
  plans, completions. When uncertain, speak.
- `silent`: mid-tool-loop with more calls queued and nothing to report.
- `sound:done`: a non-final step in a batch (you will speak at the end).
- `sound:working`: rarely needed -- the hook plays working ticks for
  intermediate stops automatically.
- `sound:attention`: rarely needed -- the Notification hook plays
  attention pings automatically on permission prompts and idle waits.

## Verbosity Modes (KOKORO_MODE)

The mode is a ceiling the hook enforces by downgrading weights. Speech
length limits are the model's responsibility.

| Mode | Ceiling | Speech limit |
|------|---------|-------------|
| `quiet` | silence only | n/a |
| `ambient` | sounds only | n/a |
| `brief` | speech | 1 sentence max **(default)** |
| `conversational` | speech | 2-4 sentences |
| `verbose` | speech | full detail |

Mode switching mid-session ("go quiet", "go verbose"): acknowledge and
apply the new ceiling to your own weight/length choices for the rest of
the session. The server reads the mode on every turn; change it on the BB
Kokoro TTS page or with `PATCH /config`. `KOKORO_MODE` overrides it for
Claude Code sessions outside BB.

## Speech Content Rules

- ASCII only: plain hyphens, straight quotes, basic punctuation.
- No URLs, file paths, variable names, code syntax, or unicode symbols.
- Plain English ("the config file", not the path). Conversational tone.
- brief mode: 3-6 words for simple confirmations ("Done, tests pass.").

## Pipeline Reference

- **Routing**: the server's `POST /turn` parses the block, applies the mode
  ceiling, and falls back to the first sentence (`server/kokoro_turn.py`).
  `POST /cue` gates attention and working sounds.
- **In BB** (any agent): the BB plugin voices root threads on turn end,
  stops speech when you type, pings on permission prompts, and injects this
  contract as agent instructions. Audio plays in the bb window you used last
  (`playback=client`, default) or on the server host's speakers
  (`playback=server`). The Playback devices card picks the window: follow,
  pinned device, or all.
- **Claude Code outside BB**: the plugin's hooks call `/turn` and `/cue`.
  Inside a BB thread they stand down while the BB plugin is active.
- **Server**: the BB plugin installs and runs it (uv, verified model
  download to the data dir, CPU or GPU runtime, audio probe) unless a server
  already answers at the configured URL. Outside BB, the SessionStart hook
  starts it with `uv run` from the plugin (or starts a
  `kokoro-tts-server.service` user unit, if you installed one). On first
  use it downloads the model files in the background instead
  (`hooks/scripts/tts-fetch-models.sh`, checksum-verified) and the server
  starts on a later session.
- **Data dir**: `~/.local/share/kokoro-tts` (models, `venv-cpu`, `venv-gpu`).
  Config: `~/.config/kokoro-tts/config.json`. Speech log:
  `~/.local/state/kokoro-tts/speech-log.jsonl`.
- **Endpoints**: `/turn`, `/cue`, `/speak`, `/play-sound`, `/preview`,
  `/interrupt`, `/interrupt-all`, `/cleanup`, `/mute`, `/config`, `/voices`,
  `/devices`, `/engine`, `/synthesize`, `/speech-log`, `/speech-log/status`,
  `/runtime`, `/health` (`bb_plugin_active`, `output_device_ok`, latency).
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

In BB, open the Kokoro TTS page: the Server card shows setup state and the
exact fix command for any failure.

No audio:
1. Server health: `curl http://127.0.0.1:6789/health`
2. Muted? `curl http://127.0.0.1:6789/health | jq .muted`
3. Log: `tail -20 /tmp/kokoro-hook.log`
4. Direct test: `curl -X POST http://127.0.0.1:6789/speak -H "Content-Type: application/json" -d '{"text":"test","session_id":"t1"}'`

No server outside BB: the SessionStart hook starts it on your next Claude
Code session. It needs `uv` (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
and, on first use, downloads the model (about 355 MB) to
`~/.local/share/kokoro-tts` in the background; `/tmp/kokoro-hook.log` shows
progress. To keep one server running regardless of sessions, you can run it
as a systemd user unit named `kokoro-tts-server.service` (`ExecStart` running
`uv run --project <plugin>/server python <plugin>/server/kokoro_server.py`);
the hook then starts that unit, and
`systemctl --user restart kokoro-tts-server.service` restarts it.

Garbled audio: non-ASCII characters in speech content -- check the log.

## Legacy

`TTS_SUMMARY` blocks are still parsed as `weight="speech"`.
