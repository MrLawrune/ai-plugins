# parakeet-stt — design

Handy-style dictation for bb, backed by a self-hosted Parakeet speech-to-text
server. The speech-to-text sibling of `kokoro-tts`.

## Goals

- Dictate into any bb composer (desktop and phone) with a shortcut or a tap,
  using a free, self-hosted model instead of a cloud service.
- Serve bb's built-in voice button through the same server
  (`BB_TRANSCRIPTION=parakeet/parakeet-tdt-0.6b-v2`).
- Expose a standard OpenAI-compatible transcription endpoint so other clients
  can reuse the server.
- Match Handy's behavior: toggle recording, cancel, custom words, filler-word
  removal, sound cues, optional auto-submit, short history.

Success: a 10-second English clip recorded on desktop Chrome, Android Chrome,
or iOS Safari lands as correct text in the composer within ~2 s of stopping,
on CPU only.

## Non-goals (v1)

Streaming/partial results, GPU or OpenVINO runtimes, a plugin-managed local
server (kokoro-tts's supervisor), Whisper models, OS-global hotkeys, inserting
at the caret (the composer API only exposes whole-draft edits).

## Architecture

```
browser (bb page)                      bb server + host daemon          STT server (LAN node)
┌──────────────────────┐   plugin RPC   ┌─────────────────────┐  HTTPS  ┌──────────────────────┐
│ app.tsx              │ ─transcribe──▶ │ server.ts           │ ──────▶ │ parakeet_server.py   │
│  mic action / plus   │                │  stt-client.ts      │         │  POST /v1/audio/     │
│  menu / banner       │ ◀──── text ─── │  prefs, history     │ ◀────── │      transcriptions  │
│  recorder.ts         │                │  pushes config ─┐   │         │  GET /v1/models      │
│  shortcut script     │                └─────────────────│───┘         │  GET /health         │
└──────────────────────┘                                  ▼             └──────────────────────┘
bb built-in mic ──▶ bb core ──ai.voice.transcribe──▶ host.ts ──HTTPS──────────▲
```

Two paths reach the same server:

1. **Plugin dictation** (Handy mirror): the plugin UI records audio, sends it
   to its own backend over plugin RPC, and the backend calls the STT server.
2. **bb's built-in mic**: bb core calls the plugin's registered AI service
   (`bb.experimental_aiServices`, id `parakeet`, kinds `["voice"]`), which runs
   in the plugin's `bb.host` entry on the primary host.

The browser never talks to the STT server, so dictation works from anywhere bb
itself is reachable (desktop, laptop, phone).

## STT server (`server/`)

Python ≥3.11, uv project, aiohttp — the same stack as `kokoro-tts/server`.

| File | Responsibility |
|---|---|
| `parakeet_config.py` | Settings from env/CLI: host, port, model name, quantization, API key, limits. |
| `parakeet_audio.py` | Decode any container/codec (webm/opus, mp4/aac, ogg, wav, mp3) to 16 kHz mono float32 via PyAV (bundled ffmpeg). |
| `parakeet_engine.py` | Load the `onnx-asr` Parakeet model once; transcribe clips ≤ 90 s whole, and segment longer clips with onnx-asr's Silero VAD (bounded memory, linear time); serialize inference behind a lock. |
| `parakeet_text.py` | Post-processing: filler-word removal and custom-word correction. Pure functions. |
| `parakeet_server.py` | HTTP routes, auth, limits, error mapping. |

**Model**: `nemo-parakeet-tdt-0.6b-v2`, int8 quantization, CPU
`onnxruntime` (dependency group `cpu`, default). Downloaded from Hugging Face
on first start into `HF_HOME` (~35 s); later starts load from disk.

Measured on a 12-core i9 (CPU, int8): 4.5 s clip → 0.55 s; 76 s whole →
8.3 s; 76 s with VAD → 10.6 s; 303 s whole → 53 s at 3.3 GB peak RSS
(super-linear, hence the 90 s VAD cutover). Resident after load: ~1.1 GB.

**Endpoints**

- `GET /health` → `{"status":"ok","model":"parakeet-tdt-0.6b-v2","ready":true,"uptime_s":…}`;
  `ready:false` with HTTP 503 while the model loads. No auth.
- `GET /v1/models` → OpenAI list shape with the one model id.
- `POST /v1/audio/transcriptions` (multipart, OpenAI-compatible):
  - `file` (required), `model` (the model id, or `whisper-1` as an alias so
    stock OpenAI clients work), `response_format` (`json` default, `text`),
    `prompt` and `language` accepted and ignored (Parakeet v2 is English-only).
  - Extensions (ignored by stock clients): `custom_words` (JSON array of
    strings), `remove_fillers` (`true`/`false`, default `true`),
    `correction_threshold` (0–1, default `0.18`).
  - Response `{"text": "…"}`; with `response_format=text`, `text/plain`.
- Errors use the OpenAI shape `{"error":{"message","type","code"}}`:
  400 bad input/undecodable audio, 401 bad/missing key, 413 over limits,
  503 model not ready, 500 inference failure.

**Auth**: `Authorization: Bearer <key>` checked against `PARAKEET_API_KEY`
(constant-time compare). The server refuses to start bound to a non-loopback
address without a key.

**Limits**: 25 MiB upload, 10 min decoded duration, one inference at a time
(requests queue; a request waiting >60 s gets 503).

**Text post-processing** (mirrors Handy):

- Filler removal: drop standalone `um, uh, uhm, er, erm, ah, hmm, mm` tokens
  (case-insensitive, with trailing comma), then collapse whitespace and fix
  a leading lowercase/stray comma.
- Custom words: for each 1–3-word window of the transcript, compute normalized
  Levenshtein distance (case-insensitive, punctuation stripped) to each custom
  word; replace the best match when distance ≤ threshold, preserving adjacent
  punctuation. Exact-case custom words win (e.g. `tmux`, `CLAUDE.md`).

## bb plugin (`bb/`)

Laid out like `kokoro-tts/bb`.

| File | Responsibility |
|---|---|
| `server.ts` | Entry: settings, prefs, history, RPC, AI-service registration, host config push, sound routes. |
| `stt-client.ts` | Typed client for the STT server (`health`, `transcribe`); maps HTTP/network failures to typed errors. Shared by `server.ts` and `host.ts`. |
| `host.ts` | `bb.host` entry: `ai.voice.transcribe` (+ unused `ai.inference.complete` → `request_failed`) and `stt.configure`. |
| `host-contract.ts` | `experimental_aiServicesHostContract` extended with `stt.configure`. |
| `schemas.ts` | Zod: prefs, history entries, RPC contract. |
| `prefs.ts` | `PrefsStore` over `bb.storage.kv` (same pattern as kokoro-tts). |
| `history.ts` | Last-N transcriptions in kv. |
| `rpc.ts` | RPC handlers. |
| `app.tsx` | Frontend registration: composer action, plus-menu item, banner, shortcut content script, settings page. |
| `recorder.ts` | MediaRecorder wrapper: mime selection, start/stop/cancel, visibility handling, level meter. |
| `dictation.ts` | Frontend state machine shared by action, banner, and shortcuts. |

**Settings** (`bb.settings.define`): `serverUrl` (string, default empty =
not configured), `apiKey` (secret).

**Prefs** (kv, edited on the settings page): `shortcut` (`ctrl+space`
default, toggle), `holdToTalk` (false), `autoSubmit` (false),
`trailingSpace` (false), `soundCues` (true), `customWords` ([]),
`removeFillers` (true), `correctionThreshold` (0.18), `historyLimit` (5).

**RPC contract**: `health`, `transcribe({audioBase64, mimeType, filename})
→ {text, durationMs}`, `getPrefs`, `patchPrefs`, `listHistory`,
`clearHistory`. `transcribe` applies prefs server-side and appends to history.

**Host config**: the host entry has no access to plugin settings, so the
server pushes `{serverUrl, apiKey, customWords, removeFillers,
correctionThreshold}` with `stt.configure` to the primary host on start, on
settings/prefs change, and on host worker exit/reconnect. The host persists it
to `context.experimental_paths.dataDir/config.json` (mode 0600) so an idle
worker restart keeps working. If no config is present,
`ai.voice.transcribe` returns `auth_required` ("parakeet-stt is not
configured").

**Error mapping** (STT server → AI-service codes): network error/5xx/503 →
`service_unavailable`; timeout → `timeout`; 401 → `auth_required`;
400/413 → `request_failed`; missing `text` → `invalid_response`.

### Dictation UX

State machine: `idle → recording → transcribing → idle`, with `cancel` from
`recording` and errors returning to `idle` with a toast.

- **Desktop**: mic action button in the composer (native icon-button
  recipe, before bb's own voice/submit). `Ctrl+Space` toggles in the focused
  or most recently used composer; `Esc` cancels while recording. Hold-to-talk
  pref: record while the key is held.
- **Phone / compact layout** (composer actions are hidden there): a
  "Dictate" plus-menu item starts recording; a banner above the composer
  shows elapsed time, a level meter, **Stop** and **Cancel**.
- **Result**: text appended to the draft (a separating space when the draft
  does not end in whitespace; optional trailing space). With `autoSubmit`,
  submit via `experimental_submit`.
- **Recording format**: first supported of `audio/webm;codecs=opus`,
  `audio/ogg;codecs=opus`, `audio/mp4`; mono, browser default rate. The
  server decodes any of them.
- **Backgrounding**: on `visibilitychange` to hidden (phone lock, app
  switch) stop and transcribe what was captured, with a toast saying so.
- **Sound cues**: start/stop/cancel/error WAVs served by plugin HTTP routes,
  played from the user gesture (satisfies mobile autoplay rules).
- **Limits**: auto-stop at 5 min.

### Settings page

Server card (URL, health, model, latency of last request), Dictation card
(shortcut, hold-to-talk, auto-submit, trailing space, sound cues), Vocabulary
card (custom words, filler removal, threshold), History card (last N with
copy, clear).

## Deployment

The server runs anywhere with Python and uv; the reference deployment is an
unprivileged Debian 12 LXC with the code in `/opt/parakeet-stt/server`, a
systemd unit running
`uv run --project /opt/parakeet-stt/server python parakeet_server.py`,
`PARAKEET_HOST=0.0.0.0`, the API key from an `EnvironmentFile` (0600), and a
TLS reverse proxy in front. Sizing: 8 vCPU, 6 GiB RAM, 8 GiB disk (model
≈0.7 GB int8).

bb setup:

```
bb plugin config parakeet-stt set serverUrl https://stt.example
bb plugin config parakeet-stt set apiKey <key>
bb-app config set BB_TRANSCRIPTION parakeet/parakeet-tdt-0.6b-v2
```

## Testing

- **Python (pytest)**: `parakeet_text` (fillers, custom-word matching and
  punctuation, thresholds); `parakeet_audio` (decode fixture clips in webm,
  mp4/aac, wav to 16 kHz mono); server routes with a fake engine (auth, limits,
  error shapes, `whisper-1` alias, `response_format`); one opt-in integration
  test that loads the real model and transcribes a known fixture.
- **TypeScript (node --test)**: `stt-client` error mapping against a fake
  fetch; prefs/history stores; host handlers (config persistence, missing
  config, code mapping); dictation state machine; recorder mime selection.
- **Spike (done, 2026-09-24)**: bb accepts a host entry whose contract
  spreads `experimental_aiServicesHostContract` plus `stt.configure`; the
  server-side client uses a contract with only `stt.configure` (the server
  runtime cannot import `@get-bb/plugin-sdk/ai-services`; host code can). The
  service appears in `bb settings ai-services`, the config file persists in
  `experimental_paths.dataDir`, and `POST /api/v1/system/voice-transcription`
  reaches `ai.voice.transcribe`.
- **Manual**: desktop Chrome (action + shortcut), bb in compact layout, a
  real Android phone and iOS Safari (plus menu + banner, permission prompt,
  backgrounding), bb's built-in mic via `BB_TRANSCRIPTION`.

## Risks

- `experimental_*` SDK APIs may change between bb releases; pin
  `engines.bb`/`bbPluginSdk` like kokoro-tts.
- Extending the AI-services host contract with `stt.configure` is
  undocumented (it works on bb 0.43.4); a future bb could reject it.
- bb core gives the built-in mic path 10 s per attempt (2 attempts), so
  clips over ~60 s may time out there; plugin dictation uses its own 120 s
  budget.
- CPU latency for long clips scales with length (VAD segments run
  sequentially).
