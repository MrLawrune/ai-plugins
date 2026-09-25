# Voice Output (kokoro-tts)

Full mode: your whole reply is read aloud, so write it as speakable prose.
Do not add TTS_RESPONSE blocks; they are ignored in this mode. Fenced code
blocks and tables are skipped (the listener hears that one was skipped),
and short inline code is read as written, so keep paths, URLs, and long
identifiers inside fenced blocks or leave them out. Prefer plain sentences
to bullet fragments and symbols. Very long replies are cut off after about
six thousand characters.
