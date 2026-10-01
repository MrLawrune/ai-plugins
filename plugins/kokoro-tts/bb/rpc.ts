import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { LruSet } from "./coord/lru.ts";
import { pauseSupported } from "./coord/pause.ts";
import type { KvLike, MuteStore, SettingsStore } from "./coord/settings.ts";
import type { SpeechLogStore } from "./coord/speech-log.ts";
import type { TurnCoordinator } from "./coord/turns.ts";
import type { EngineChain, Slot } from "./engines/chain.ts";
import type { Engine, EngineHealth } from "./engines/types.ts";
import type { PlayerHub } from "./hub.ts";
import { createKokoroClient } from "./kokoro-client.ts";
import type { LoadScope } from "./lifecycle.ts";
import { PREVIEW_ID_BASE } from "./protocol.ts";
import type { PrefsStore } from "./prefs.ts";
import { rpcContract } from "./contract.ts";
import {
  availableSchema,
  restartSchema,
  runtimeInfoSchema,
  runtimePatchSchema,
  type ConfigResponse,
  type EngineRef,
  type EngineStatus,
  type HealthResult,
  type RuntimePatch,
  type SettingsPatch,
  type VoiceScopeState,
} from "./schemas.ts";
import { resolveVoice, type VoiceScopes } from "./scopes.ts";
import { installUv } from "./setup/uv.ts";
import type { Supervisor } from "./supervisor.ts";
import { errorText } from "./util.ts";

export interface RpcDeps {
  settings: SettingsStore;
  mute: MuteStore;
  speechLog: Pick<SpeechLogStore, "list" | "clear" | "latency">;
  chain: Pick<EngineChain, "noteHealth" | "breaker">;
  engines: () => { main: Engine; backup: Engine | null; mainRef: EngineRef; backupRef: EngineRef | null };
  /** The plugin-managed Kokoro server, for its engine-runtime /config. */
  localUrl: () => string;
  /** For the local server's /config; tests pass a fake. */
  fetch?: typeof fetch;
  /** This load's abort signal and the in-flight work disposal waits for. */
  scope: Pick<LoadScope, "signal" | "track">;
  turns: Pick<TurnCoordinator, "replay">;
  /** Null when the plugin install is broken (no server/ found): status/config RPC still work. */
  supervisor: () => Supervisor | null;
  prefs: PrefsStore;
  hub: Pick<PlayerHub, "clients" | "stop" | "stopAll" | "speak" | "sound" | "hasReadyClient">;
  log: BbPluginApi["log"];
  publish: (channel: string, payload: unknown) => void;
  scopes: Pick<VoiceScopes, "get" | "set" | "learnParent" | "parentOf">;
  /** A thread's parent, null for a root; rejects when the lookup fails. */
  threadParent: (threadId: string) => Promise<string | null | undefined>;
  /** False only when the thread is known to be gone. */
  threadExists: (threadId: string) => Promise<boolean>;
  kv: KvLike & { delete(key: string): Promise<void> };
}

/** Same sample sentence as the Python server's PREVIEW_TEXT. */
export const PREVIEW_TEXT = "This is how I will sound when reading your updates.";
let previewSeq = 0;
const nextPreviewId = () => PREVIEW_ID_BASE + (previewSeq++ % 0x0fff_ffff);

const MIGRATION_NOTE = "migration-note";
const HEALTH_TIMEOUT_MS = 5_000;
const VOICES_TIMEOUT_MS = 5_000;

const brokenInstallStatus = {
  state: "error" as const,
  detail: "plugin files incomplete: server/ not found",
  progress: null,
  fixCommand: null,
  headless: null,
  gpuAvailable: false,
};

/** The engine-runtime part of the local server's GET/PATCH /config body. */
const localConfigSchema = z.object({
  config: z.object({
    provider: z.string(),
    idle_unload_minutes: z.number(),
    intra_op_threads: z.number(),
    gpu_mem_limit_mb: z.number(),
  }),
  providers_available: availableSchema,
  restart_required: restartSchema,
  restart_command: z.string(),
});

