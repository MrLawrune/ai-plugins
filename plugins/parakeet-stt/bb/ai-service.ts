// AI service "parakeet": serves bb's built-in voice button from the plugin's server process.
import type { PluginAiServiceDeclaration } from "@get-bb/plugin-sdk";
import type { DictationLog } from "./dictation-log.ts";
import type { LoadScope } from "./lifecycle.ts";
import type { PrefsStore } from "./prefs.ts";
import { TRANSCRIBE_TIMEOUT_MS, type Latency } from "./rpc.ts";
import type { SttClient } from "./stt-client.ts";

const HINT_WORD_MAX = 64;
const WORDS_MAX = 200;

/** Vocabulary bb passes with a voice transcription: one word or phrase per comma or line. */
export function hintWords(hint: string | null | undefined): string[] {
  if (!hint) return [];
  return hint.split(/[\n,]/).map((w) => w.trim()).filter((w) => w !== "" && w.length <= HINT_WORD_MAX);
}

export interface AiServiceDeps {
  client: () => SttClient;
  configured: () => boolean;
  prefs: PrefsStore;
  log: DictationLog;
  now: () => number;
  /** The plugin load: its signal cancels a transcription and disposal waits for it. */
  scope: LoadScope;
  /** Duration of the latest transcription, shown on the settings pages. */
  latency: Latency;
}

export function createAiService(deps: AiServiceDeps): PluginAiServiceDeclaration {
  /** The whole operation: reading the audio, the request and the history write stop with the plugin load. */
  async function run(audio: File, signal: AbortSignal, hint: string | null | undefined): Promise<string> {
    const stopped = () => new Error("Parakeet STT is restarting");
    if (signal.aborted) throw stopped();
    const p = deps.prefs.get();
    const started = deps.now();
    const bytes = new Uint8Array(await audio.arrayBuffer());
    if (signal.aborted) throw stopped();
    const text = await deps.client().transcribe(bytes, audio.type, audio.name, {
      customWords: [...new Set([...p.customWords, ...hintWords(hint)])].slice(0, WORDS_MAX),
      removeFillers: p.removeFillers,
      correctionThreshold: p.correctionThreshold,
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      signal,
    });
    if (deps.scope.signal.aborted) throw stopped();
    const durationMs = deps.now() - started;
    deps.latency.ms = durationMs;
    deps.log.add({ text, durationMs, source: "voice", deviceId: null });
    return text;
  }
  return {
    id: "parakeet",
    displayName: "Parakeet STT (self-hosted)",
    transcribe: (audio, { signal, hint }) => deps.scope.track(run(audio, AbortSignal.any([signal, deps.scope.signal]), hint)),
    async status() {
      return deps.configured()
        ? { ready: true }
        : { ready: false, message: "Set the Parakeet server URL in the plugin settings" };
    },
  };
}
