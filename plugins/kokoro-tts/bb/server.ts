// bb-plugin-kokoro-tts -- backend entry. Composes the modules in bb/.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ClientRegistry } from "./clients.ts";
import { PlayerHub } from "./hub.ts";
import { createKokoroClient, portOf, type KokoroClient } from "./kokoro-client.ts";
import { PrefsStore } from "./prefs.ts";
import { SOUNDS } from "./protocol.ts";
import type { ConfigResponse } from "./schemas.ts";
import { registerRpc } from "./rpc.ts";
import { ensureModels, loadModelManifest } from "./setup/models.ts";
import { dataDir, locatePluginRoot, pythonIn, venvDir } from "./setup/paths.ts";
import { spawnServer } from "./setup/process.ts";
import { findExecutable, findUv, probeAudio, syncRuntime } from "./setup/uv.ts";
import { Supervisor } from "./supervisor.ts";
import { sleep } from "./util.ts";
import { registerVoice } from "./voice.ts";

export { rpcContract } from "./schemas.ts";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    serverUrl: {
      type: "string",
      label: "Kokoro server URL",
      description: "Where the Kokoro TTS server listens. A non-local URL is used as-is and never managed.",
      default: "http://127.0.0.1:6789",
    },
  });
  let client: KokoroClient = createKokoroClient((await settings.get()).serverUrl);

  // Registered up front so health/config/prefs RPC keep working even if the
  // install below turns out to be broken (no server/ next to this file).
  const prefs = new PrefsStore(bb.storage.kv);
  await prefs.load();
  const registry = new ClientRegistry();
  const hub = new PlayerHub({
    registry,
    routing: () => prefs.get(),
    synthesize: (text, signal) => client.synthesize(text, signal),
    reportStatus: async (id, status, extra) => {
      await client.call("POST", "/speech-log/status", {
        id, status, first_audio_ms: extra?.firstAudioMs, error: extra?.error,
      });
    },
  });
  bb.onDispose(() => hub.dispose());

  let supervisor: Supervisor | null = null;
  let serverUrl = (await settings.get()).serverUrl;
  settings.onChange((next) => {
    client = createKokoroClient(next.serverUrl);
    serverUrl = next.serverUrl;
    supervisor?.restart();
  });
  bb.log.info(`proxying to ${client.baseUrl}`);
  registerRpc(bb, { client: () => client, supervisor: () => supervisor, prefs, hub, log: bb.log });

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
      const r = await client.call<ConfigResponse>("GET", "/config");
      return { provider: r.config.provider, cudaAvailable: r.providers_available.cuda === true };
    },
    setProvider: async (provider) => { await client.call("PATCH", "/config", { provider }); },
    sleep,
    now: Date.now,
  });
  supervisor = sup;
  bb.background.service("server", { start: (signal) => sup.start(signal) });
  prefs.onChange((next, prev) => {
    if (next.runtime !== prev.runtime || next.manageServer !== prev.manageServer) sup.restart();
  });

  bb.http.experimental_websocket("/player", () => ({
    onMessage: (socket, data) => hub.onMessage(socket, data),
    onClose: (socket) => hub.onClose(socket),
  }));
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
    contract: readText(path.join(root, "hooks", "context", "tts-contract.md")),
  });
}
