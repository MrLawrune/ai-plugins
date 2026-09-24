Talk to your agents instead of typing. Tap the mic (or press Ctrl+Space) and keep talking: each phrase lands in the composer when you pause, with a live preview of what you're saying, transcribed by a Parakeet model running on your own server.

## What you get

- **Continuous dictation**: phrases commit at each pause while you keep talking; the phrase in progress shows dimmed. End it with a tap, after a silence timeout, or by saying "stop listening"; say "send it" to send.
- **One-shot**: hold the mic to talk, release to transcribe (or make one-shot the default).
- A mic button in every bb composer, plus a **Dictate** item in the composer's `+` menu for phones and compact layouts; bb's own voice button can be hidden so there is one mic.
- Ctrl+Space to start and stop (or hold to talk), Esc to cancel.
- Custom words that fix spelling and case for your vocabulary (`tmux`, `CLAUDE.md`, product names).
- Filler-word removal, optional auto-submit, start/stop sound cues, and a short history you can copy from.
- bb's own voice button can use the same server: set `BB_TRANSCRIPTION` to `parakeet/parakeet-tdt-0.6b-v2`.

## How it works

The plugin sends each recording through bb to a small OpenAI-compatible server that runs NVIDIA's open Parakeet TDT 0.6B v2 model on CPU. Your browser never talks to the server directly, so dictation works wherever bb does, including from a phone. Nothing leaves machines you run.

## Requirements

- A machine for the server: Python 3.11–3.13, `uv`, 4+ CPU cores, about 1.2 GB RAM idle and up to 3 GB for long recordings.
- English speech (Parakeet v2 is English-only).
