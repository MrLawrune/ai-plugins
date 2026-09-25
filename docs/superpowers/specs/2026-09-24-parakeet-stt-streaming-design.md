# parakeet-stt streaming — design

Continuous, hands-free dictation for the `parakeet-stt` plugin: phrases commit
to the draft at each pause while you keep talking, with a live (dimmed)
preview of the phrase in progress. Extends
`2026-09-24-parakeet-stt-design.md`.

## Goals

- **Continuous mode (primary):** each phrase is committed to the composer
  draft when you pause; you keep talking.
- **Live preview (secondary):** the in-progress phrase shows dimmed at the end
  of the draft, refined as you speak, solid on commit.
- **Session endings**, each a setting: manual stop (default on, always
  available), silence timeout, voice commands (`send it`, `stop listening`).
- **Voice editing and hands-free replies:** `clear all response text` empties
  the draft and keeps listening; optional start phrases (`start new reply`,
  `send new message`) gate a session so speech is ignored until one is said,
  and `send it` returns to waiting. Sessions still start and stop with the
  mic button.
- **One mic:** a setting hides bb's native voice button (default on).
- **Gestures:** tap = default mode; press-and-hold ≥ 350 ms = one-shot
  push-to-talk (records while held); Ctrl+Space / hold-to-talk unchanged.

Success: on a phone, continuous dictation commits each phrase within ~1 s of
pausing; the preview trails speech by ≲ 1 s for phrases under 10 s; locking
the phone ends the session and keeps all spoken text.

## Non-goals

GPU, a streaming-native model, word timestamps, editing inside the live tail,
more than one simultaneous stream per user, bb's native mic streaming.

## Measured constraints (reference LXC: 8 vCPU on an i9-12900HK, CPU, sustained load)

| Phrase so far | Partial pass |
|---|---|
| 1 s | 0.37 s |
| 3 s | 0.5–0.7 s |
| 5 s | 0.7–0.9 s |
| 10 s | 1.1 s |
| 20 s | 1.6 s |

Silero VAD: 0.34 ms per 32 ms frame. One-shot requests after idle: ~0.35 s for
4.5 s; back-to-back: ~0.9 s (laptop CPU sustained clocks).

## Architecture

```
page (AudioWorklet → 16 kHz PCM16) ──ws /api/v1/plugins/parakeet-stt/http/stream──▶ plugin relay
     ◀── partial / final / command / ended ──                                           │  (adds key + prefs)
                                                                   wss://<server>/v1/stream
                                                                   Silero endpointing + Parakeet passes
```

### Wire protocol (`/v1/stream`, relay ↔ server; the page ↔ relay leg is identical minus secrets)

Client → server:
- text `{"type":"start","api_key":…,"options":{…}}` — first message, within 10 s.
  Options: `pause_ms` (300–1500, default 600), `silence_timeout_s` (number or
  null), `commands` (`{"send": "send it", "stop": "stop listening", "clear":
  "clear all response text"}`, any subset, or null), `start` (list of up to 10
  start phrases; non-empty makes the session wait for one),
  `preview` (bool), `custom_words`, `remove_fillers`, `correction_threshold`.
  The page sends `{"type":"start"}`; the relay fills key and options from the
  plugin settings/prefs.
- binary frames: PCM 16-bit little-endian, 16 kHz, mono, any length.
- text `{"type":"stop"}` — finish: finalize the open phrase, then end.

Server → client (text JSON):
- `{"type":"ready"}`
- `{"type":"partial","seq":n,"text":…}` — in-progress phrase `n`.
- `{"type":"final","seq":n,"text":…}` — phrase `n` committed (post-processed; command words removed; may be empty).
- `{"type":"command","name":"start"|"clear"}` — before the final whose remaining text follows the phrase.
- `{"type":"command","name":"send"|"stop"}` — after the final that contained it.
- `{"type":"state","waiting":bool}` — sessions with start phrases: sent after `ready` (waiting) and on every change.
- `{"type":"ended","reason":"stopped"|"silence"|"command"|"limit"|"error"}` — last message; server then closes.
- `{"type":"error","message":…}` — followed by `ended` (`error`) and close.
Auth failures close with code 4401, model not ready 4503.

### Server session (`parakeet_stream.py`)

- Audio time, not wall time, drives every decision (deterministic tests).
- **Endpointing:** Silero probability per 512-sample frame; a phrase opens
  after 2 consecutive frames ≥ 0.5 and closes after `pause_ms` of frames
  < 0.35. 200 ms of pre-roll is prepended to each phrase.
- **Partials** (if `preview`): whenever no partial is running, the phrase is
  ≥ 0.5 s, and ≥ 0.25 s of new audio arrived since the last pass, transcribe
  the whole open phrase. Partials never wait for the inference lock — if it
  is busy they are skipped.
- **Finals:** on close, transcribe the phrase (waits for the lock, in phrase
  order), post-process (custom words, fillers), strip a trailing voice
  command, emit `final`, then `command`.
