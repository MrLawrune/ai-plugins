// bb.host entry: serves bb's built-in voice button (AI service "parakeet") and stores the
// server-pushed config, since host code cannot read plugin settings.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract.ts";
import { handleTranscribe, writeHostConfig } from "./host-handlers.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    "ai.inference.complete": async () => ({ ok: false as const, code: "request_failed" as const, message: "parakeet serves voice transcription only" }),
    "ai.voice.transcribe": async (input, context) => handleTranscribe(input, context.experimental_paths.dataDir),
    "stt.configure": async (input, context) => {
      await writeHostConfig(context.experimental_paths.dataDir, input);
      return { ok: true as const };
    },
  },
});
