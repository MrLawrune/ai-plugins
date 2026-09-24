# ai-plugins

Plugins for [bb](https://getbb.app) and Claude Code.

## kokoro-tts

Hear your agents: local Kokoro text-to-speech for every bb thread, set up and run for you.

    bb marketplace add git:github.com/MrLawrune/ai-plugins@main      # then install Kokoro TTS from the store
    bb plugin install git:https://github.com/MrLawrune/ai-plugins.git@^0.1.0 --plugin kokoro-tts --tag-prefix kokoro-tts/

Claude Code without bb:

    /plugin marketplace add MrLawrune/ai-plugins
    /plugin install kokoro-tts@mrlawrune-ai-plugins
