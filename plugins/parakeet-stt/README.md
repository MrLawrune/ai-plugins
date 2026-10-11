# parakeet-stt

A bb plugin (`bb/`) that adds dictation to every bb composer. A self-hosted
Parakeet speech-to-text server (`server/`) does the transcription. The
plugin sends the audio from bb to the server, so the browser never connects
to the server. The plugin can also serve bb's own voice button. See
`PLUGIN_OVERVIEW.md` for the end-user summary.

You need bb 0.45 or later and a Parakeet server (see [Server](#server)).
The model understands English only.

## Installation

Install the plugin from the marketplace, or install a release tag:

```bash
bb marketplace add git:github.com/MrLawrune/ai-plugins@main   # then install Parakeet STT from the store
bb plugin install git:https://github.com/MrLawrune/ai-plugins.git@^0.2.0 --plugin parakeet-stt --tag-prefix parakeet-stt/
```

Each release has a tag `parakeet-stt/vX.Y.Z`. bb installs the newest tag in
the range and builds the plugin. `bb plugin update parakeet-stt` installs a
newer release in the same range.

Then connect the plugin to your server:

1. Open Settings › Plugins › Parakeet STT › Server.
2. Enter the server URL, for example `https://stt.example.com`.
3. Enter the API key of the server, and select Save.

The status line shows "Connected" with the model name when the server
answers. You can also set the two values from a terminal:

```bash
bb plugin config parakeet-stt set serverUrl https://stt.example.com
bb plugin config parakeet-stt set apiKey <key>
```

Without a server URL, bb marks the plugin as "needs configuration".
Dictation works as soon as you save the URL. The mark stays until the next
plugin load: `bb plugin reload parakeet-stt` clears it.

## Settings

The plugin has two settings pages. Both pages save each change
automatically, and both work while the server is down.

### Server section

Settings › Plugins › Parakeet STT › Server holds the connection settings:

- **Status line**: connection state, model, server version, and the time
  of the last transcription.
- **Server URL**: an `http` or `https` address. The field saves when you
  press Enter or leave the field.
- **API key**: the key that bb sends to the server. The page never shows a
  saved key. The field reads "Set" or "Not set". Clear deletes the key.
  Leave it empty if the server needs no key.
- **Check**: asks the server for its health now.
- **Open dictation settings**: opens the Dictation page.

### Dictation page

The Dictation page in the bb sidebar holds everything else. Its header
shows the server status. The page has these sections:

| Section | Settings |
|---|---|
| Devices and profiles | This device's name, the profile you edit, profile copy, rename, and delete, the profile of each device, Forget device |
| Dictation | Mode, shortcut, hold to talk, auto-submit, trailing space, sound cues, hide bb's voice button |
| Continuous dictation | Live preview, pause before commit (300–1500 ms, default 600 ms), end on silence, silence timeout (3–60 s, default 8 s), keep listening when the screen is off, floating mic on phones, show more lines in the collapsed composer |
| Voice commands | Voice commands on or off, send phrase, stop phrase, clear phrase, wait for a start phrase, start phrases |
| Vocabulary | Custom words, remove filler words, correction strength (0–0.5, default 0.18) |
| History | Entries to keep, days to keep, the list of transcriptions with Copy, Clear |

### Devices and profiles

Each browser is a device. A browser keeps a random device id in its
localStorage, because browsers expose no stable hardware id. All tabs and
windows of one browser share the device. A private window or another
browser is a different device. If you clear the site data of a browser,
it becomes a new device.

A new device gets a name from its browser (`Android phone`, `iPad`,
`Linux PC`) and a kind:

- **Touch screen**: touch is the primary input. Phones and tablets are
  touch screens, also when they ask for the desktop site.
- **Desktop**: a mouse or trackpad is the primary input. Laptops with a
  touch screen are desktops.

A new device uses the profile of its kind: Touch screen or Desktop. You
can rename devices, give any profile to any device, and forget old
devices. You can also copy, rename, and delete profiles. The settings
below Devices and profiles change the profile in "Editing profile". The
plugin keeps 20 profiles and 50 devices at most. When a new device makes
51, the plugin forgets the device that it saw least recently.

### Per-profile and shared settings

Each profile has its own copy of these settings: shortcut, hold to talk,
auto-submit, trailing space, sound cues, mode, live preview, pause before
commit, end on silence, silence timeout, voice commands on or off, wait for
a start phrase, hide bb's voice button, keep listening when the screen is
off, floating mic, and show more lines in the collapsed composer.

All profiles share these settings: custom words, remove filler words,
correction strength, the command phrases, the start phrases, and the
history limits. The page marks each shared setting with "Shared".

### Storage

| Data | Location |
|---|---|
| Server URL | bb plugin settings (`bb plugin config parakeet-stt`) |
| API key | bb plugin secrets |
| Profiles, devices, shared settings | One `settings` row in the plugin's key-value storage, in bb's database (`plugin_kv`) |
| Dictation history | Table `dictation_log` in the plugin's database, `~/.bb/plugins/parakeet-stt/data.db` |
| Device id | localStorage key `parakeet-stt:deviceId` in each browser |

## Dictation

The plugin adds a mic button to each bb composer, and a Dictate item to
the composer's `+` menu. On a phone, an optional floating mic dictates
without opening the keyboard. Tap the mic to start the mode of your
profile. Press and hold the mic for 350 ms or more for one-shot
push-to-talk in either mode.

### Continuous mode

Continuous mode is the default. The plugin streams the audio to the
server while you speak. Each phrase goes into the draft when you pause.
The phrase in progress shows dimmed at the insertion point, and the draft
is locked until the phrase is final. A session ends when you:

- tap the mic again, or press the shortcut again;
- press Esc (this cancels the session);
- stay silent for the silence timeout, if "End on silence" is on;
- say the stop phrase, if voice commands are on.

On a phone, locking the screen ends the session, unless "Keep listening
when the screen is off" is on. A session stops after 4 hours. If the
stream cannot start, the plugin records a one-shot clip instead.

### One-shot mode

One-shot mode records the whole clip. The plugin transcribes it when you
stop and puts the text into the draft. With "Auto-submit" on, the plugin
then sends the message. A recording stops at 5 minutes, or when the page
is hidden, and the plugin transcribes what it captured.

### Insertion point

Dictation writes at the caret if you moved the caret since the last
dictation. A selection is replaced, unless it includes an @-mention: then
dictation writes at the end of the draft. If you did not move the caret,
dictation continues where the last dictation stopped. In other cases it
writes at the end of the draft. If something else changes the dictated
text during a session, the plugin stops the session and keeps the draft.

### Shortcut and command

The shortcut (default Ctrl+Space) works while bb has focus. It starts and
stops a session. With "Hold to talk" on, the plugin records a one-shot
clip while you hold the shortcut. Esc cancels a recording.

bb's command palette (Mod+Shift+P) has the command "Toggle dictation". It
has no default key. It starts or stops dictation in the composer that has
focus. If a session runs in another composer, the command stops that
session.

### Collapsed composer

On a phone, bb collapses the composer to one line. With "Show more lines
in the collapsed composer" on, the draft wraps to about 4 lines and
scrolls. During a session, the plugin scrolls the collapsed composer so
that the newest words stay visible.

## Voice commands

Voice commands work in continuous mode when "Voice commands" is on. The
default phrases are:

| Command | Default phrase | Action |
|---|---|---|
| Send | `send it` | Sends the message. |
| Stop | `stop listening` | Ends the session. |
| Clear | `clear all response text` | Empties the message box. The session continues. |
| Start | `start new reply`, `send new message` | Starts typing (with "Wait for a start phrase" only). |

The send and stop phrases count only at the end of a sentence. The clear
and start phrases count anywhere. You can edit all phrases. Separate
alternatives with commas, for example `send it, sunday`. A phrase of 10 or
more letters also matches a near-miss, for example `start a new reply`. A
shorter phrase must match exactly. If bb cannot send the message, a
notice gives the reason.

With "Wait for a start phrase" on, a session ignores speech until you say
a start phrase. The plugin keeps the words that you say after it. A start
phrase still counts when a pause divides it. While the session waits, the
banner shows what the server heard last. The send phrase sends the
message, and then the session waits again. Thus you can send reply after
reply without touching the screen.

## bb's voice button

The plugin registers an AI service, `parakeet`, for bb's own voice button
and for `bb voice transcribe`. Select it as the voice service:

```bash
bb settings ai-services set voice parakeet
bb settings ai-services show        # voice: Parakeet STT (self-hosted)
```

bb stops a voice-button request after 10 seconds. On a CPU server, this
time is enough for clips of about one minute. The plugin's own dictation
allows 120 seconds for each transcription.

bb can send a vocabulary hint with a voice-button request. The plugin
divides the hint at commas and line ends. It adds those words to your
custom words for that request, up to 200 words of 64 characters each.

If you use the plugin's mic, you can hide bb's voice button with "Hide
bb's voice button".

## History and privacy

The plugin keeps a history of what you dictated, so that you can copy it
again. It records one entry for each one-shot transcription, one entry for
each continuous session (the final phrases, joined), and one entry for
each voice-button transcription. Each entry has the text (at most 4000
characters), the time, the duration, and the source.

The two history limits are shared by all profiles:

| Setting | Range | Default |
|---|---|---|
| Entries to keep | 0–1000 (0 records nothing) | 50 |
| Keep for | 1–90 days | 7 days |

The plugin deletes the oldest entries when a new entry goes over the
count limit. It deletes entries older than the age limit when it loads,
every hour, and when you change a limit. Clear deletes every entry.

Transcripts stay on the computer that runs bb, in the plugin's database.
The plugin never stores audio. The Parakeet server does not store audio or
transcripts. Its log records durations, lengths, and timings only.

## Server

The server is a Python aiohttp application. PyAV decodes any browser
recording (webm/opus, ogg, mp4/aac, wav, mp3) to 16 kHz mono. onnx-asr runs
`nemo-parakeet-tdt-0.6b-v2` int8 on the CPU. The server divides clips
longer than 90 seconds with Silero VAD.

The server needs Python 3.11–3.13, `uv`, 4 or more CPU cores, and about
1.2 GB of RAM when idle (up to 3 GB for long recordings).

### Start the server

```bash
cd server
PARAKEET_API_KEY=$(openssl rand -hex 32) PARAKEET_HOST=0.0.0.0 uv run python parakeet_server.py
```

The first start downloads the model (about 0.7 GB) into the Hugging Face
cache (`HF_HOME`). `/health` returns 503 until the model is loaded.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PARAKEET_HOST` | `127.0.0.1` | Bind address. A non-loopback address needs `PARAKEET_API_KEY`. |
| `PARAKEET_PORT` | `6790` | Port. |
| `PARAKEET_API_KEY` | — | Bearer token for `/v1/*` and the stream start message. |
| `PARAKEET_MODEL` | `nemo-parakeet-tdt-0.6b-v2` | onnx-asr model name. |
| `PARAKEET_QUANTIZATION` | `int8` | Empty for fp32. |
| `PARAKEET_THREADS` | `0` | onnxruntime intra-op threads (0 = runtime default). |
| `PARAKEET_MAX_UPLOAD_MB` | `25` | Upload limit in MiB. |
| `PARAKEET_MAX_SECONDS` | `600` | Limit of the decoded audio, in seconds. |
| `PARAKEET_VAD_ABOVE_SECONDS` | `90` | The server divides longer clips with VAD. |
| `PARAKEET_QUEUE_TIMEOUT` | `60` | Seconds that a request can wait for the inference slot. |

### systemd unit

```ini
[Unit]
Description=Parakeet STT server
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/parakeet-stt/server
EnvironmentFile=/etc/parakeet-stt.env
ExecStart=/usr/local/bin/uv run --frozen --project /opt/parakeet-stt/server python parakeet_server.py
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

### TLS proxy

Put the server behind a reverse proxy with TLS, for example Caddy:

```
stt.example.com {
	reverse_proxy 127.0.0.1:6790
}
```

Continuous dictation uses the `/v1/stream` websocket on the same address.
The proxy must pass websockets through. Caddy does this without extra
configuration.

### Request handling

The server keeps its event loop free for the stream sessions:

- The server reads uploads in chunks and decodes the audio in a worker
  thread.
- One inference slot serves all requests. A one-shot request or a final
  phrase waits for the slot, up to `PARAKEET_QUEUE_TIMEOUT`. After that,
  the server answers 503 `busy`.
- A live partial never waits. If the slot is busy, the server skips that
  partial, so finals and one-shot requests go first.
- If a client cancels a request during inference, the server keeps the
  slot until the inference ends. Two inferences never run at the same time.
- `/health` returns 503 with `"status": "loading"` until the model is
  loaded. The settings pages show "Loading model…" in this state.

## API

- `GET /health`: `{status, version, model, ready, uptime_s}`. 503 while
  the model loads. No authentication.
- `GET /v1/models`: the OpenAI list shape.
- `POST /v1/audio/transcriptions`: OpenAI multipart fields `file`, `model`
  (`parakeet-tdt-0.6b-v2` or `whisper-1`), and `response_format` (`json` or
  `text`). The server accepts `prompt` and `language` and ignores them.
  Extensions: `custom_words` (a JSON string array), `remove_fillers`
  (`true` or `false`, default `true`), and `correction_threshold` (0–1,
  default `0.18`).
- `GET /v1/stream`: the websocket for continuous dictation. The first
  message (text) is `{"type":"start","api_key":…,"options":{pause_ms,
  silence_timeout_s, commands:{send,stop,clear}, start:[phrases], preview,
  custom_words, remove_fillers, correction_threshold}}`. Then the client
  sends binary PCM16 LE 16 kHz mono frames, and `{"type":"stop"}` to
  finish. Server events: `ready`, `partial {seq,text}`, `final
  {seq,text}`, `command {name: send|stop|clear|start}`, `state {waiting}`,
  `heard {text}` (speech ignored while the session waits), `ended {reason:
  stopped|silence|command|limit|error}`, and `error {message}`. Close codes:
  4400 (bad start message), 4401 (authentication), 4503 (model loading).
- Errors: `{"error": {"message", "type", "code"}}`. 400 `missing_file`,
  `model_not_found`, `invalid_audio`, or `invalid_parameter`. 401
  `invalid_api_key`. 413 `file_too_large` or `audio_too_long`. 503
  `model_loading` or `busy`. 500 `transcription_failed`.

Silero VAD finds the phrase ends in a stream. A phrase opens after 64 ms
of speech and closes after `pause_ms` of silence. Noise shorter than about
100 ms does not restart the pause. Partials transcribe the open phrase
again whenever the inference slot is free. The server commits a phrase at
15 seconds and ends a session after 4 hours. It logs the length and the
close reason (pause, force, finish) of each phrase, but not its text.

The plugin relays each page stream to `/v1/stream` and adds the API key,
so the browser never sees the key. The relay allows 4 sessions at the same
time and closes a fifth with code 4429. It waits 10 seconds for the server
to connect, and it closes a session after 60 seconds without audio. When
the plugin unloads, the relay closes every session.

## Development

```bash
npm install
npm test                 # node --test for bb/**/*.test.ts, then vitest for the jsdom tests
npx tsc --noEmit
UV_PROJECT_ENVIRONMENT=$(mktemp -d) uv run --frozen --project server --with pytest pytest tests -q
PARAKEET_INTEGRATION=1 UV_PROJECT_ENVIRONMENT=$(mktemp -d) uv run --frozen --project server --with pytest pytest tests -q   # loads the real model
bb plugin build .
bb plugin install path:$PWD --yes    # then: bb plugin dev .
```

Use a scratch `UV_PROJECT_ENVIRONMENT`, as `scripts/release.sh` does. Then
the tests do not change `server/.venv`.

The frontend (`bb/app.tsx` and everything it imports) can import only
`@get-bb/plugin-sdk/app` from the SDK. A git-tag install builds the plugin
without devDependencies, so any other SDK value import breaks the build.
`bb/app-imports.test.ts` fails on such an import. Put server-only SDK code
in `bb/contract.ts` or `bb/server.ts`. `bb/schemas.ts` uses zod only.

## Release

Run the release script from a clean `main`:

```bash
scripts/release.sh X.Y.Z
```

The script sets the version in `package.json`, `server/pyproject.toml`,
the server, and `tests/test_version.py`. It then runs pytest, `npm test`,
`tsc`, and `bb plugin build`. Then it commits, tags
`parakeet-stt/vX.Y.Z`, and pushes `main` and the tag.

## Removal

`bb plugin remove parakeet-stt` deletes the plugin's bb settings and
secrets (the server URL and the API key), and the plugin files of a git
install. It keeps:

- the plugin's rows in bb's database (`plugin_kv`, plugin id
  `parakeet-stt`): profiles, devices, and shared settings. A later install
  uses them again.
- the plugin's data directory, `~/.bb/plugins/parakeet-stt/` (the history
  in `data.db`, and logs).
- the device id in the localStorage of each browser.

To delete this data:

1. Remove the plugin: `bb plugin remove parakeet-stt`.
2. Delete the rows: `sqlite3 ~/.bb/bb.db "DELETE FROM plugin_kv WHERE plugin_id = 'parakeet-stt'"`.
3. Delete the data directory: `rm -rf ~/.bb/plugins/parakeet-stt`.
4. In each browser, delete the device id. Open the developer console on
   the bb page and run `localStorage.removeItem("parakeet-stt:deviceId")`.
