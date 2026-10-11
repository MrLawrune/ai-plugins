// AI service "parakeet": serves bb's built-in voice button from the plugin's server process.
import type { PluginAiServiceDeclaration } from "@get-bb/plugin-sdk";
import type { DictationLog } from "./dictation-log.ts";
import type { PrefsStore } from "./prefs.ts";
import { TRANSCRIBE_TIMEOUT_MS } from "./rpc.ts";
import type { SttClient } from "./stt-client.ts";

export interface AiServiceDeps {
  client: () => SttClient;
  configured: () => boolean;
  prefs: PrefsStore;
  log: DictationLog;
  now: () => number;
}

export function createAiService(deps: AiServiceDeps): PluginAiServiceDeclaration {
  return {
    id: "parakeet",
    displayName: "Parakeet STT (self-hosted)",
    async transcribe(audio, { signal }) {
      const p = deps.prefs.get();
      const started = deps.now();
      const text = await deps.client().transcribe(new Uint8Array(await audio.arrayBuffer()), audio.type, audio.name, {
        customWords: p.customWords,
        removeFillers: p.removeFillers,
        correctionThreshold: p.correctionThreshold,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        signal,
      });
      deps.log.add({ text, durationMs: deps.now() - started, source: "voice", deviceId: null });
      return text;
    },
    async status() {
      return deps.configured()
        ? { ready: true }
        : { ready: false, message: "Set the Parakeet server URL in the plugin settings" };
    },
  };
}
