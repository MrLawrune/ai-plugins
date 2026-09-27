// bb-plugin-playbooks — backend entry. Wires the store, the host-entry client, the environment / library / run /
// dispatch services, and the RPC, CLI, and mention surfaces; keeps runs reconciled and old rows pruned.
import { join } from "node:path";
import type { BbPluginApi, JsonValue, PluginMentionItem } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals } from "./host-contract.ts";
import { rpcContract } from "./schemas.ts";
import { BUDGETS, CHANNELS, RETENTION_DAYS } from "./shared/constants.ts";
import { createCli, type RunFormPayload, type RunFormResult, type RunFormValue } from "./server/cli.ts";
import { safeHostClient } from "./server/host-client.ts";
import { pruneLogs } from "./server/logs.ts";
import { DispatchService } from "./server/dispatch.ts";
import { configurationGap, EnvService } from "./server/envs.ts";
import { LibraryService } from "./server/library.ts";
import { createMention } from "./server/mention.ts";
import { createRpcHandlers } from "./server/rpc.ts";
import { RunService, type HostClient, type ResolvedEnv } from "./server/runs.ts";
import { MIGRATIONS, Store, type CredRefRow, type PlaybooksEnvRow, type SqlDb } from "./server/store.ts";

export { rpcContract } from "./schemas.ts";

/** Mutable only so tests can shorten the reconcile tick. */
export const timing = { reconcileMs: 30_000 };
const RELOAD_DELAY_MS = 1500;
const DAY_MS = 86_400_000;

const line = (m: string, data?: Record<string, unknown>) => (data ? `${m} ${JSON.stringify(data)}` : m);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleepUnlessAborted = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Runs `before` ahead of every handler and `after` once it settles. */
function guard<T extends Record<string, (input: never) => Promise<unknown>>>(handlers: T, before: () => Promise<void>, after: () => void): T {
  const out: Record<string, (input: never) => Promise<unknown>> = {};
  for (const [name, fn] of Object.entries(handlers)) {
    out[name] = async (input) => {
      await before();
      try {
        return await fn(input);
      } finally {
        after();
      }
    };
  }
  return out as T;
}

