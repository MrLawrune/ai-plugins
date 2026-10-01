// bb-plugin-kokoro-tts -- backend entry. Composes the modules in bb/.
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ClientRegistry } from "./clients.ts";
import { migrate } from "./coord/migrate.ts";
import { MediaPauser } from "./coord/pause.ts";
import { MuteStore, SettingsStore } from "./coord/settings.ts";
import { SpeechLogStore } from "./coord/speech-log.ts";
import { TurnCoordinator } from "./coord/turns.ts";
import { EngineChain } from "./engines/chain.ts";
import { createKokoroEngine } from "./engines/kokoro.ts";
import type { Engine } from "./engines/types.ts";
import { PlayerHub } from "./hub.ts";
import { createKokoroClient, isLoopback, portOf } from "./kokoro-client.ts";
import { LoadScope } from "./lifecycle.ts";
import { PrefsStore } from "./prefs.ts";
import { PREVIEW_ID_BASE, SOUNDS } from "./protocol.ts";
import { registerRpc } from "./rpc.ts";
import type { EngineRef, Settings } from "./schemas.ts";
import { VoiceScopes } from "./scopes.ts";
import { isNotFound, pruneScopes } from "./scopes-prune.ts";
import { ensureModels, loadModelManifest } from "./setup/models.ts";
import { dataDir, locatePluginRoot, pythonIn, venvDir } from "./setup/paths.ts";
import { spawnServer } from "./setup/process.ts";
import { findExecutable, findUv, syncRuntime } from "./setup/uv.ts";
import { Supervisor } from "./supervisor.ts";
import { errorText, sleep } from "./util.ts";
import { registerVoice } from "./voice.ts";

export { rpcContract } from "./contract.ts";

const DEFAULT_LOCAL_URL = "http://127.0.0.1:6789";
const PRUNE_EVERY_MS = 3_600_000;
/** Migration's provider switch: long enough for a model reload, short enough not to hold up loading. */
const MIGRATION_PATCH_MS = 8_000;

/** The local server's URL: the setting when it is loopback, else the default. */
const localOf = (serverUrl: string) => (isLoopback(serverUrl) ? serverUrl : DEFAULT_LOCAL_URL);

type Engines = Settings["engines"];

/** Whether an engine slot uses the plugin-managed local server. */
export const usesLocal = ({ main, backup }: Engines) => main === "local" || backup === "local";

/**
 * What an engines settings change needs: the chain forgets its breaker and
 * health on any change, but the local server (and its loaded model) restarts
 * only when it starts or stops being used.
 */
export function enginesChange(prev: Engines, next: Engines): { reset: boolean; restart: boolean } {
  return { reset: JSON.stringify(prev) !== JSON.stringify(next), restart: usesLocal(prev) !== usesLocal(next) };
}

export interface PluginOptions {
  /** For every request to a Kokoro server; tests pass a fake. */
  fetch?: typeof fetch;
  /** Timeout of migration's provider switch on the local server. */
  migrationPatchMs?: number;
}

export default createPlugin();

export function createPlugin(opts: PluginOptions = {}) {
  return (bb: BbPluginApi) => plugin(bb, opts);
}

