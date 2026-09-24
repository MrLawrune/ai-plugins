Every bb agent gets a voice. When a thread finishes, you hear a short spoken summary; when an agent needs your permission, you hear a ping; when you start typing, it stops talking.

## What you get

- Spoken turn summaries for Claude Code, Codex, and Pi threads, written by the agent to be heard, with a one-sentence default.
- Sounds instead of speech when you prefer: ambient and quiet modes.
- Audio in the bb window you used last, so it follows you from desktop to laptop to phone. Pin a device or play everywhere instead.
- A settings page for voice, blends, speed, volume, mode, and sounds, with a preview button.

## How it works

The plugin runs the open-source Kokoro-82M model on your own machine. On first start it downloads the model (about 355 MB, checksum-verified) and installs a private Python runtime with `uv`. Nothing you say or your agents write leaves your machine.

## Requirements

- `uv` (the settings page can install it for you with one click).
- About 355 MB for the model, plus about 200 MB for the CPU runtime or about 2.5 GB for the optional NVIDIA GPU runtime.
- Linux is tested. macOS should work. Windows is untested.
- Claude Code users outside bb can install the companion Claude Code plugin from the same repository.