export default async function plugin(bb: BbPluginApi) {
  // Reserved for future connection secrets; nothing reads it in phase 1.
  bb.settings.define({
    credentials: { type: "string", label: "Credentials", description: "Reserved. Not used yet.", secret: true },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = new Store(db as unknown as SqlDb);

  // `bb.sdk` is bind-gated, so the primary host id is resolved lazily and cached: services read it
  // synchronously once a handler or the background service has awaited `ensurePrimary`.
  let primary: string | null = null;
  let resolving: Promise<void> | null = null;
  const ensurePrimary = (): Promise<void> => {
    if (primary) return Promise.resolve();
    resolving ??= (async () => {
      try {
        const id = (await bb.sdk.system.config()).primaryHostId;
        if (!id) throw new Error("BB reports no primary host");
        primary = id;
      } finally {
        resolving = null;
      }
    })();
    return resolving;
  };
  const primaryHostId = (): string => {
    if (!primary) throw new Error("no primary host is available yet; retry in a moment");
    return primary;
  };
  const hostIdFor = (env: PlaybooksEnvRow): string => env.hostId ?? primaryHostId();

  // Every host input passes through the wrapper: `overrideCommand` never leaves the server.
  const rawHost = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const host = safeHostClient(rawHost as never);

  const envs = new EnvService({ store, host, now: Date.now, get primaryHostId() { return primaryHostId(); } });

  const library: LibraryService = new LibraryService({
    store, host, now: Date.now,
    resolveEnv(slug) {
      const env = envs.get(slug);
      return env ? { env, hostId: hostIdFor(env) } : null;
    },
    publishChanged: (payload) => bb.realtime.publish(CHANNELS.changed, payload),
    log: (level, m, data) => bb.log[level](line(m, data)),
  });

  // Phase 1: every run's local stream copy lives in the plugin's own data directory, per thread.
  const logRoot = join(bb.server.experimental_dataDir, "plugins", bb.pluginId, "logs");
  const runs = new RunService({
    store, host, now: Date.now,
    log: (level, m, data) => bb.log[level](line(m, data)),
    resolveEnv(envId): ResolvedEnv {
      const env = store.getEnv(envId);
      if (!env) throw new Error(`unknown environment ${envId}`);
      const health = envs.health(env.id);
      return { env, hostId: hostIdFor(env), ...(health ? { probe: { runner: health.runner } } : {}) };
    },
    credRef(envId, id): CredRefRow | null {
      return store.listCredRefs(envId).find((c) => c.id === id) ?? null;
    },
    async summaryFor(envId, path) {
      const env = store.getEnv(envId);
      if (!env) return null;
      const res = await library.summary(env.slug, path);
      return "summary" in res ? res.summary : null;
    },
    onRunChanged: (runId) => bb.realtime.publish(CHANNELS.run, { runId }),
    async notifyThread(threadId, text) {
      await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
    },
    logDir: (threadId) => join(logRoot, (threadId ?? "_headless").replace(/[^A-Za-z0-9_-]/g, "_")),
  });

  // Dispatch: new threads and investigations. The installed SDK types no `readonly` spawn mode; the service asks for it
  // and falls back when the host rejects the value. The thread DTO carries no model, so it comes from the thread's
  // resolved execution options.
  const dispatch = new DispatchService({
    store, envs, library, runs, now: Date.now,
    log: (level, m, data) => bb.log[level](line(m, data)),
    onRunChanged: (runId) => bb.realtime.publish(CHANNELS.run, { runId }),
    sdk: {
      threads: {
        // `readonly` is not in this SDK's spawn enum; the service handles the host's refusal.
        spawn: async ({ permissionMode, ...args }) => ({ id: (await bb.sdk.threads.spawn({ ...args, ...(permissionMode ? { permissionMode: permissionMode as "accept-edits" } : {}) })).id }),
        async get({ threadId }) {
          const t = await bb.sdk.threads.get({ threadId });
          const opts = await bb.sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null);
          return { id: t.id, projectId: t.projectId, environmentId: t.environmentId, providerId: t.providerId, model: opts?.model, canSpawnChild: t.canSpawnChild };
        },
      },
    },
  });
  const mentionItems = (threadId: string | null): PluginMentionItem[] => {
    const items: PluginMentionItem[] = [];
    const seen = new Set<string>();
    const add = (i: PluginMentionItem): void => { if (!seen.has(i.id)) { seen.add(i.id); items.push(i); } };
    const envById = new Map(envs.list().map((e) => [e.id, e]));
    if (threadId) {
      for (const f of library.threadFiles(threadId)) {
        const e = envById.get(f.envId);
        if (e) add({ id: `${e.slug}/${f.path}`, title: f.path.split("/").pop() ?? f.path, subtitle: `${e.slug} · ${f.path}` });
      }
    }
    for (const e of envById.values()) add({ id: e.slug, title: e.name, subtitle: `${e.kind} environment` });
    for (const r of store.listRuns({ limit: 10 })) {
      const e = envById.get(r.envId);
      if (e) add({ id: r.id, title: `${r.playbookName || r.playbook} · ${r.status}`, subtitle: `${e.slug} run ${r.id}` });
    }
    for (const f of library.cachedFiles()) {
      const e = envById.get(f.envId);
      if (e) add({ id: `${e.slug}/${f.path}`, title: f.path.split("/").pop() ?? f.path, subtitle: `${e.slug} · ${f.name}` });
    }
    return items;
  };
  bb.ui.registerMentionProvider(createMention({
    items: ({ threadId }) => mentionItems(threadId),
    async context(itemId) {
      await ensurePrimary();
      return dispatch.context({ ref: itemId, budget: BUDGETS.addToChat });
    },
  }));

  // Signals name their host, but resolving the run's env still needs the primary host id.
  const onSignal = <T,>(handle: (payload: T) => void) => async ({ payload }: { payload: T }): Promise<void> => {
    await ensurePrimary().catch((e: unknown) => bb.log.warn(`primary host unavailable: ${message(e)}`));
    handle(payload);
  };
  rawHost.experimental_onSignal("line", onSignal((p) => runs.onLine(p)));
  rawHost.experimental_onSignal("note", onSignal((p) => runs.onNote(p)));
  rawHost.experimental_onSignal("exit", onSignal((p) => runs.onExit(p)));
  rawHost.experimental_onWorkerExit(async () => {
    try {
      await ensurePrimary();
      await runs.onWorkerExit();
    } catch (e) {
      bb.log.warn(`resume after worker exit failed: ${message(e)}`);
    }
  });

  // Setup status: BB shows "needs configuration" until an environment exists and none is known broken.
  // The flag clears only on the next load, so reload once setup becomes complete.
  const initialGap = configurationGap(envs.list(), envs.healthMap());
  if (initialGap) bb.status.needsConfiguration(initialGap);
  let reloadScheduled = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const reloadWhenConfigured = (): void => {
    if (!initialGap || reloadScheduled || configurationGap(envs.list(), envs.healthMap())) return;
    reloadScheduled = true;
    bb.log.info("setup complete; reloading to clear the needs-configuration status");
    reloadTimer = setTimeout(() => { void bb.sdk.plugins.reload({ pluginId: bb.pluginId }).catch((e: unknown) => bb.log.warn(`reload failed: ${message(e)}`)); }, RELOAD_DELAY_MS);
  };

  const rpcHandlers = createRpcHandlers({ store, envs, library, runs, dispatch });
  const guarded = guard(rpcHandlers, () => ensurePrimary().catch(() => undefined), reloadWhenConfigured);
  bb.rpc.register(rpcContract, guarded);

  const cli = createCli({
    envs, library, runs, store, host, hostIdFor, dispatch,
    async requestRunForm(threadId, payload: RunFormPayload, signal): Promise<RunFormResult> {
      await ensurePrimary();
      const res = await bb.ui.requestInput({
        threadId, rendererId: "run", title: "Run playbook", payload: payload as unknown as JsonValue, timeoutMs: 30 * 60_000,
        presentation: { label: { pending: "Waiting for run confirmation", completed: "Run confirmed" } },
        describeSubmission: (v) => ({ title: `Ran ${payload.playbook} on ${payload.env.slug}${(v as { check?: boolean }).check ? " (check)" : ""}` }),
      }, { signal });
      return res.outcome === "submitted" ? { outcome: "submitted", value: res.value as unknown as RunFormValue } : { outcome: "cancelled", reason: res.reason };
    },
  });
  // Commands resolve hosts synchronously, so the primary host id is fetched (and retried) before each one runs.
  bb.cli.register({
    ...cli,
    async run(argv, ctx) {
      await ensurePrimary().catch((e: unknown) => bb.log.warn(`primary host unavailable: ${message(e)}`));
      return cli.run(argv, ctx);
    },
  });

  bb.background.service("runs", {
    async start(signal) {
      let resumed = false;
      while (!signal.aborted) {
        try {
          await ensurePrimary();
          if (!resumed) {
            await runs.resumeOpenRuns();
            resumed = true;
          }
          for (const run of store.listOpenRuns()) {
            await runs.reconcile(run.id).catch((e: unknown) => bb.log.warn(`reconcile ${run.id} failed: ${message(e)}`));
          }
        } catch (e) {
          bb.log.warn(`run reconcile tick failed: ${message(e)}`);
        }
        await sleepUnlessAborted(timing.reconcileMs, signal);
      }
    },
  });
  bb.background.schedule("prune", "23 3 * * *", async () => {
    const before = Date.now() - RETENTION_DAYS * DAY_MS;
    store.prune(before);
    try {
      const n = await pruneLogs(logRoot, before);
      if (n) bb.log.info(`pruned ${n} old run log(s)`);
    } catch (e) {
      bb.log.warn(`run log prune failed: ${message(e)}`);
    }
  });

  bb.events.on("experimental_thread.events", ({ thread }) => {
    void library.onThreadActivity(thread.id).catch((e: unknown) => bb.log.warn(`thread activity for ${thread.id} failed: ${message(e)}`));
  });
  // Investigation status follows the thread's lifecycle; unknown threads are ignored by the service.
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => dispatch.onThreadIdle(thread.id, lastAssistantText));
  bb.events.on("thread.failed", ({ thread }) => dispatch.onThreadFailed(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => dispatch.onThreadDeleted(thread.id));

  bb.onDispose(() => {
    clearTimeout(reloadTimer);
    library.dispose();
  });

  const count = envs.list().length;
  bb.log.info(count ? `${count} environment(s)` : "no environments yet; add one in the plugin settings");
}
