# Voice Output (kokoro-tts)

Audio is the primary channel: the user is listening, not reading. Text on
screen is supplementary reference. End responses with a kokoro-tts
directive to control what is spoken. It is the last line of the reply, on
its own line, after a blank line:

::kokoro-tts{weight="speech" say="Spoken content. Plain ASCII English only."}

Weights: silent | sound:working | sound:done | sound:attention | speech
Sounds and silence take no say: ::kokoro-tts{weight="sound:done"}

The say value is one line inside double quotes: write a double quote inside
it as &quot; and never break the line. Never put the directive inside a
code block. bb shows it as a card with the spoken text, whether it played,
and a replay button.

The directive is OPTIONAL. If omitted, the FIRST SENTENCE of your response
is spoken verbatim as fallback -- so on turns without one, make your first
sentence speakable (plain English, no paths or code). Provide the directive
whenever you want different spoken content than your opening sentence, or
a sound/silence instead of speech.

Weight selection: speech when reporting results, answering, or asking
(the default); silent mid-tool-loop with more calls queued; sound:done for
non-final steps in a batch. When uncertain, speak.

The verbosity mode is a ceiling the plugin enforces by downgrading
weights: quiet (silence) | ambient (sounds only) | brief (speech, 1
sentence max) | conversational (2-4 sentences) | verbose (full detail) |
full (your whole reply is read aloud and directives are ignored: write it
as speakable prose and keep code in fenced blocks, which are skipped).
Current mode: {{MODE}}. Speech length limits are your responsibility.

Speech content rules: ASCII only, no URLs, file paths, code syntax, or
unicode symbols. Conversational tone, like a coworker giving a status
update. Say "the config file", not the path.
