import { DEFAULT_SETTINGS, type ConfigResponse, type KokoroStatus, type Prefs, type VoiceScopeState } from "../schemas.ts";

export const RUNTIME: NonNullable<ConfigResponse["runtime"]> = {
  config: { provider: "cpu", idle_unload_minutes: 10, intra_op_threads: 0, gpu_mem_limit_mb: 0 },
  providers_available: { cpu: true, cuda: false, openvino: false },
  restart_required: {
    model_path: "/home/u/.local/share/kokoro-tts/kokoro-v1.0.onnx",
    voices_path: "/home/u/.local/share/kokoro-tts/voices-v1.0.bin",
    port: 6789,
    config_path: "/home/u/.config/kokoro-tts/config.json",
  },
  restart_command: "Turn Manage server off and on again.",
};

export const CONFIG_RESPONSE: ConfigResponse = {
  config: DEFAULT_SETTINGS,
  muted: false,
  pause_other_audio_supported: false,
  runtime: RUNTIME,
  note: null,
};

export const PREFS: Prefs = { manageServer: true, runtime: "cpu", playOn: "follow", pinnedDevice: null };

export const HEALTH = { status: "ok", model: "kokoro-v1.0.onnx", active_sessions: 0, muted: false };

export const READY: KokoroStatus = {
  health: { up: true, health: HEALTH },
  engines: [{ slot: "main", url: "http://127.0.0.1:6789", local: true, health: { up: true, health: HEALTH }, breaker: "closed" }],
  setup: { state: "running", detail: null, progress: null, fixCommand: null, headless: false, gpuAvailable: false },
  clients: [],
  muted: false,
  latency: { median_ms: null, samples: 0 },
};

const BRIEF_GLOBAL = { mode: "brief", voiced: true, modeFrom: "global", isChild: false, childrenFrom: null } as const;
export const VOICE_SCOPE: VoiceScopeState = {
  thread: {}, project: {}, globalMode: "brief", effective: BRIEF_GLOBAL, inherited: BRIEF_GLOBAL, parentThreadId: null,
};

type Handler = (input: unknown) => unknown;

const RUNTIME_KEYS = new Set(Object.keys(RUNTIME.config));

/** What patchConfig answers: runtime keys land in `runtime.config`, the rest in `config`. */
function patched(p: Record<string, unknown>): ConfigResponse {
  const runtime = Object.keys(p).some((k) => RUNTIME_KEYS.has(k));
  return runtime
    ? { ...CONFIG_RESPONSE, runtime: { ...RUNTIME, config: { ...RUNTIME.config, ...p } } }
    : { ...CONFIG_RESPONSE, config: { ...CONFIG_RESPONSE.config, ...p } };
}

/** RPC handlers for renderSlot: a working, idle server unless overridden. */
export function rpcStubs(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    status: () => READY,
    getConfig: () => CONFIG_RESPONSE,
    getPrefs: () => PREFS,
    setPrefs: (p) => ({ ...PREFS, ...(p as Partial<Prefs>) }),
    patchConfig: (p) => patched(p as Record<string, unknown>),
    listVoices: () => ({ voices: [
      { name: "af_sky", lang_code: "a", lang: "en-us", language: "American English", gender: "female" },
      { name: "bm_george", lang_code: "b", lang: "en-gb", language: "British English", gender: "male" },
    ] }),
    preview: () => ({ status: "playing" }),
    playSound: () => ({ status: "playing" }),
    setMuted: (p) => p,
    interruptAll: () => ({ sessions_cancelled: 0 }),
    stop: () => ({ status: "interrupted" }),
    clearHistory: () => ({ deleted: 0 }),
    dismissNote: () => ({ ok: true }),
    installUv: () => ({ started: true }),
    speechLog: () => ({ entries: [] }),
    replay: () => ({ status: "playing" }),
    getVoiceScope: () => VOICE_SCOPE,
    setVoiceScope: () => VOICE_SCOPE,
    ...overrides,
  };
}
