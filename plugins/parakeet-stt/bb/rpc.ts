import type { DictationLog } from "./dictation-log.ts";
import { MIGRATION_NOTE_KEY } from "./migrate.ts";
import type { PrefsStore } from "./prefs.ts";
import { MODEL_LOADING, serverUrlSchema, type DeviceKind, type HealthResult, type Prefs, type ServerResult } from "./schemas.ts";
import type { SttClient } from "./stt-client.ts";

export const TRANSCRIBE_TIMEOUT_MS = 120_000;

export interface RpcDeps {
  client: () => SttClient;
  configured: () => boolean;
  prefs: PrefsStore;
  history: DictationLog;
  kv: { get<T>(key: string): Promise<T | undefined>; delete(key: string): Promise<void> };
  now: () => number;
  /** The server connection settings, written through bb's settings store. */
  server: {
    get(): { serverUrl: string; apiKey?: string };
    set(values: { serverUrl?: string; apiKey?: string | null }): Promise<void>;
    /** The plugin was marked needs-configuration at load; it clears only on the next load. */
    needsConfiguration: boolean;
  };
  /** Aborts when the plugin unloads; cancels in-flight transcriptions. */
  signal: AbortSignal;
}

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

export function createRpcHandlers(deps: RpcDeps) {
  let lastLatencyMs: number | null = null;
  const serverResult = (): ServerResult => {
    const { serverUrl, apiKey } = deps.server.get();
    return { serverUrl, apiKeySet: !!apiKey, needsReload: deps.server.needsConfiguration && serverUrl.trim() !== "" };
  };
  return {
    async health(): Promise<HealthResult> {
      if (!deps.configured()) return { configured: false, up: false, model: null, version: null, error: null, lastLatencyMs };
      try {
        const h = await deps.client().health();
        return { configured: true, up: h.ready, model: h.model, version: h.version, error: h.ready ? null : MODEL_LOADING, lastLatencyMs };
      } catch (e) {
        return { configured: true, up: false, model: null, version: null, error: message(e), lastLatencyMs };
      }
    },
    async transcribe(input: { audioBase64: string; mimeType: string; filename: string }) {
      const p = deps.prefs.get();
      const started = deps.now();
      const text = await deps.client().transcribe(Buffer.from(input.audioBase64, "base64"), input.mimeType, input.filename, {
        customWords: p.customWords,
        removeFillers: p.removeFillers,
        correctionThreshold: p.correctionThreshold,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        signal: deps.signal,
      });
      const durationMs = deps.now() - started;
      lastLatencyMs = durationMs;
      deps.history.add({ text, durationMs, source: "oneshot", deviceId: null });
      return { text, durationMs };
    },
    async hello(input: { deviceId: string; name: string; kind: DeviceKind }) {
      const device = await deps.prefs.hello(input.deviceId, input.name, input.kind, deps.now());
      return { device, prefs: deps.prefs.get(device.profileId) };
    },
    async getPrefs(input: { profileId: string }) { return deps.prefs.get(input.profileId); },
    async setPrefs(input: { profileId: string; patch: Partial<Prefs> }) { return deps.prefs.update(input.profileId, input.patch); },
    async listProfiles() { return { profiles: deps.prefs.profiles(), devices: deps.prefs.devices() }; },
    async createProfile(input: { name: string; copyFrom: string }) { return deps.prefs.createProfile(input.name, input.copyFrom); },
    async renameProfile(input: { id: string; name: string }) { return deps.prefs.renameProfile(input.id, input.name); },
    async deleteProfile(input: { id: string }) { await deps.prefs.deleteProfile(input.id); return { deleted: true as const }; },
    async updateDevice(input: { id: string; name?: string; profileId?: string }) { return deps.prefs.updateDevice(input.id, input); },
    async forgetDevice(input: { id: string }) { await deps.prefs.forgetDevice(input.id); return { forgotten: true as const }; },
    async listHistory() { return { entries: deps.history.list() }; },
    async clearHistory() { deps.history.clear(); return { cleared: true as const }; },
    async getServer() { return serverResult(); },
    async setServer(input: { serverUrl?: string; apiKey?: string | null }) {
      const url = input.serverUrl === undefined ? undefined : serverUrlSchema.safeParse(input.serverUrl);
      if (url && !url.success) throw new Error(url.error.issues[0]!.message);
      await deps.server.set({
        ...(url?.success ? { serverUrl: url.data } : {}),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      });
      return serverResult();
    },
    async getNote() {
      const note = await deps.kv.get<unknown>(MIGRATION_NOTE_KEY);
      return { note: typeof note === "string" && note !== "" ? note : null };
    },
    async dismissNote() { await deps.kv.delete(MIGRATION_NOTE_KEY); return { dismissed: true as const }; },
  };
}
