import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hostConfigSchema, type HostConfig } from "./configure-contract.ts";
import { aiFailure, createSttClient, SttError, type AiFailureCode } from "./stt-client.ts";

export interface VoiceInput {
  serviceId: string; model: string; audioBase64: string; mimeType: string; filename: string; prompt: string | null; timeoutMs: number;
}
export type VoiceOutput = { ok: true; model: string; text: string } | { ok: false; code: AiFailureCode; message: string };

const CONFIG_FILE = "config.json";
/** bb retries within its own budget; answer before it gives up so our code wins over a generic timeout. */
const HEADROOM_MS = 250;

export async function writeHostConfig(dataDir: string, config: HostConfig): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const target = path.join(dataDir, CONFIG_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config), { mode: 0o600 });
  await fs.rename(tmp, target);
}

export async function readHostConfig(dataDir: string): Promise<HostConfig | null> {
  try {
    const parsed = hostConfigSchema.safeParse(JSON.parse(await fs.readFile(path.join(dataDir, CONFIG_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function handleTranscribe(input: VoiceInput, dataDir: string, fetchImpl: typeof fetch = fetch): Promise<VoiceOutput> {
  const config = await readHostConfig(dataDir);
  if (!config || !config.serverUrl) return aiFailure(new SttError("not_configured", "parakeet-stt is not configured (set serverUrl in the plugin settings)", null));
  try {
    const text = await createSttClient(config, fetchImpl).transcribe(
      Buffer.from(input.audioBase64, "base64"),
      input.mimeType,
      input.filename,
      {
        customWords: config.customWords,
        removeFillers: config.removeFillers,
        correctionThreshold: config.correctionThreshold,
        timeoutMs: Math.max(100, input.timeoutMs - HEADROOM_MS),
      },
    );
    return { ok: true, model: input.model, text };
  } catch (err) {
    return aiFailure(err);
  }
}