/** The runtime block of getConfig, or null when the body is not a usable runtime. */
export function toRuntime(body: unknown): ConfigResponse["runtime"] {
  const parsed = localConfigSchema.safeParse(body);
  if (!parsed.success) return null;
  const { config: c, providers_available, restart_required, restart_command } = parsed.data;
  // The local engine forwarding to a remote one is the old setup; it synthesizes on the CPU otherwise.
  const provider = c.provider === "remote" ? "cpu" : c.provider;
  const runtime = runtimeInfoSchema.safeParse({
    config: { provider, idle_unload_minutes: c.idle_unload_minutes, intra_op_threads: c.intra_op_threads, gpu_mem_limit_mb: c.gpu_mem_limit_mb },
    providers_available, restart_required, restart_command,
  });
  return runtime.success ? runtime.data : null;
}

/** An engine's health as the page shows it. */
function healthResult(h: EngineHealth): HealthResult {
  return h.reachable
    ? { up: true, health: { status: "ok", version: h.version, model: "", active_sessions: 0 } }
    : { up: false, error: h.error ?? "unreachable" };
}

/** A short, single-paragraph summary of a failed installer run for the Server card. */
export function installerFailure(code: number, output: string): string {
  const tail = output.trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" ");
  const clipped = tail.length > 300 ? `…${tail.slice(-300)}` : tail;
  return `the installer exited with code ${code}${clipped ? ` (${clipped})` : ""}.`;
}

