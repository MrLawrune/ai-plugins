// bb-plugin-kokoro-tts -- backend entry. Composes the modules in bb/.
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ClientRegistry } from "./clients.ts";
import { ConfigCache } from "./config-cache.ts";
import { PlayerHub } from "./hub.ts";
import { createKokoroClient, portOf, type KokoroClient } from "./kokoro-client.ts";
import { PrefsStore } from "./prefs.ts";
import { PREVIEW_ID_BASE, SOUNDS } from "./protocol.ts";
import type { ConfigResponse } from "./schemas.ts";
import { registerRpc } from "./rpc.ts";
import { VoiceScopes } from "./scopes.ts";
import { isNotFound, pruneScopes } from "./scopes-prune.ts";
import { ensureModels, loadModelManifest } from "./setup/models.ts";
import { dataDir, locatePluginRoot, pythonIn, venvDir } from "./setup/paths.ts";
import { spawnServer } from "./setup/process.ts";
import { findExecutable, findUv, probeAudio, syncRuntime } from "./setup/uv.ts";
import { Supervisor } from "./supervisor.ts";
import { sleep } from "./util.ts";
import { registerVoice } from "./voice.ts";

export { rpcContract } from "./contract.ts";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    serverUrl: {
      type: "string",
      label: "Kokoro server URL",
      description: "Where the Kokoro TTS server listens. A non-local URL is used as-is and never managed.",
      default: "http://127.0.0.1:6789",
    },
  });
  let serverUrl = (await settings.get()).serverUrl;
  let client: KokoroClient = createKokoroClient(serverUrl);
  const config = new ConfigCache(() => client.call<ConfigResponse>("GET", "/config"));
  bb.background.service("config-poll", { start: (signal) => config.poll(signal) });

  // Registered up front so status/config/prefs RPC keep working even if the
  // install below turns out to be broken (no server/ next to this file).
  const prefs = new PrefsStore(bb.storage.kv);
  await prefs.load();
  const scopes = new VoiceScopes(bb.storage.kv);
  await scopes.load();
  scopes.onChange((kind) => { if (kind === "settings") bb.realtime.publish("kokoro-scopes", { changed: true }); });
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
  const registry = new ClientRegistry();
  /** Entry keys whose speech asked the server to pause other media. */
  const pausing = new Set<string>();
  const hub = new PlayerHub({
    registry,
    routing: () => prefs.get(),
    synthesize: (text, signal, opts) => client.synthesize(text, signal, opts),
    log: (message) => bb.log.info(message),
    // Other media is only paused for a window on this computer, and only
    // when the config asks for it; each end pairs with a start that went out.
    speaking: ({ key, on, local }) => {
      if (on) {
        if (!local || config.get()?.config.other_audio === "keep") return;
        pausing.add(key);
      } else if (!pausing.delete(key)) {
        return;
      }
      void client.call("POST", "/other-audio", { action: on ? "start" : "end", key }).catch(() => undefined);
    },
    reportStatus: async (id, status, extra) => {
      if (id >= PREVIEW_ID_BASE) return;
      await client.call("POST", "/speech-log/status", {
        id, status, first_audio_ms: extra?.firstAudioMs, error: extra?.error,
      });
    },
  });
  bb.onDispose(() => hub.dispose());
  bb.background.service("player-keepalive", {
    async start(signal) {
      while (!signal.aborted) {
        await sleep(25_000, signal);
        hub.pingAll();
      }
    },
  });
  prefs.onChange((next, prev) => {
    if (next.playback !== prev.playback) {
      // Speech on the side just left would otherwise play on, out of reach of Stop.
      hub.stop(null);
      void client.call("POST", "/interrupt-all", {}).catch(() => undefined);
    }
    if (next.playOn !== prev.playOn || next.pinnedDevice !== prev.pinnedDevice || next.playback !== prev.playback) {
      hub.routingChanged();
    }
  });
  prefs.onChange((next) => bb.realtime.publish("kokoro-prefs", next));

  let supervisor: Supervisor | null = null;
  settings.onChange((next) => {
    client = createKokoroClient(next.serverUrl);
    serverUrl = next.serverUrl;
    // The old server's config and mute state no longer apply.
    config.clear();
    void config.refresh().catch(() => undefined);
    supervisor?.restart();
  });
  bb.log.info(`proxying to ${client.baseUrl}`);
  registerRpc(bb, { client: () => client, supervisor: () => supervisor, prefs, config, hub, log: bb.log,
    publish: (channel, payload) => bb.realtime.publish(channel, payload),
    scopes,
    threadParent: async (threadId) => (await bb.sdk.threads.get({ threadId })).parentThreadId,
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

  const sup = new Supervisor({
    health: async () => {
      try {
        await client.call("GET", "/health");
        return true;
      } catch {
        return false;
      }
    },
    prefs: () => prefs.get(),
    serverUrl: () => serverUrl,
    findUv: () => findUv(),
    ensureModels: (onProgress, signal) => ensureModels(modelDir, manifest, { onProgress, signal }),
    syncRuntime: (uv, runtime, signal) => syncRuntime(uv, serverDir, runtime, venvDir(runtime, modelDir), signal),
    probeAudio: (runtime, signal) => probeAudio(pythonIn(venvDir(runtime, modelDir)), signal),
    spawnServer: ({ runtime, headless }) =>
      spawnServer({
        python: pythonIn(venvDir(runtime, modelDir)),
        serverDir, modelPath, voicesPath, port: portOf(serverUrl), headless,
        log: (line) => bb.log.info(`[server] ${line}`),
      }),
    gpuAvailable: () => findExecutable("nvidia-smi") !== null,
    engineProvider: async () => {
      const r = await config.refresh();
      return { provider: r.config.provider, cudaAvailable: r.providers_available.cuda === true };
    },
    setProvider: async (provider) => { config.set(await client.call<ConfigResponse>("PATCH", "/config", { provider })); },
    sleep,
    now: Date.now,
  });
  supervisor = sup;
  bb.background.service("server", { start: (signal) => sup.start(signal) });
  prefs.onChange((next, prev) => {
    if (next.runtime !== prev.runtime || next.manageServer !== prev.manageServer) sup.restart();
  });

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
    client: () => client,
    hub,
    prefs,
    config,
    scopes,
    publish: (channel, payload) => bb.realtime.publish(channel, payload),
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
