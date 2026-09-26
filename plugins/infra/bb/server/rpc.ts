// RPC handlers: thin adapters from the contract to the service. Unknown targets are data, not errors.
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { RpcContract } from "../schemas.ts";
import type { InfraService } from "./service.ts";

const NOT_FOUND = { found: false } as const;
const found = <T extends object>(v: T | null) => (v ? { found: true as const, ...v } : NOT_FOUND);

export function createRpcHandlers(s: InfraService) {
  return {
    async overview() { return s.overview(); },
    async env({ slug }) { return found(s.envView(slug)); },
    async host({ target }) { return found(await s.hostView(target)); },
    async guest({ target }) { return found(await s.guestView(target)); },
    async guestSummary({ target }) { return found(s.guestSummary(target)); },
    async hostSummary({ target }) { return found(s.hostSummary(target)); },
    async guestExtras({ target, tab }) { return found(await s.guestExtras(target, tab)); },
    async metrics({ target, range }) { const series = await s.metrics(target, range); return series ? { found: true as const, series } : NOT_FOUND; },
    async activity(q) { return s.activity(q); },
    async threadTargets({ threadId }) { return { targets: s.threadTargets(threadId) }; },
    async runningThreads() { return { threads: s.runningThreads() }; },
    async askPrompt({ target, intent }) { const prompt = await s.askPrompt(target, intent); return prompt ? { found: true as const, prompt } : NOT_FOUND; },
    async settingsGet() { return s.settings(); },
    async envSave(input) { return { env: await s.saveEnv(input) }; },
    async envDelete({ id }) { await s.deleteEnv(id); return { deleted: true as const }; },
    async connectionSave(input) { return { connection: await s.saveConnection(input) }; },
    async connectionDelete({ id }) { await s.deleteConnection(id); return { deleted: true as const }; },
    async connectionProbe({ baseUrl }) { return s.probe(baseUrl); },
    async connectionTest({ id }) { return s.testConnection(id); },
  } satisfies PluginRpcHandlers<RpcContract>;
}