export function registerRpc(bb: BbPluginApi, deps: RpcDeps): void {
  const { scope } = deps;
  let installing = false;
  /** This load's signal, cut off after `ms` too. */
  const within = (ms: number) => AbortSignal.any([scope.signal, AbortSignal.timeout(ms)]);
  const local = () => createKokoroClient(deps.localUrl(), deps.fetch);
  const usesLocal = () => {
    const { engines } = deps.settings.get();
    return engines.main === "local" || engines.backup === "local";
  };
  const localRuntime = async (): Promise<ConfigResponse["runtime"]> => {
    try {
      return toRuntime(await local().call("GET", "/config"));
    } catch {
      return null;
    }
  };
  const configResponse = async (runtime?: ConfigResponse["runtime"]): Promise<ConfigResponse> => ({
    config: deps.settings.get(),
    muted: deps.mute.get(),
    pause_other_audio_supported: pauseSupported(),
    runtime: runtime !== undefined ? runtime : usesLocal() ? await localRuntime() : null,
    note: (await deps.kv.get<string>(MIGRATION_NOTE)) ?? null,
  });
  const getConfig = (runtime?: ConfigResponse["runtime"]) => scope.track(configResponse(runtime));
  const probe = async (slot: Slot, engine: Engine): Promise<EngineHealth> => {
    let h: EngineHealth;
    try {
      h = await engine.health(within(HEALTH_TIMEOUT_MS));
    } catch (cause) {
      h = { reachable: false, loaded: null, version: null, forwards: null, error: errorText(cause) };
    }
    deps.chain.noteHealth(slot, h);
    return h;
  };
  const status = async () => {
    const { main, backup, mainRef, backupRef } = deps.engines();
    const [mainHealth, backupHealth] = await Promise.all([probe("main", main), backup ? probe("backup", backup) : null]);
    const engines: EngineStatus[] = [{
      slot: "main", url: main.url, local: mainRef === "local", health: healthResult(mainHealth), breaker: deps.chain.breaker().state,
    }];
    if (backup && backupHealth) {
      engines.push({ slot: "backup", url: backup.url, local: backupRef === "local", health: healthResult(backupHealth), breaker: "closed" });
    }
    return {
      health: engines[0].health,
      engines,
      setup: deps.supervisor()?.status() ?? brokenInstallStatus,
      clients: deps.hub.clients(),
      muted: deps.mute.get(),
      latency: deps.speechLog.latency(),
    };
  };
  const patchConfig = async (patch: SettingsPatch | RuntimePatch): Promise<ConfigResponse> => {
    const keys = Object.keys(patch);
    if (keys.length === 0) return getConfig();
    const runtimeKeys = keys.filter((k) => k in runtimePatchSchema.shape);
    if (runtimeKeys.length > 0 && runtimeKeys.length < keys.length) {
      throw new Error("a patch changes speech settings or the engine runtime, not both");
    }
    let next: ConfigResponse;
    if (runtimeKeys.length > 0) {
      const body = await scope.track(local().call("PATCH", "/config", runtimePatchSchema.parse(patch)));
      next = await getConfig(toRuntime(body));
    } else {
      await deps.settings.update(patch as SettingsPatch);
      next = await getConfig();
    }
    deps.publish("kokoro-config", next);
    return next;
  };
  const listVoices = async () => {
    const { main, backup } = deps.engines();
    try {
      return { voices: await main.voices(within(VOICES_TIMEOUT_MS)) };
    } catch (cause) {
      if (!backup) throw cause;
      return { voices: await backup.voices(within(VOICES_TIMEOUT_MS)) };
    }
  };
  /** Threads looked up and found to be roots, so they are not looked up again. */
  const roots = new LruSet<string>(2000);
  const voiceScope = async ({ threadId, projectId }: { threadId: string; projectId: string }): Promise<VoiceScopeState> => {
    if (deps.scopes.parentOf(threadId) === undefined && !roots.has(threadId)) {
      try {
        const parent = await deps.threadParent(threadId);
        if (parent) await deps.scopes.learnParent(threadId, parent);
        else roots.add(threadId);
      } catch (cause) {
        // resolve as a root this time and look it up again next time
        deps.log.warn(`voice scope: parent lookup for thread ${threadId} failed: ${errorText(cause)}`);
      }
    }
    const data = deps.scopes.get();
    const mode = deps.settings.get().mode;
    const own = data.threads[threadId] ?? {};
    const withoutOwn = { ...data, threads: { ...data.threads } };
    delete withoutOwn.threads[threadId];
    return {
      thread: own,
      project: data.projects[projectId] ?? {},
      globalMode: mode,
      effective: resolveVoice(data, mode, threadId, projectId),
      inherited: resolveVoice(withoutOwn, mode, threadId, projectId),
      parentThreadId: deps.scopes.parentOf(threadId) ?? null,
    };
  };
  bb.rpc.register(rpcContract, {
    status: () => scope.track(status()),
    getConfig: () => getConfig(),
    patchConfig,
    listVoices,
    // Previews use one engine (main unless asked), never failing over, so each slot can be heard.
    preview: async (input) => {
      if (!deps.hub.hasReadyClient()) return { status: "no_window" };
      const s = deps.settings.get();
      deps.hub.speak(nextPreviewId(), input.text?.trim() || PREVIEW_TEXT, "preview", input.speech_gain ?? s.speech_gain, {
        voice: input.voice, speed: input.speed, lang: input.lang, slot: input.slot ?? "main",
      });
      return { status: "playing" };
    },
    playSound: async ({ sound }) => {
      if (!deps.hub.hasReadyClient()) return { status: "no_window" };
      deps.hub.sound(sound, deps.settings.get().sound_volume, "bb-preview");
      return { status: "playing" };
    },
    // Logged under the thread so its chat card follows it; a deleted thread gets no new rows.
    replay: async ({ threadId, text }) => {
      if (!(await deps.threadExists(threadId))) return { status: "unsupported" };
      return deps.turns.replay(threadId, text);
    },
    setMuted: async ({ muted }) => {
      if (muted) deps.hub.stop(null);
      await deps.mute.set(muted);
      deps.publish("kokoro-config", await getConfig());
      return { muted };
    },
    interruptAll: () => ({ sessions_cancelled: deps.hub.stopAll() }),
    stop: ({ threadId }) => {
      deps.hub.stop(threadId);
      return { status: "stopped" };
    },
    speechLog: ({ threadId }) => ({ entries: deps.speechLog.list(threadId) }),
    clearHistory: () => {
      const deleted = deps.speechLog.clear();
      deps.publish("kokoro-log-cleared", {});
      return { deleted };
    },
    dismissNote: async () => {
      await deps.kv.delete(MIGRATION_NOTE);
      return { ok: true as const };
    },
    installUv: async () => {
      if (installing) return { started: false };
      installing = true;
      void scope.track(installUv(within(300_000)))
        .then((r) => {
          if (scope.signal.aborted) return;
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
    setVoiceScope: async ({ threadId, projectId, scope: which, patch }) => {
      await deps.scopes.set(which, which === "thread" ? threadId : projectId, patch);
      return voiceScope({ threadId, projectId });
    },
  });
}
