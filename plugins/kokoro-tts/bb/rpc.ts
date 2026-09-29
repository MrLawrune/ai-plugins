import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ConfigCache } from "./config-cache.ts";
import { ServerError, type KokoroClient } from "./kokoro-client.ts";
import type { PlayerHub } from "./hub.ts";
import { PREVIEW_ID_BASE } from "./protocol.ts";
import type { PrefsStore } from "./prefs.ts";
import {
  replayResultSchema, rpcContract, type ConfigResponse, type Health, type HealthResult, type VoiceScopeState,
} from "./schemas.ts";
import { resolveVoice, type VoiceScopes } from "./scopes.ts";
import { installUv } from "./setup/uv.ts";
import type { Supervisor } from "./supervisor.ts";

export interface RpcDeps {
  client: () => KokoroClient;
  /** Null when the plugin install is broken (no server/ found): status/config RPC still work. */
  supervisor: () => Supervisor | null;
  prefs: PrefsStore;
  config: ConfigCache;
  hub: Pick<PlayerHub, "clients" | "stop" | "speak" | "sound" | "hasReadyClient">;
  log: BbPluginApi["log"];
  publish: (channel: string, payload: unknown) => void;
  scopes: Pick<VoiceScopes, "get" | "set" | "learnParent" | "parentOf">;
  /** A thread's parent, null for a root; rejects when the lookup fails. */
  threadParent: (threadId: string) => Promise<string | null | undefined>;
}

/** Same sample sentence as the Python server's PREVIEW_TEXT. */
export const PREVIEW_TEXT = "This is how I will sound when reading your updates.";
let previewSeq = 0;
const nextPreviewId = () => PREVIEW_ID_BASE + (previewSeq++ % 0x0fff_ffff);

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
  const health = async (): Promise<HealthResult> => {
    try {
      return { up: true as const, health: await call<Health>("GET", "/health") };
    } catch (cause) {
      return { up: false as const, error: cause instanceof Error ? cause.message : String(cause) };
    }
  };
  /** Threads looked up and found to be roots, so they are not looked up again. */
  const roots = new Set<string>();
  const voiceScope = async ({ threadId, projectId }: { threadId: string; projectId: string }): Promise<VoiceScopeState> => {
    if (deps.scopes.parentOf(threadId) === undefined && !roots.has(threadId)) {
      try {
        const parent = await deps.threadParent(threadId);
        if (parent) await deps.scopes.learnParent(threadId, parent);
        else roots.add(threadId);
      } catch {
        // resolve as a root this time and look it up again next time
      }
    }
    const data = deps.scopes.get();
    // The cache only: this never waits on the Kokoro server.
    const cached = deps.config.get()?.config.mode ?? null;
    const own = data.threads[threadId] ?? {};
    const withoutOwn = { ...data, threads: { ...data.threads } };
    delete withoutOwn.threads[threadId];
    return {
      thread: own,
      project: data.projects[projectId] ?? {},
      globalMode: cached ?? "brief",
      effective: resolveVoice(data, cached, threadId, projectId),
      inherited: resolveVoice(withoutOwn, cached, threadId, projectId),
      parentThreadId: deps.scopes.parentOf(threadId) ?? null,
    };
  };
  bb.rpc.register(rpcContract, {
    status: async () => ({
      health: await health(),
      setup: deps.supervisor()?.status() ?? brokenInstallStatus,
      clients: deps.hub.clients(),
    }),
    getConfig: () => deps.config.refresh(),
    patchConfig: async (patch) => {
      const next = await call<ConfigResponse>("PATCH", "/config", patch);
      deps.config.set(next);
      deps.publish("kokoro-config", next);
      return next;
    },
    listVoices: () => call("GET", "/voices"),
    listDevices: () => call("GET", "/devices"),
    // Previews and sound tests play where replies play: in a browser window
    // when browser playback is selected, else on the server's speakers.
    preview: async (input) => {
      if (deps.prefs.get().playback === "client") {
        if (!deps.hub.hasReadyClient()) return { status: "no_window" };
        const { config } = await deps.config.current();
        const { text, speech_gain, ...opts } = input;
        deps.hub.speak(nextPreviewId(), text?.trim() || PREVIEW_TEXT, "preview", speech_gain ?? config.speech_gain, opts);
        return { status: "playing" };
      }
      return call("POST", "/preview", { ...input, session_id: "preview" });
    },
    playSound: async ({ sound }) => {
      if (deps.prefs.get().playback === "client") {
        if (!deps.hub.hasReadyClient()) return { status: "no_window" };
        const { config } = await deps.config.current();
        deps.hub.sound(sound, config.sound_volume, "bb-preview");
        return { status: "playing" };
      }
      return call("POST", "/play-sound", { sound, session_id: "bb-preview" });
    },
    // Replay plays where replies play, like previews, and is logged under the
    // thread so the chat card follows it.
    replay: async ({ threadId, text }) => {
      const browser = deps.prefs.get().playback === "client";
      if (browser && !deps.hub.hasReadyClient()) return { status: "no_window" };
      let raw: unknown;
      try {
        raw = await call("POST", "/replay", { text, session_id: threadId, playback: browser ? "client" : "server" });
      } catch (cause) {
        if (cause instanceof ServerError && cause.status === 404) return { status: "unsupported" };
        throw cause;
      }
      const r = replayResultSchema.parse(raw);
      if (!browser) return { status: r.status ?? "playing" };
      if (r.entry_id === undefined || !r.text) return { status: r.status ?? "empty_after_strip" };
      deps.hub.speak(r.entry_id, r.text, threadId, r.speech_gain ?? 1);
      return { status: "playing" };
    },
    setMuted: async ({ muted }) => {
      // Muting silences browser playback too, not just the server's speaker.
      if (muted) deps.hub.stop(null);
      const next = (await call<{ muted: boolean }>("POST", "/mute", { muted })).muted;
      deps.config.setMuted(next);
      return { muted: next };
    },
    interruptAll: () => {
      deps.hub.stop(null);
      return call("POST", "/interrupt-all", {});
    },
    stop: ({ threadId }) => {
      deps.hub.stop(threadId);
      return call("POST", "/interrupt", { session_id: threadId });
    },
    speechLog: ({ threadId }) => call("GET", `/speech-log?session_id=${encodeURIComponent(threadId)}`),
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
    getVoiceScope: voiceScope,
    setVoiceScope: async ({ threadId, projectId, scope, patch }) => {
      await deps.scopes.set(scope, scope === "thread" ? threadId : projectId, patch);
      return voiceScope({ threadId, projectId });
    },
  });
}
