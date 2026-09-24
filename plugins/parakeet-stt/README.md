# parakeet-stt

Handy-style dictation for bb, backed by a self-hosted, OpenAI-compatible Parakeet speech-to-text server. The speech-to-text sibling of `kokoro-tts`.

## Layout

- `server/` — Python aiohttp server: PyAV decodes any browser recording (webm/opus, ogg, mp4/aac, wav, mp3) to 16 kHz mono; onnx-asr runs `nemo-parakeet-tdt-0.6b-v2` int8 on CPU. Clips over 90 s are split with Silero VAD.
- `bb/` — the bb plugin: composer mic action, `+` menu item, recording banner, Ctrl+Space shortcut, settings page, and an AI service (`parakeet`) whose host entry serves bb's built-in voice button.

## Run the server

```bash
cd server
PARAKEET_API_KEY=$(openssl rand -hex 32) PARAKEET_HOST=0.0.0.0 uv run python parakeet_server.py
```

The first start downloads the model (~0.7 GB) into the Hugging Face cache (`HF_HOME`); `/health` returns 503 until it is loaded.

| Variable | Default | Meaning |
|---|---|---|
| `PARAKEET_HOST` | `127.0.0.1` | Bind address. Any non-loopback address requires `PARAKEET_API_KEY`. |
| `PARAKEET_PORT` | `6790` | Port. |
| `PARAKEET_API_KEY` | — | Bearer token required on `/v1/*`. |
| `PARAKEET_MODEL` | `nemo-parakeet-tdt-0.6b-v2` | onnx-asr model name. |
| `PARAKEET_QUANTIZATION` | `int8` | Empty for fp32. |
| `PARAKEET_THREADS` | `0` | onnxruntime intra-op threads (0 = runtime default). |
| `PARAKEET_MAX_UPLOAD_MB` | `25` | Upload limit. |
| `PARAKEET_MAX_SECONDS` | `600` | Decoded-duration limit. |
| `PARAKEET_VAD_ABOVE_SECONDS` | `90` | Clips longer than this are VAD-segmented. |
| `PARAKEET_QUEUE_TIMEOUT` | `60` | Seconds a request may wait for the single inference slot. |

systemd unit:

```ini
[Unit]
Description=Parakeet STT server
After=network-online.target

[Service]
WorkingDirectory=/opt/parakeet-stt/server
EnvironmentFile=/etc/parakeet-stt.env
ExecStart=/usr/local/bin/uv run --project /opt/parakeet-stt/server python parakeet_server.py
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

Put it behind a TLS reverse proxy.

## Configure bb

```bash
bb plugin config parakeet-stt set serverUrl https://stt.example.com
bb plugin config parakeet-stt set apiKey <key>
bb-app config set BB_TRANSCRIPTION parakeet/parakeet-tdt-0.6b-v2   # optional: bb's own voice button
```

bb's built-in voice button allows 10 s per attempt, which covers clips up to roughly a minute on CPU; the plugin's own dictation allows 120 s.

## API

- `GET /health` — `{status, version, model, ready, uptime_s}`; 503 while loading. No auth.
- `GET /v1/models` — OpenAI list shape.
- `POST /v1/audio/transcriptions` — OpenAI multipart: `file`, `model` (`parakeet-tdt-0.6b-v2` or `whisper-1`), `response_format` (`json` | `text`); `prompt` and `language` are accepted and ignored. Extensions: `custom_words` (JSON string array), `remove_fillers` (`true`/`false`, default `true`), `correction_threshold` (0–1, default `0.18`).
- Errors: `{"error": {"message", "type", "code"}}` — 400 `missing_file` / `model_not_found` / `invalid_audio` / `invalid_parameter`, 401 `invalid_api_key`, 413 `file_too_large` / `audio_too_long`, 503 `model_loading` / `busy`, 500 `transcription_failed`.

## Develop

```bash
npm install
npm test && npx tsc --noEmit
uv run --project server --with pytest pytest tests -q
PARAKEET_INTEGRATION=1 uv run --project server --with pytest pytest tests -q   # loads the real model
bb plugin install . && bb plugin dev
```

## Release

`scripts/release.sh X.Y.Z` bumps versions, runs the tests, builds, commits, tags `parakeet-stt/vX.Y.Z`, and pushes.
