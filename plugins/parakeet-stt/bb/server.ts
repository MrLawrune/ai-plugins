// bb-plugin-parakeet-stt -- backend entry.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createAiService } from "./ai-service.ts";
import { DictationLog } from "./dictation-log.ts";
import { LoadScope } from "./lifecycle.ts";
import { migrate } from "./migrate.ts";
import { PrefsStore } from "./prefs.ts";
import { createRpcHandlers, type Latency } from "./rpc.ts";
import { createServerConfig } from "./server-config.ts";
import { rpcContract } from "./contract.ts";
import { HISTORY_MAX_AGE_DAYS, HISTORY_MAX_ENTRIES, SOUNDS } from "./schemas.ts";
import { createStreamRelay, type UpstreamSocket } from "./stream-relay.ts";

const PRUNE_EVERY_MS = 3_600_000;
const NEEDS_URL_MESSAGE = "Set the Parakeet server URL in Settings → Plugins → Parakeet STT";
const MAX_SESSIONS = 4;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export { rpcContract } from "./contract.ts";

export default async function plugin(bb: BbPluginApi) {
  // Registered first, so it runs last: everything that holds the scope's signal is stopped by then.
  const scope = new LoadScope();
  bb.onDispose(() => scope.dispose());

  const settings = bb.settings.define({
    serverUrl: {
      type: "string",
      label: "Parakeet server URL",
      description: "Base URL of the Parakeet STT server, e.g. https://stt.example.com",
      default: "",
    },
    apiKey: { type: "string", label: "API key", secret: true },
  });
  const server = createServerConfig(await settings.get());
  // Saving settings does not reload the plugin, so this status only clears on the next load.
  const needsConfiguration = !server.configured();
  if (needsConfiguration) bb.status.needsConfiguration(NEEDS_URL_MESSAGE);
  const latency: Latency = { ms: null };

  const prefs = new PrefsStore(bb.storage.kv);
  // Until the prefs are loaded the log must not prune to the default limits (the stored ones may be larger).
  let prefsLoaded = false;
  const log = new DictationLog({
    db: () => bb.storage.database(),
    migrate: (db, s) => bb.storage.migrate(db, s),
    recording: () => prefsLoaded && prefs.unreadable === null,
    limits: () => (prefsLoaded && prefs.unreadable === null
      ? { maxEntries: prefs.get().historyMaxEntries, maxAgeDays: prefs.get().historyMaxAgeDays }
      : { maxEntries: HISTORY_MAX_ENTRIES, maxAgeDays: HISTORY_MAX_AGE_DAYS }),
    now: Date.now,
    warn: (m) => bb.log.warn(m),
  });
  // Neither step may stop the plugin from loading: a failing history database leaves history
  // unavailable for this load, and unreadable settings leave read-only defaults.
  log.init();
  const migration = await migrate({ kv: bb.storage.kv, log, warn: (m) => bb.log.warn(m) });
  await prefs.load(migration.recovered);
  if (prefs.unreadable !== null) bb.log.warn(`stored settings could not be read, using read-only defaults: ${prefs.unreadable}`);
  prefsLoaded = true;
  log.prune();
  prefs.onChange(() => log.prune());
  bb.background.service("history-prune", {
    async start(signal) {
      while (!signal.aborted) {
        log.prune();
        await sleep(PRUNE_EVERY_MS, signal);
      }
    },
  });

  bb.rpc.register(rpcContract, createRpcHandlers({
    client: server.client,
    configured: server.configured,
    prefs,
    history: log,
    kv: bb.storage.kv,
    now: Date.now,
    server: {
      get: server.current,
      async set(values) {
        server.apply(await settings.experimental_set({
          ...(values.serverUrl !== undefined ? { serverUrl: values.serverUrl === "" ? null : values.serverUrl } : {}),
          ...(values.apiKey !== undefined ? { apiKey: values.apiKey } : {}),
        }));
      },
      needsConfiguration,
    },
    signal: scope.signal,
    track: (work) => scope.track(work),
    latency,
  }));

  const relay = createStreamRelay({
    config: () => ({ serverUrl: server.current().serverUrl, apiKey: server.current().apiKey ?? "" }),
    prefs: (device) => prefs.forDevice(device),
    connect: (url) => new WebSocket(url) as unknown as UpstreamSocket,
    log: (m) => bb.log.warn(m),
    onSession: (s) => log.add({ ...s, source: "stream" }),
    now: Date.now,
    maxSessions: MAX_SESSIONS,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    signal: scope.signal,
  });
  bb.onDispose(() => relay.closeAll());
  bb.http.experimental_websocket("/stream", relay.handler);
  bb.http.route("GET", "/prefs", (c) => Response.json(prefs.forDevice(c.req.query("device"))));

  bb.experimental_aiServices.register(createAiService({
    client: server.client,
    configured: server.configured,
    prefs,
    log,
    now: Date.now,
    scope,
    latency,
  }));

  settings.onChange(server.apply);

  const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
  for (const sound of SOUNDS) {
    bb.http.route("GET", `/sound/${sound}`, () => {
      const wav = fs.readFileSync(path.join(assets, `${sound}.wav`));
      return new Response(wav, { headers: { "content-type": "audio/wav", "cache-control": "max-age=86400" } });
    });
  }
  bb.log.info(server.current().serverUrl ? `using ${server.current().serverUrl}` : "serverUrl not set; configure it in the plugin settings");
}
