Talk to your agents instead of typing. Tap the mic (or press Ctrl+Space) and speak: each phrase goes into the composer when you pause, with a live preview of the phrase in progress. A Parakeet model on your own server does the transcription.

## What you get

- **Continuous dictation**: each phrase goes into the draft at a pause while you keep talking. The phrase in progress shows dimmed. End the session with a tap, after a silence timeout, or by saying "stop listening". Say "send it" to send, or "clear all response text" to start the message again.
- **Hands-free replies**: a session can wait for "start new reply" before it types, and wait again after each send.
- **One-shot**: hold the mic to talk, and release it to transcribe. Or make one-shot the default.
- A mic button in every bb composer, a **Dictate** item in the composer's `+` menu, and a floating mic on phones. You can hide bb's own voice button so that there is one mic.
- Text at the caret: dictation writes where you put the cursor and keeps @-mentions intact.
- Ctrl+Space to start and stop (or hold to talk), Esc to cancel, and a "Toggle dictation" command in bb's command palette.
- Profiles for each device: phones and tablets get the Touch screen profile, computers get the Desktop profile. For example, hands-free on the phone and push-to-talk on the desktop. Name your devices and give any profile to any device.
- Custom words that correct spelling and case for your vocabulary (`tmux`, `CLAUDE.md`, product names), and filler-word removal.
- bb's own voice button can use the same server: select Parakeet STT in `bb settings ai-services`.
- A history you control: keep it for 1 to 90 days and up to 1000 entries, copy from it, or clear it. Audio is never stored.
- A Dictation page in the sidebar, and the server settings on the plugin page.

## How it works

The plugin sends each recording through bb to a small OpenAI-compatible server. The server runs NVIDIA's open Parakeet TDT 0.6B v2 model on the CPU. Your browser never connects to the server, so dictation works wherever bb works, also from a phone. Your speech goes only to machines that you run.

## Requirements

- A machine for the server: Python 3.11–3.13, `uv`, 4 or more CPU cores, about 1.2 GB of RAM when idle, and up to 3 GB for long recordings.
- bb 0.45 or later.
- English speech (Parakeet v2 understands English only).