async function plugin(bb: BbPluginApi, opts: PluginOptions) {
  const fetchImpl = opts.fetch;
  // Registered first so it runs last (hooks run LIFO): after hub, turns and pauser cleanup.
  const scope = new LoadScope();
  bb.onDispose(() => scope.dispose());
  const publish = (channel: string, payload: unknown) => bb.realtime.publish(channel, payload);

  const pluginSettings = bb.settings.define({
    serverUrl: {
      type: "string",
      label: "Local Kokoro server URL",
      description: "Where the plugin-managed Kokoro server listens.",
      default: DEFAULT_LOCAL_URL,
    },
  });
  const serverUrl = (await pluginSettings.get()).serverUrl;
  let localUrl = localOf(serverUrl);

  // Registered up front so status/config/prefs RPC keep working even if the
  // install below turns out to be broken (no server/ next to this file).
  const prefs = new PrefsStore(bb.storage.kv);
  await prefs.load();
  const scopes = new VoiceScopes(bb.storage.kv);
  await scopes.load();
  scopes.onChange((kind) => { if (kind === "settings") publish("kokoro-scopes", { changed: true }); });
  bb.background.service("scopes-prune", {
    start: (signal) => pruneScopes(scopes, async (threadId) => {
      try {
        await bb.sdk.threads.get({ threadId, signal });
        return true;
      } catch (cause) {
        return isNotFound(cause) ? false : null;
      }
    }, signal),
  });

  const settings = new SettingsStore(bb.storage.kv);
  const mute = new MuteStore(bb.storage.kv);
  await mute.load();
  if ((await settings.load()) === null) {
    // First load of this version: the speech settings come over from the Kokoro server.
    const result = await scope.track(migrate({
      serverUrl,
      rawPrefs: await bb.storage.kv.get<unknown>("prefs"),
      runtime: prefs.get().runtime,
      fetchConfig: async (base) => {
        try {
          const body = await createKokoroClient(base, fetchImpl).call<{ config?: unknown } | null>("GET", "/config");
          const config = body?.config;
          return config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      },
      readFile: (p) => {
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
      env: process.env,
      home: os.homedir(),
      setLocalProvider: async (provider) => {
        const patchMs = opts.migrationPatchMs ?? MIGRATION_PATCH_MS;
        await createKokoroClient(localUrl, fetchImpl, { default: 4_000, patch: patchMs }).call("PATCH", "/config", { provider });
      },
    }));
    await settings.replace(result.settings);
    if (result.note) await bb.storage.kv.set("migration-note", result.note);
  }

  const speechLog = new SpeechLogStore({
    db: () => bb.storage.database(),
    migrate: (db, statements) => bb.storage.migrate(db, statements),
    limits: () => settings.get().retention,
  });
  speechLog.init();

  /** One adapter per engine URL, so each keeps its connection reuse. */
  const engineCache = new Map<string, Engine>();
  const engineAt = (url: string): Engine => {
    let engine = engineCache.get(url);
    if (!engine) {
      engine = createKokoroEngine(url, fetchImpl);
      engineCache.set(url, engine);
    }
    return engine;
  };
  const engineFor = (ref: EngineRef) => engineAt(ref === "local" ? localUrl : ref.url);
  const engines = () => {
    const { main, backup } = settings.get().engines;
    return { main: engineFor(main), backup: backup ? engineFor(backup) : null, mainRef: main, backupRef: backup };
  };
  const chain = new EngineChain({ engines });

  const pauser = new MediaPauser();
  bb.onDispose(() => pauser.dispose());
  /** Entry keys whose speech paused other media; each end pairs with a start that went out. */
  const pausing = new Set<string>();

  const registry = new ClientRegistry();
  const hub: PlayerHub = new PlayerHub({
    registry,
    routing: () => prefs.get(),
    synthesize: (text, signal, opts, entryId) => {
      const s = settings.get();
      return chain.synthesize(text, {
        voice: opts?.voice ?? s.voice,
        speed: opts?.speed ?? s.speed,
        lang: opts?.lang ?? s.lang,
        trim: s.trim,
        leadInMs: s.lead_in_ms,
        gapMs: s.gap_ms,
        only: opts?.slot,
      }, signal, (_slot, url) => {
        if (entryId < PREVIEW_ID_BASE) speechLog.setEngine(entryId, url);
      });
    },
    log: (message) => bb.log.info(message),
    // Other media is only paused for a window on this computer, and only when the settings ask for it.
    speaking: ({ key, on, local }) => {
      if (on) {
        if (!local || settings.get().other_audio !== "pause") return;
        pausing.add(key);
        void pauser.start(key, "pause").catch((cause: unknown) => bb.log.warn(`pause: ${errorText(cause)}`));
      } else if (pausing.delete(key)) {
        void pauser.end(key).catch((cause: unknown) => bb.log.warn(`pause: ${errorText(cause)}`));
      }
    },
    reportStatus: async (id, status, extra, sessionId) => {
      if (id >= PREVIEW_ID_BASE) return;
      speechLog.setStatus(id, status, { first_audio_ms: extra?.firstAudioMs, error: extra?.error });
      // No engine could speak the reply: a cue says so, in the mode the reply was
      // routed with (an error mid-reply was already heard, and replays get none).
      if (status === "error" && extra?.errorCue && extra.errorCue !== "quiet" && !mute.get()) {
        hub.sound("error", settings.get().sound_volume, sessionId);
      }
    },
  });
  bb.onDispose(() => hub.dispose());
  // The hub's live replies are never stale, however long they wait or play.
  bb.background.service("log-prune", {
    async start(signal) {
      while (!signal.aborted) {
        speechLog.prune();
        speechLog.reconcile(hub.liveEntryIds());
        await sleep(PRUNE_EVERY_MS, signal);
      }
    },
  });
  bb.background.service("player-keepalive", {
    async start(signal) {
      while (!signal.aborted) {
        await sleep(25_000, signal);
        hub.pingAll();
      }
    },
  });

  const turns = new TurnCoordinator({
    settings: () => settings.get(),
    muted: () => mute.get(),
    log: speechLog,
    hub,
    publish,
    warn: (message) => bb.log.warn(message),
  });
  bb.onDispose(() => turns.dispose());

  let supervisor: Supervisor | null = null;
  prefs.onChange((next, prev) => {
    if (next.playOn !== prev.playOn || next.pinnedDevice !== prev.pinnedDevice) hub.routingChanged();
    if (next.runtime !== prev.runtime || next.manageServer !== prev.manageServer) supervisor?.restart();
  });
  prefs.onChange((next) => publish("kokoro-prefs", next));
  settings.onChange((next, prev) => {
    // The new settings are already saved; a failure here must not fail the patch.
    try {
      const r = next.retention;
      if (r.maxAgeDays !== prev.retention.maxAgeDays || r.maxEntries !== prev.retention.maxEntries) speechLog.prune();
      const change = enginesChange(prev.engines, next.engines);
      if (change.reset) chain.reset();
      if (change.restart) supervisor?.restart();
    } catch (cause) {
      bb.log.warn(`settings change: ${errorText(cause)}`);
    }
  });
  pluginSettings.onChange((next) => {
    localUrl = localOf(next.serverUrl);
    chain.reset();
    supervisor?.restart();
  });

  registerRpc(bb, {
    settings,
    mute,
    speechLog,
    chain,
    engines,
    localUrl: () => localUrl,
    fetch: fetchImpl,
    scope,
    turns,
    supervisor: () => supervisor,
    prefs,
    hub,
    log: bb.log,
    publish,
    scopes,
    threadParent: async (threadId) => (await bb.sdk.threads.get({ threadId })).parentThreadId,
    threadExists: async (threadId) => {
      try {
        await bb.sdk.threads.get({ threadId, signal: scope.signal });
        return true;
      } catch (cause) {
        // Only a thread known to be gone is refused; a failed lookup does not block a replay.
        return !isNotFound(cause);
      }
    },
    kv: bb.storage.kv,
  });

  const root = locatePluginRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!root) {
    bb.log.error(`plugin files incomplete: no server/ next to ${fileURLToPath(import.meta.url)}`);
    return;
  }
  const readText = (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

  const serverDir = path.join(root, "server");
  const modelDir = dataDir();
  const manifest = loadModelManifest(serverDir);
  const modelPath = path.join(modelDir, manifest.find((f) => f.name.endsWith(".onnx"))!.name);
  const voicesPath = path.join(modelDir, manifest.find((f) => f.name.endsWith(".bin"))!.name);
  const localClient = () => createKokoroClient(localUrl, fetchImpl);

  const sup = new Supervisor({
    needed: () => usesLocal(settings.get().engines),
    health: async () => {
      try {
        return (await engineAt(localUrl).health(scope.signal)).reachable;
      } catch {
        return false;
      }
    },
    prefs: () => prefs.get(),
    serverUrl: () => localUrl,
    findUv: () => findUv(),
    ensureModels: (onProgress, signal) => ensureModels(modelDir, manifest, { onProgress, signal }),
    syncRuntime: (uv, runtime, signal) => syncRuntime(uv, serverDir, runtime, venvDir(runtime, modelDir), signal),
    spawnServer: ({ runtime, headless }) =>
      spawnServer({
        python: pythonIn(venvDir(runtime, modelDir)),
        serverDir, modelPath, voicesPath, port: portOf(localUrl), headless,
        log: (line) => bb.log.info(`[server] ${line}`),
      }),
    gpuAvailable: () => findExecutable("nvidia-smi") !== null,
    engineProvider: async () => {
      const r = await localClient().call<{ config: { provider: string }; providers_available: { cuda?: boolean } }>("GET", "/config");
      return { provider: r.config.provider, cudaAvailable: r.providers_available.cuda === true };
    },
    setProvider: async (provider) => { await localClient().call("PATCH", "/config", { provider }); },
    sleep,
    now: Date.now,
  });
  supervisor = sup;
  bb.background.service("server", { start: (signal) => sup.start(signal) });

  bb.http.experimental_websocket("/player", (ctx) => {
    const local = isLocalRequest(ctx.url, ctx.headers);
    return {
      onOpen: (socket) => {
        hub.markLocal(socket, local);
        bb.log.info(`player window connected: ${local ? "on this computer" : "on another device"}`);
      },
      onMessage: (socket, data) => hub.onMessage(socket, data),
      onClose: (socket) => hub.onClose(socket),
    };
  });
  for (const sound of SOUNDS) {
    bb.http.route("GET", `/sound/${sound}`, () => {
      const wav = fs.readFileSync(path.join(root, "assets", `${sound}.wav`));
      return new Response(wav, { headers: { "content-type": "audio/wav", "cache-control": "max-age=86400" } });
    });
  }
  registerVoice(bb, {
    turns,
    hub,
    settings: () => settings.get(),
    scopes,
    publish,
    contract: readText(path.join(root, "contract", "tts-contract.md")),
    contractFull: readText(path.join(root, "contract", "tts-contract-full.md")),
  });
}

/** Addresses of this computer, for telling a window here from one on another device. */
export function localAddresses(): Set<string> {
  const out = new Set<string>(["127.0.0.1", "::1"]);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) out.add(a.address);
  return out;
}

/**
 * Whether a player socket comes from a browser on this computer. bb may sit
 * behind a reverse proxy (even for the desktop), so the client is the first
 * X-Forwarded-For hop when present, else the host the socket reached.
 */
export function isLocalRequest(url: URL, headers: Headers, ours: Set<string> = localAddresses()): boolean {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const client = (forwarded || url.hostname).replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  return client === "localhost" || /^127\./.test(client) || ours.has(client);
}
