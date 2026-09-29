import type { ConfigResponse, KokoroStatus, Prefs } from "../schemas.ts";

export const CONFIG_RESPONSE: ConfigResponse = {
  config: {
    voice: "af_sky", speed: 1, lang: "en-us", trim: true, mode: "brief", speech_gain: 1, sound_volume: 1,
    working_sound: true, attention_sound: true, strip_markdown: true, output_device: null, lead_in_ms: 300,
    gap_ms: 60, other_audio: "keep", provider: "cpu", remote_url: null, fallback_to_cpu: true,
    idle_unload_minutes: 10, intra_op_threads: 0, gpu_mem_limit_mb: 0,
  },
  muted: false,
  providers_available: { cpu: true, cuda: false, openvino: false },
  pause_other_audio_supported: false,
  restart_required: {
    model_path: "/home/u/.local/share/kokoro-tts/kokoro-v1.0.onnx",
    voices_path: "/home/u/.local/share/kokoro-tts/voices-v1.0.bin",
    port: 6789,
    config_path: "/home/u/.config/kokoro-tts/config.json",
  },
  restart_command: "Turn Manage server off and on again.",
};

export const PREFS: Prefs = { manageServer: true, runtime: "cpu", playback: "client", playOn: "follow", pinnedDevice: null };

export const HEALTH = { status: "ok", model: "kokoro-v1.0.onnx", active_sessions: 0, muted: false };

export const READY: KokoroStatus = {
  health: { up: true, health: HEALTH },
  setup: { state: "running", detail: null, progress: null, fixCommand: null, headless: false, gpuAvailable: false },
  clients: [],
};

type Handler = (input: unknown) => unknown;

/** RPC handlers for renderSlot: a working, idle server unless overridden. */
export function rpcStubs(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    status: () => READY,
    getConfig: () => CONFIG_RESPONSE,
    getPrefs: () => PREFS,
    setPrefs: (p) => ({ ...PREFS, ...(p as Partial<Prefs>) }),
    patchConfig: (p) => ({ ...CONFIG_RESPONSE, config: { ...CONFIG_RESPONSE.config, ...(p as object) } }),
    listVoices: () => ({ voices: [
      { name: "af_sky", lang_code: "a", lang: "en-us", language: "American English", gender: "female" },
      { name: "bm_george", lang_code: "b", lang: "en-gb", language: "British English", gender: "male" },
    ] }),
    listDevices: () => ({ devices: [], selected: null }),
    preview: () => ({ status: "playing" }),
    playSound: () => ({ status: "playing" }),
    setMuted: (p) => p,
    interruptAll: () => ({ sessions_cancelled: 0 }),
    installUv: () => ({ started: true }),
    speechLog: () => ({ entries: [] }),
    replay: () => ({ status: "playing" }),
    ...overrides,
  };
}
