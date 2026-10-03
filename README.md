# ai-plugins

Plugins for [bb](https://getbb.app).

## kokoro-tts

Hear your agents: local Kokoro text-to-speech for every bb thread, set up and run for you.

    bb marketplace add git:github.com/MrLawrune/ai-plugins@main      # then install Kokoro TTS from the store
    bb plugin install git:https://github.com/MrLawrune/ai-plugins.git@^0.4.0 --plugin kokoro-tts --tag-prefix kokoro-tts/

## parakeet-stt

Dictate to your agents: Handy-style speech-to-text for every bb composer, backed by your own OpenAI-compatible Parakeet server.

    bb plugin install git:https://github.com/MrLawrune/ai-plugins.git@^0.1.0 --plugin parakeet-stt --tag-prefix parakeet-stt/

Server setup and API: [plugins/parakeet-stt/README.md](plugins/parakeet-stt/README.md).

## infra

See your infrastructure and what your agents are doing to it: Proxmox environments, guests, metrics, and agent activity inside bb.

    bb plugin install git:https://github.com/MrLawrune/ai-plugins.git@^0.1.0 --plugin infra --tag-prefix infra/

Setup and surfaces: [plugins/infra/README.md](plugins/infra/README.md).

## playbooks

Build, run, and watch Ansible playbooks with your agents: plain-language cards, live runs, and targeted debugging inside bb.

    bb plugin install git:https://github.com/MrLawrune/ai-plugins.git@^0.1.0 --plugin playbooks --tag-prefix playbooks/

Requirements, setup, and surfaces: [plugins/playbooks/README.md](plugins/playbooks/README.md).
