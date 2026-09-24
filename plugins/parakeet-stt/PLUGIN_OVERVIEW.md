Talk to your agents instead of typing. Press Ctrl+Space (or tap the mic), speak, and the text lands in the composer, transcribed by a Parakeet model running on your own server.

## What you get

- A mic button in every bb composer, plus a **Dictate** item in the composer's `+` menu for phones and compact layouts.
- Ctrl+Space to start and stop (or hold to talk), Esc to cancel.
- Custom words that fix spelling and case for your vocabulary (`tmux`, `CLAUDE.md`, product names).
- Filler-word removal, optional auto-submit, start/stop sound cues, and a short history you can copy from.
- bb's own voice button can use the same server: set `BB_TRANSCRIPTION` to `parakeet/parakeet-tdt-0.6b-v2`.

## How it works

The plugin sends each recording through bb to a small OpenAI-compatible server that runs NVIDIA's open Parakeet TDT 0.6B v2 model on CPU. Your browser never talks to the server directly, so dictation works wherever bb does, including from a phone. Nothing leaves machines you run.

## Requirements

- A machine for the server: Python 3.11–3.13, `uv`, 4+ CPU cores, about 1.2 GB RAM idle and up to 3 GB for long recordings.
- English speech (Parakeet v2 is English-only).
