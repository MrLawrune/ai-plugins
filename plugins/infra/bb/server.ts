// bb-plugin-infra — backend entry. Polls Proxmox environments, tracks agent activity, and serves
// the UI (RPC + realtime), agents (`bb infra`, pinned instructions), and @infra mentions.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANNELS, rpcContract, type EventsSignal } from "./schemas.ts";
import { Activity, type RawEvent } from "./server/activity.ts";
import { createCli } from "./server/cli.ts";
import { writeExport } from "./server/export.ts";
import { Hub } from "./server/hub.ts";
import { buildIndex, type MatchIndex } from "./server/matcher.ts";
import { createMention } from "./server/mention.ts";
import { Pins } from "./server/pins.ts";
import { ProxmoxProvider } from "./server/providers/proxmox/adapter.ts";
import { PveClient, PveError, type Auth } from "./server/providers/proxmox/client.ts";
import { probeCertificate, type TlsMode } from "./server/providers/proxmox/tls.ts";
import { createRpcHandlers } from "./server/rpc.ts";
import { Secrets } from "./server/secrets.ts";
import { badge, InfraService } from "./server/service.ts";
import { configurationGap } from "./server/setup-status.ts";
import { parseSshConfig } from "./server/ssh-config.ts";
import { MIGRATIONS, Store, webBaseFor, type ConnectionRow, type SqlDb } from "./server/store.ts";

export { rpcContract } from "./schemas.ts";

