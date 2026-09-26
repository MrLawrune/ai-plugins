// RPC handlers: thin adapters from the contract to the service. Unknown targets are data, not errors.
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { RpcContract } from "../schemas.ts";
import type { ActionService } from "./actions/service.ts";
import type { InfraService } from "./service.ts";

const NOT_FOUND = { found: false } as const;
const found = <T extends object>(v: T | null) => (v ? { found: true as const, ...v } : NOT_FOUND);

export function createRpcHandlers(s: InfraService, a: ActionService) {
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
    async threadStatuses() { return { threads: s.threadStatuses() }; },
    async askPrompt({ target, intent }) { const prompt = await s.askPrompt(target, intent); return prompt ? { found: true as const, prompt } : NOT_FOUND; },
    async settingsGet() { return s.settings(); },
    async envSave(input) { return { env: await s.saveEnv(input) }; },
    async envDelete({ id }) { await s.deleteEnv(id); return { deleted: true as const }; },
    async connectionSave(input) { return { connection: await s.saveConnection(input) }; },
    async connectionDelete({ id }) { await s.deleteConnection(id); return { deleted: true as const }; },
    async connectionProbe({ baseUrl }) { return s.probe(baseUrl); },
    async connectionTest({ id }) { a.clearPrivileges(id); return s.testConnection(id); },
    async connectionCapabilities({ id }) {
      try { return { capabilities: await a.capabilities(id), error: null }; }
      catch (e) { return { capabilities: null, error: e instanceof Error ? e.message : String(e) }; }
    },
    async actionOptions({ target }) { const o = await a.options(target); return o ? { found: true as const, ...o } : NOT_FOUND; },
    async actionPrepare(input) { return a.prepare(input); },
    async actionExecute(input) { return a.execute(input); },
    async actionAbort({ actionId }) { return a.abort(actionId); },
    async actionGet({ actionId }) { const row = s.action(actionId); return row ? { found: true as const, action: row } : NOT_FOUND; },
    async actionList(q) { return { actions: s.actionList(q) }; },
    async taskLog({ target, upid, start, limit }) { const lines = await s.taskLog(target, upid, start, limit); return lines ? { found: true as const, lines } : NOT_FOUND; },
  } satisfies PluginRpcHandlers<RpcContract>;
}
