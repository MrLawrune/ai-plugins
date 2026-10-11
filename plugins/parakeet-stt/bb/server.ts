// bb-plugin-parakeet-stt -- backend entry.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createAiService } from "./ai-service.ts";
import { DictationLog } from "./dictation-log.ts";
import { migrate } from "./migrate.ts";
import { PrefsStore } from "./prefs.ts";
import { createRpcHandlers } from "./rpc.ts";
import { rpcContract } from "./contract.ts";
import { SOUNDS } from "./schemas.ts";
import { createStreamRelay, type UpstreamSocket } from "./stream-relay.ts";
import { createSttClient, type SttClient } from "./stt-client.ts";

const PRUNE_EVERY_MS = 3_600_000;
/** The schema maxima for the history limits. */
const HISTORY_MAX_ENTRIES = 1000;
const HISTORY_MAX_AGE_DAYS = 90;

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
  const settings = bb.settings.define({
    serverUrl: {
      type: "string",
      label: "Parakeet server URL",
      description: "Base URL of the Parakeet STT server, e.g. https://stt.example.com",
      default: "",
    },
    apiKey: { type: "string", label: "API key", secret: true },
  });
  let current = await settings.get();
  let client: SttClient = createSttClient({ serverUrl: current.serverUrl, apiKey: current.apiKey ?? "" });

  const prefs = new PrefsStore(bb.storage.kv);
  // Until the prefs are loaded the log must not prune to the default limits (the stored ones may be larger).
  let prefsLoaded = false;
  const log = new DictationLog({
    db: () => bb.storage.database(),
    migrate: (db, s) => bb.storage.migrate(db, s),
    limits: () => (prefsLoaded
      ? { maxEntries: prefs.get().historyMaxEntries, maxAgeDays: prefs.get().historyMaxAgeDays }
      : { maxEntries: HISTORY_MAX_ENTRIES, maxAgeDays: HISTORY_MAX_AGE_DAYS }),
    now: Date.now,
    warn: (m) => bb.log.warn(m),
  });
  log.init();
  await migrate({ kv: bb.storage.kv, log, warn: (m) => bb.log.warn(m) });
  await prefs.load();
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
    client: () => client,
    configured: () => current.serverUrl.trim() !== "",
    prefs,
    history: log,
    kv: bb.storage.kv,
    now: Date.now,
  }));

  bb.http.experimental_websocket("/stream", createStreamRelay({
    config: () => ({ serverUrl: current.serverUrl, apiKey: current.apiKey ?? "" }),
    prefs: (device) => prefs.forDevice(device),
    connect: (url) => new WebSocket(url) as unknown as UpstreamSocket,
    log: (m) => bb.log.warn(m),
    onSession: (s) => log.add({ ...s, source: "stream" }),
    now: Date.now,
  }));
  bb.http.route("GET", "/prefs", (c) => Response.json(prefs.forDevice(c.req.query("device"))));

  bb.experimental_aiServices.register(createAiService({
    client: () => client,
    configured: () => current.serverUrl.trim() !== "",
    prefs,
    log,
    now: Date.now,
  }));

  settings.onChange((next) => {
    current = next;
    client = createSttClient({ serverUrl: next.serverUrl, apiKey: next.apiKey ?? "" });
  });

  const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
  for (const sound of SOUNDS) {
    bb.http.route("GET", `/sound/${sound}`, () => {
      const wav = fs.readFileSync(path.join(assets, `${sound}.wav`));
      return new Response(wav, { headers: { "content-type": "audio/wav", "cache-control": "max-age=86400" } });
    });
  }
  bb.log.info(current.serverUrl ? `using ${current.serverUrl}` : "serverUrl not set; configure it in the plugin settings");
}
