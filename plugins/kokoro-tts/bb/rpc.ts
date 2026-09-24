import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { KokoroClient } from "./kokoro-client.ts";
import type { PlayerHub } from "./hub.ts";
import type { PrefsStore } from "./prefs.ts";
import { rpcContract, type ConfigResponse, type Health } from "./schemas.ts";
import { installUv } from "./setup/uv.ts";
import type { Supervisor } from "./supervisor.ts";

export interface RpcDeps {
  client: () => KokoroClient;
  /** Null when the plugin install is broken (no server/ found): health/config RPC still work. */
  supervisor: () => Supervisor | null;
  prefs: PrefsStore;
  hub: Pick<PlayerHub, "clients" | "stop">;
  log: BbPluginApi["log"];
}

const brokenInstallStatus = {
  state: "error" as const,
  detail: "plugin files incomplete: server/ not found",
  progress: null,
  fixCommand: null,
  headless: null,
  gpuAvailable: false,
};

/** A short, single-paragraph summary of a failed installer run for the Server card. */
export function installerFailure(code: number, output: string): string {
  const tail = output.trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" ");
  const clipped = tail.length > 300 ? `…${tail.slice(-300)}` : tail;
  return `the installer exited with code ${code}${clipped ? ` (${clipped})` : ""}.`;
}

export function registerRpc(bb: BbPluginApi, deps: RpcDeps): void {
  const call = <T>(...a: Parameters<KokoroClient["call"]>) => deps.client().call<T>(...a);
  let installing = false;
  bb.rpc.register(rpcContract, {
    async health() {
      try {
        return { up: true as const, health: await call<Health>("GET", "/health") };
      } catch (cause) {
        return { up: false as const, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    getConfig: () => call<ConfigResponse>("GET", "/config"),
    patchConfig: (patch) => call<ConfigResponse>("PATCH", "/config", patch),
    listVoices: () => call("GET", "/voices"),
    listDevices: () => call("GET", "/devices"),
    preview: (input) => call("POST", "/preview", { ...input, session_id: "preview" }),
    playSound: ({ sound }) => call("POST", "/play-sound", { sound, session_id: "bb-preview" }),
    setMuted: async ({ muted }) => {
      // Muting silences browser playback too, not just the server's speaker.
      if (muted) deps.hub.stop(null);
      return { muted: (await call<{ muted: boolean }>("POST", "/mute", { muted })).muted };
    },
    interruptAll: () => {
      deps.hub.stop(null);
      return call("POST", "/interrupt-all", {});
    },
    engine: () => call("GET", "/engine"),
    speechLog: () => call("GET", "/speech-log?limit=300"),
    setupStatus: () => deps.supervisor()?.status() ?? brokenInstallStatus,
    installUv: async () => {
      if (installing) return { started: false };
      installing = true;
      void installUv(AbortSignal.timeout(300_000))
        .then((r) => {
          deps.log.info(`uv installer exited ${r.code}: ${r.output.slice(-400)}`);
          if (r.code === 0) deps.supervisor()?.uvInstalled();
          else deps.supervisor()?.uvInstallFailed(installerFailure(r.code, r.output));
        })
        .finally(() => { installing = false; });
      return { started: true };
    },
    getPrefs: () => deps.prefs.get(),
    setPrefs: (patch) => deps.prefs.update(patch),
    listClients: () => ({ clients: deps.hub.clients() }),
  });
}
