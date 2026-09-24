// bb-plugin-parakeet-stt -- backend entry.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { configureContract } from "./configure-contract.ts";
import { HistoryStore } from "./history.ts";
import { PrefsStore } from "./prefs.ts";
import { createRpcHandlers, hostConfigFrom } from "./rpc.ts";
import { rpcContract, SOUNDS } from "./schemas.ts";
import { createStreamRelay, type UpstreamSocket } from "./stream-relay.ts";
import { createSttClient, type SttClient } from "./stt-client.ts";

export { rpcContract } from "./schemas.ts";

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
  await prefs.load();
  const history = new HistoryStore(bb.storage.kv, () => prefs.get().historyLimit);

  bb.rpc.register(rpcContract, createRpcHandlers({
    client: () => client,
    configured: () => current.serverUrl.trim() !== "",
    prefs,
    history,
    now: Date.now,
  }));

  bb.http.experimental_websocket("/stream", createStreamRelay({
    config: () => ({ serverUrl: current.serverUrl, apiKey: current.apiKey ?? "" }),
    prefs: () => prefs.get(),
    connect: (url) => new WebSocket(url) as unknown as UpstreamSocket,
    log: (m) => bb.log.warn(m),
  }));
  bb.http.route("GET", "/prefs", () => Response.json(prefs.get()));

  bb.experimental_aiServices.register({ id: "parakeet", displayName: "Parakeet STT (self-hosted)", kinds: ["voice"] });
  const host = bb.hosts.experimental_client({ contract: configureContract });

  const pushHostConfig = async (signal?: AbortSignal) => {
    try {
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (!hostId) return;
      await host.call("stt.configure", hostConfigFrom({ serverUrl: current.serverUrl, apiKey: current.apiKey ?? "" }, prefs.get()), { hostId, signal });
    } catch (e) {
      bb.log.warn(`could not push config to host: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  settings.onChange((next) => {
    current = next;
    client = createSttClient({ serverUrl: next.serverUrl, apiKey: next.apiKey ?? "" });
    void pushHostConfig();
  });
  prefs.onChange((next, prev) => {
    if (next.customWords !== prev.customWords || next.removeFillers !== prev.removeFillers || next.correctionThreshold !== prev.correctionThreshold) {
      void pushHostConfig();
    }
  });
  host.experimental_onWorkerExit(() => void pushHostConfig());
  bb.background.service("host-config", {
    start: async (signal) => {
      await pushHostConfig(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
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