- **Force-commit:** at 15 s the phrase is cut at its lowest-probability frame
  within the last 2 s; the remainder opens the next phrase.
- **Silence timeout:** with no open phrase and `silence_timeout_s` of audio
  since the last speech (or start), the session finishes with `silence`.
- **Session limit:** 15 min of audio → finish with `limit`.
- **Commands** (`parakeet_commands.py`): matched case/punctuation-insensitively
  on whole words; the matched words are removed from the emitted text and from
  partials. `send`/`stop` match only at the *end* of a phrase. `clear` matches
  anywhere (last occurrence); only the text after it is kept. `stop` finishes
  the session with reason `command`.
- **Start phrases:** while waiting, finals are emitted empty and no partials
  are sent; `stop` and `clear` still work, `send` does not. The earliest start
  phrase in a final emits `start`, then `state` (not waiting), and the text
  after it (capitalized) is the final's text. Once dictating, start phrases are
  ordinary text. `send` returns the session to waiting.

### Plugin backend

- `stream-relay.ts`: per page socket, on `start` open the upstream websocket
  (`serverUrl` with `http(s)` → `ws(s)` + `/v1/stream`), send `start` with the
  key and options from prefs, then pipe binary frames up and events down.
  Upstream failure → page gets `error` + `ended` (`error`). Either side
  closing closes the other.
- `server.ts` registers it with `bb.http.experimental_websocket("/stream", …)`
  (auth `local`, same as the page's RPC).

### Page

- `pcm.ts`: streaming resampler Float32 @ context rate → Int16 @ 16 kHz with
  carried state; 20 ms output frames.
- `worklet.ts`: AudioWorkletProcessor source (loaded from a Blob URL) that
  posts 128-sample input blocks.
- `stream-client.ts`: getUserMedia + AudioContext + worklet → relay socket;
  resolves once `ready` arrives (5 s timeout); `stop()` sends `stop` and
  resolves on `ended`; `cancel()` closes. Page hide → interrupt (`hidden`).
- `draft-tail.ts`: pure draft editing — the live tail is always the draft's
  suffix; if the user edited the draft so it no longer ends with the tail, the
  new tail is appended after their edits.
- `dictation.ts`: controller gains mode (`continuous` | `oneshot`), phase
  `streaming`, and continuous handlers (partial → live tail, final → commit,
  command send → submit, start → re-capture the insertion point + start cue,
  clear → empty the draft + cancel cue, state → `waiting` in the snapshot,
  ended → idle). While waiting, the mic and banner show amber ("Waiting for
  “start new reply”…"). Stream failure at start → one-shot
  fallback with a toast. Disconnect mid-session → live tail becomes solid,
  toast "last phrase may be incomplete".
- Live tail painted with a composer rich-text effect (`opacity-50`).
- Mic button: pointer-down starts a 350 ms timer; firing starts one-shot
  push-to-talk until pointer-up/cancel; a shorter press is a tap (toggle in
  the default mode). Context menu suppressed.
- Content script hides `button[aria-label$=" voice input"]` while
  `hideNativeMic` is on.

### Prefs (new)

| Pref | Default |
|---|---|
| `mode` `continuous`/`oneshot` | `continuous` |
| `livePreview` | `true` |
| `pauseMs` (300–1500) | `600` |
| `endOnSilence` / `silenceTimeoutS` (3–60) | `false` / `8` |
| `voiceCommands` / `sendPhrase` / `stopPhrase` / `clearPhrase` | `false` / `send it` / `stop listening` / `clear all response text` |
| `waitForStart` / `startPhrases` (≤ 10) | `false` / `start new reply`, `send new message` |
| `hideNativeMic` | `true` |

`autoSubmit` applies to one-shot only.

## Error handling

| Condition | Behavior |
|---|---|
| Stream cannot connect / not ready in 5 s | one-shot for this session + toast |
| Server auth failure | toast with server message, idle |
| Disconnect mid-session | committed text kept; tail made solid; toast |
| Page hidden (phone lock) | `stop` sent; open phrase finalized; normal end |
| Draft edited mid-session | edits kept; tail re-anchored at the end |
| Inference busy | partials skipped; finals queue |
| 15 min session | ends with `limit` + toast |

## Testing

- Python: endpointer state machine (synthetic probabilities); session with a
  fake VAD (probability encoded in the frame's samples) and fake transcriber —
  partial scheduling/skip, final ordering, pre-roll, force-commit, silence
  timeout, limit, commands (send, stop, mid-sentence non-match), `finish`;
  websocket route via aiohttp test client (auth by first message, 4401,
  ready, events); opt-in real-model stream of the fixture.
- TypeScript: resampler; draft tail merge; server-event parser; relay with
  fake sockets; controller continuous flow (partials, finals, send, stop,
  fallback, disconnect, cancel); press-vs-tap timing helper.
- Manual (phone): continuous dictation, lock mid-session, silence timeout,
  voice commands (send, stop, clear, start phrases), press-and-hold one-shot,
  native mic hidden.
