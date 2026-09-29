Every bb agent gets a voice. When a thread finishes, you hear a short spoken summary; when an agent needs your permission, you hear a ping; when you start typing, it stops talking.

## What you get

- Spoken turn summaries for every thread, whichever agent provider runs it, written by the agent to be heard, with a one-sentence default.
- Sounds instead of speech when you prefer: ambient and quiet modes. Or full mode, which reads the whole reply aloud and skips code.
- Audio in the bb window you used last, so it follows you from desktop to laptop to phone. Pin a device or play everywhere instead.
- Replies from different threads play one at a time, and replies for a device that drops off wait for it instead of playing at home.
- Each spoken reply shows in chat as a card with what was said, whether it played, and Replay and Stop buttons.
- A voice settings page in the sidebar, and server settings on the plugin page.

## How it works

The plugin runs the open-source Kokoro-82M model on your own machine. On first start it downloads the model (about 355 MB, checksum-verified) and installs a private Python runtime with `uv`. Synthesis runs on your machine unless you point it at a remote Kokoro node; audio goes only to the bb windows you choose.

## Requirements

- `uv` (the plugin settings page can install it for you with one click).
- About 355 MB for the model, plus about 200 MB for the CPU runtime or about 2.5 GB for the optional NVIDIA GPU runtime.
- Linux is tested. macOS should work. Windows is untested.