const RETENTION_MS = 14 * 86_400_000;
const SSH_CONFIG_REFRESH_MS = 5 * 60_000;
const INDEX_TTL_MS = 5_000;
const EXPORT_DEBOUNCE_MS = 5_000;
const METADATA_KEY = "infra";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function tlsFor(c: ConnectionRow): TlsMode {
  if (c.tlsMode === "pinned") return { mode: "pinned", fingerprint: c.tlsFingerprint };
  if (c.tlsMode === "ca") return { mode: "ca", caPem: c.caPem };
  return { mode: "insecure" };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    credentials: {
      type: "string",
      label: "Connection credentials",
      description: "Managed by the Environments section below. Stored as a BB secret; never shown.",
      secret: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = new Store(db as unknown as SqlDb);
  const secrets = new Secrets(settings);
  const pins = new Pins(store);
  pins.load();

  const clients = new Map<string, PveClient>();
  const closeClient = (id: string) => {
    const c = clients.get(id);
    clients.delete(id);
    if (c) void c.close().catch(() => undefined);
  };

  // Realtime: ids only, at most one "changed" per environment per second.
  const lastChanged = new Map<string, number>();
  const pendingChanged = new Map<string, ReturnType<typeof setTimeout>>();
  const publishChanged = (envId: string) => {
    if (pendingChanged.has(envId)) return;
    const wait = Math.max(0, (lastChanged.get(envId) ?? 0) + 1000 - Date.now());
    pendingChanged.set(envId, setTimeout(() => {
      pendingChanged.delete(envId);
      lastChanged.set(envId, Date.now());
      bb.realtime.publish(CHANNELS.changed, { envId });
    }, wait));
  };

  // Optional human-facing export of registry + rules.
  const exportTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastExport = new Map<string, string>();
  const scheduleExport = (envId: string) => {
    clearTimeout(exportTimers.get(envId));
    exportTimers.set(envId, setTimeout(() => {
      exportTimers.delete(envId);
      const env = store.getEnv(envId);
      if (!env?.exportDir.trim()) return;
      const registry = service.registry(env.slug);
      if (registry === null) return;
      const key = `${env.exportDir}\n${registry}\n${env.rules}`;
      if (lastExport.get(envId) === key) return;
      writeExport(env.exportDir, env.slug, registry, env.rules.trim() + "\n")
        .then(() => lastExport.set(envId, key))
        .catch((e: unknown) => bb.log.warn(`export for ${env.slug} failed: ${message(e)}`));
    }, EXPORT_DEBOUNCE_MS));
  };

  // Command → target matching index, rebuilt lazily.
  let sshAliases = new Map<string, string>();
  let index: MatchIndex | null = null;
  let indexAt = 0;
  let indexDirty = true;

  const hub: Hub = new Hub({
    store,
    now: Date.now,
    log: (m) => bb.log.warn(m),
    async providerFor(conn) {
      closeClient(conn.id);
      const secret = await secrets.get(conn.id);
      if (!secret) throw new PveError("auth-failed", "no credential saved", null);
      const auth: Auth = conn.authKind === "token"
        ? { kind: "token", tokenId: conn.username, secret }
        : { kind: "password", username: conn.username, password: secret };
      const client = new PveClient({ baseUrl: conn.baseUrl, auth, tls: tlsFor(conn) });
      clients.set(conn.id, client);
      return new ProxmoxProvider(client, webBaseFor(conn));
    },
    onSnapshot(envId) {
      indexDirty = true;
      publishChanged(envId);
      scheduleExport(envId);
    },
    onChange(events) {
      const correlated = activity.correlate(events);
      const payload: EventsSignal = {
        events: correlated.flatMap((e) => {
          const env = store.getEnv(e.envId);
          return env ? [{ env: badge(env), target: e.target, kind: e.kind, detail: e.detail, threadId: e.threadId ?? null }] : [];
        }),
      };
      if (payload.events.length) bb.realtime.publish(CHANNELS.events, payload);
    },
  });

  const currentIndex = (): MatchIndex => {
    if (!index || indexDirty || Date.now() - indexAt > INDEX_TTL_MS) {
      index = buildIndex(hub.snapshots(), sshAliases, hub.guestIps());
      indexAt = Date.now();
      indexDirty = false;
    }
    return index;
  };
  const loadSshAliases = async () => {
    try {
      sshAliases = parseSshConfig(await readFile(join(homedir(), ".ssh", "config"), "utf8"));
    } catch {
      sshAliases = new Map();
    }
    indexDirty = true;
  };
  await loadSshAliases();

  const activity: Activity = new Activity({
    store,
    now: Date.now,
    index: currentIndex,
    envIdForSlug: (slug) => store.getEnvBySlug(slug)?.id ?? null,
    events: { list: async (args) => (await bb.sdk.threads.events.list(args as never)) as unknown as RawEvent[] },
    onActivity: (threadIds) => bb.realtime.publish(CHANNELS.activity, { threadIds }),
  });

  // Setup status: BB shows "needs configuration" until an environment has a usable connection.
  // The flag clears only on the next load, so reload once setup becomes complete.
  const setupGap = async (): Promise<string | null> => {
    const conns = store.listConnections();
    const withSecret = new Set<string>();
    for (const c of conns) if (await secrets.has(c.id)) withSecret.add(c.id);
    return configurationGap(store.listEnvs(), conns, (id) => withSecret.has(id));
  };
  const initialGap = await setupGap();
  if (initialGap) bb.status.needsConfiguration(initialGap);
  let reloadScheduled = false;

  const service: InfraService = new InfraService({
    store, hub, activity, pins, secrets,
    now: Date.now,
    probe: (baseUrl) => probeCertificate(baseUrl),
    async onConfigChanged() {
      await hub.reload();
      indexDirty = true;
      for (const env of store.listEnvs()) { publishChanged(env.id); scheduleExport(env.id); }
      if (initialGap && !reloadScheduled && !(await setupGap())) {
        reloadScheduled = true;
        bb.log.info("setup complete; reloading to clear the needs-configuration status");
        setTimeout(() => { void bb.sdk.plugins.reload({ pluginId: bb.pluginId }).catch((e: unknown) => bb.log.warn(`reload failed: ${message(e)}`)); }, 1500);
      }
    },
  });

  await hub.reload();
  void service.warmConventions();

  bb.background.service("hub", { start: (signal) => hub.run(signal) });
  bb.background.service("ssh-config", {
    async start(signal) {
      while (!signal.aborted) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, SSH_CONFIG_REFRESH_MS);
          signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
        });
        if (!signal.aborted) await loadSshAliases();
      }
    },
  });
  bb.background.schedule("prune", "17 3 * * *", async () => { store.prune(Date.now() - RETENTION_MS); });

  const settle = (threadId: string) => { if (activity.clearRunning(threadId)) bb.realtime.publish(CHANNELS.activity, { threadIds: [threadId] }); };
  bb.events.on("thread.idle", ({ thread }) => settle(thread.id));
  bb.events.on("thread.failed", ({ thread }) => settle(thread.id));
  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (!hub.snapshots().length) return;
    activity.onThreadEvents(thread.id).catch((e: unknown) => bb.log.warn(`activity for ${thread.id} failed: ${message(e)}`));
  });

  bb.rpc.register(rpcContract, createRpcHandlers(service));
  bb.cli.register(createCli({
    service,
    pins,
    async threadExists(threadId) {
      try {
        await bb.sdk.threads.get({ threadId });
        return true;
      } catch {
        return false;
      }
    },
    async setThreadMetadata(threadId, value) {
      if (value) await bb.sdk.threads.updatePluginMetadata({ threadId, set: { [METADATA_KEY]: value } });
      else await bb.sdk.threads.updatePluginMetadata({ threadId, remove: [METADATA_KEY] }).catch(() => undefined);
    },
  }));
  bb.ui.registerMentionProvider(createMention(service));
  bb.agents.contributeInstructions(({ threadId }) => pins.instructions(threadId, (pin) => service.renderPin(pin)));

  bb.onDispose(() => {
    for (const t of [...pendingChanged.values(), ...exportTimers.values()]) clearTimeout(t);
    for (const id of [...clients.keys()]) closeClient(id);
  });

  const envs = store.listEnvs().length;
  bb.log.info(envs ? `watching ${envs} environment(s)` : "no environments yet; add one in the plugin settings");
}
