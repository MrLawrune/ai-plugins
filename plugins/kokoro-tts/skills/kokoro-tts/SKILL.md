---
name: kokoro-tts
description: Reference for bb's Kokoro voice output -- the kokoro-tts directive, weights, verbosity modes, per-thread and per-project voice settings, and fixing speech that doesn't play. Use when deciding what to speak, when the user changes the voice mode ("go quiet", "go verbose"), or when audio is missing or garbled.
compatibility: Requires bb with the Kokoro TTS plugin installed. Troubleshooting uses curl and jq on the bb host.
---

# Kokoro TTS -- Voice Output

The voice contract is already in your agent instructions: directive format,
weights, first-sentence fallback, and speech content rules. This skill adds
what the contract leaves out. A thread whose voice is Off gets no contract;
write no directives there.

## Gotchas

- A directive inside a code fence is treated as an example and ignored, and
  one that shares a line with other text is not a directive. If a reply has
  several, only the last counts. A `say` value that breaks across lines or
  holds a bare `"` breaks the directive; write `&quot;` for a quote.
- Non-ASCII characters (smart quotes, dashes, emoji, arrows) come out
  garbled or dropped. Use plain hyphens and straight quotes.
- With no directive, the first sentence outside code fences is spoken.
  Absolute paths and URLs are stripped from speech, but code identifiers,
  file names, and relative paths are read aloud. Keep them out of that
  sentence.
- HTML comments are never spoken.
- `sound:attention` is rarely needed: the plugin pings on its own when an
  agent waits for a permission or an answer.
- `sound:working` is a soft tick the user can turn off (Working tick).
- Full mode ignores directives and reads the whole reply: fenced code
  blocks and tables become "Code block skipped." / "Table skipped.", short
  inline code is read as written (a path as its file name), and a reply over
  about 6000 characters stops at a sentence end with "The rest is on
  screen." Write that reply as speakable prose, without a directive.
- The mode is a ceiling, not a target: the plugin downgrades weights to fit
  it, but speech length is yours to keep within the mode's limit.

## Examples

Brief (one sentence, 3-6 words for simple confirmations):

    ::kokoro-tts{weight="speech" say="Done, tests pass."}

Not: `say="I updated SKILL.md and npm test passed with 221 tests."` -- a
file name, a command, and too long for brief.

Conversational (2-4 sentences):

    ::kokoro-tts{weight="speech" say="The migration ran cleanly and the new column is live. Two old rows had empty dates, so I left them null. Want me to backfill them?"}

Verbose: full detail, still plain spoken English with no paths or code.

A non-final step in a batch, then silence mid-loop:

    ::kokoro-tts{weight="sound:done"}
    ::kokoro-tts{weight="silent"}

## Verbosity modes

| Mode | Ceiling | Speech limit |
|------|---------|-------------|
| `quiet` | off: no speech, sounds, or voice instructions | n/a |
| `ambient` | sounds only | n/a |
| `brief` | speech | 1 sentence max **(default)** |
| `conversational` | speech | 2-4 sentences |
| `verbose` | speech | full detail |
| `full` | whole reply | about 6000 characters |

The global mode is the Mode slider in the Kokoro TTS sidebar panel. The
thread header's Voice control sets a mode, or Off (the quiet stop), for the
thread and for its project, plus whether child threads speak. A thread's own
setting wins, then its nearest parent thread's, then its project's, then the
global mode. Child threads speak only when an ancestor or the project has
Child threads set to Voice, or when the child has its own mode.

When the user asks mid-session to "go quiet" or "go verbose", acknowledge
and apply the new ceiling to your own weight and length choices from then
on. Changing the actual setting is the user's call in the UI: Off and the
mode's ceiling take effect on the next reply, while the length guidance in
your instructions changes when the session restarts.

## The reply card

bb renders each directive as a card with the spoken text, Replay, Stop
while playing, and a status: Queued, Playing, Spoken, Interrupted, Muted,
Voice off, Not spoken, Error, or No record.

## Troubleshooting

Server state, setup progress, and the exact fix command for a failed setup
are in bb Settings under Server and engine. Playback choices are in the
Kokoro TTS sidebar panel under Where it plays.

No audio:
1. Server up and not muted: `curl -s http://127.0.0.1:6789/health | jq '{version, muted}'`
   (6789 is the default port; use the configured server URL if it differs).
2. Playing in a bb window (the default): the browser blocks audio until the
   user clicks once in a bb window after it loads or the plugin reloads.
   Where it plays lists connected windows and flags any that still need a
   click; "No windows connected" means no bb window is open to play in.
3. Replies go to the window used last, a pinned device, or every window
   (Route). A pinned device that dropped off holds replies for up to 15
   minutes; a phone with its screen locked plays them when reopened.
4. Server log: the plugin's log in bb, lines tagged `[server]`.
5. Server speakers only: `curl -X POST http://127.0.0.1:6789/preview -H "Content-Type: application/json" -d '{"text":"test"}'`
   plays on the bb host's speakers, even while muted. A host with no audio
   device (a VM or headless box) can't use this: On the server's speakers is
   unavailable there and replies play in a bb window.

Garbled audio: non-ASCII characters in the spoken text -- check the log.

For how replies are routed, queued, and held, the server's endpoints, a
remote synthesis node, the request guard, and data paths, read
[references/pipeline.md](references/pipeline.md).
