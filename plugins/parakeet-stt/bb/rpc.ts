import type { HostConfig } from "./configure-contract.ts";
import type { HistoryStore } from "./history.ts";
import type { PrefsStore } from "./prefs.ts";
import type { DeviceKind, HealthResult, Prefs } from "./schemas.ts";
import type { SttClient } from "./stt-client.ts";

export const TRANSCRIBE_TIMEOUT_MS = 120_000;

export interface RpcDeps {
  client: () => SttClient;
  configured: () => boolean;
  prefs: PrefsStore;
  history: HistoryStore;
  now: () => number;
}

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

export function hostConfigFrom(settings: { serverUrl: string; apiKey: string }, prefs: Prefs): HostConfig {
  return {
    serverUrl: settings.serverUrl,
    apiKey: settings.apiKey,
    customWords: prefs.customWords,
    removeFillers: prefs.removeFillers,
    correctionThreshold: prefs.correctionThreshold,
  };
}

export function createRpcHandlers(deps: RpcDeps) {
  let lastLatencyMs: number | null = null;
  return {
    async health(): Promise<HealthResult> {
      if (!deps.configured()) return { configured: false, up: false, model: null, version: null, error: null, lastLatencyMs };
      try {
        const h = await deps.client().health();
        return { configured: true, up: h.ready, model: h.model, version: h.version, error: h.ready ? null : "model loading", lastLatencyMs };
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
      });
      const durationMs = deps.now() - started;
      lastLatencyMs = durationMs;
      await deps.history.add(text, durationMs);
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
    async listHistory() { return { entries: await deps.history.list() }; },
    async clearHistory() { await deps.history.clear(); return { cleared: true as const }; },
  };
}
