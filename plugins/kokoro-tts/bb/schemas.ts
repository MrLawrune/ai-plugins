import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const voiceSchema = z.union([z.string(), z.record(z.string(), z.number())]);
const modeSchema = z.enum(["quiet", "ambient", "brief", "conversational", "verbose", "full"]);
const providerSchema = z.enum(["cpu", "cuda", "openvino", "remote"]);

export const configSchema = z.object({
  voice: voiceSchema,
  speed: z.number(),
  lang: z.string(),
  trim: z.boolean(),
  mode: modeSchema,
  speech_gain: z.number(),
  sound_volume: z.number(),
  working_sound: z.boolean(),
  attention_sound: z.boolean(),
  strip_markdown: z.boolean(),
  output_device: z.number().int().nullable(),
  lead_in_ms: z.number().int(),
  gap_ms: z.number().int(),
  provider: providerSchema,
  remote_url: z.string().nullable(),
  fallback_to_cpu: z.boolean(),
  idle_unload_minutes: z.number().int(),
  intra_op_threads: z.number().int(),
  gpu_mem_limit_mb: z.number().int(),
});
export type KokoroConfig = z.infer<typeof configSchema>;

export const configPatchSchema = configSchema.partial().strict();

const restartSchema = z.object({
  model_path: z.string(),
  voices_path: z.string(),
  port: z.number(),
  config_path: z.string(),
  headless: z.boolean().optional(),
});

const availableSchema = z.object({ cpu: z.boolean(), cuda: z.boolean(), openvino: z.boolean() });

const localEngineSchema = z.object({
  kind: z.literal("local"),
  provider: z.string(),
  loaded: z.boolean(),
  loaded_provider: z.string().nullable(),
  intra_op_threads: z.number(),
  gpu_mem_limit_mb: z.number(),
  idle_unload_minutes: z.number(),
  load_ms: z.number().nullable(),
  available: availableSchema,
});
const remoteEngineSchema = z.object({
  kind: z.literal("remote"),
  provider: z.string(),
  url: z.string(),
  last_error: z.string().nullable(),
  last_latency_ms: z.number().nullable(),
  fallback: localEngineSchema.nullable(),
  remote_health: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const engineSchema = z.union([localEngineSchema, remoteEngineSchema]);
export type EngineInfo = z.infer<typeof engineSchema>;

const configResponseSchema = z.object({
  config: configSchema,
  muted: z.boolean(),
  providers_available: availableSchema,
  restart_required: restartSchema,
  restart_command: z.string(),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

const healthSchema = z.object({
  status: z.string(),
  version: z.string().nullable().optional(),
  model: z.string(),
  active_sessions: z.number(),
  provider: z.string().optional(),
  engine: z.unknown().optional(),
  muted: z.boolean().optional(),
  uptime_s: z.number().optional(),
  latency: z
    .object({
      last_ms: z.number().nullable(),
      median_ms: z.number().nullable(),
      samples: z.number(),
      spoken: z.number(),
    })
    .optional(),
});
export type Health = z.infer<typeof healthSchema>;

const voiceInfoSchema = z.object({
  name: z.string(),
  lang_code: z.string(),
  lang: z.string(),
  language: z.string(),
  gender: z.string(),
});
export type VoiceInfo = z.infer<typeof voiceInfoSchema>;

const deviceSchema = z.object({
  index: z.number(),
  name: z.string(),
  default: z.boolean(),
  channels: z.number(),
});
export type DeviceInfo = z.infer<typeof deviceSchema>;

/** Health wrapped so the page can render "server down" without throwing. */
const healthResultSchema = z.union([
  z.object({ up: z.literal(true), health: healthSchema }),
  z.object({ up: z.literal(false), error: z.string() }),
]);

const speechLogEntrySchema = z.object({
  id: z.number(),
  ts: z.number(),
  session_id: z.string(),
  text: z.string(),
  status: z.enum(["queued", "playing", "done", "interrupted", "error", "muted", "empty"]),
  first_audio_ms: z.number().optional(),
  error: z.string().optional(),
});
export type SpeechLogEntry = z.infer<typeof speechLogEntrySchema>;

export const prefsSchema = z.object({
  manageServer: z.boolean(),
  runtime: z.enum(["cpu", "gpu"]),
  playback: z.enum(["client", "server"]),
  playOn: z.enum(["follow", "pinned", "all"]),
  pinnedDevice: z.string().min(1).max(64).nullable(),
});
export type Prefs = z.infer<typeof prefsSchema>;
export type PlayOn = Prefs["playOn"];

export const setupStateSchema = z.object({
  state: z.enum(["checking", "needs-uv", "downloading-models", "installing-runtime", "starting", "running", "external", "error"]),
  detail: z.string().nullable(),
  progress: z.number().min(0).max(1).nullable(),
  fixCommand: z.string().nullable(),
  headless: z.boolean().nullable(),
  gpuAvailable: z.boolean(),
});
export type SetupState = z.infer<typeof setupStateSchema>;

export const clientInfoSchema = z.object({
  clientId: z.string(),
  deviceName: z.string(),
  focusedAt: z.number(),
  audioUnlocked: z.boolean(),
});
export type PublicClientInfo = z.infer<typeof clientInfoSchema>;

export const rpcContract = defineRpcContract({
  health: { input: z.null(), output: healthResultSchema },
  speechLog: { input: z.null(), output: z.object({ entries: z.array(speechLogEntrySchema) }) },
  getConfig: { input: z.null(), output: configResponseSchema },
  patchConfig: { input: configPatchSchema, output: configResponseSchema },
  listVoices: { input: z.null(), output: z.object({ voices: z.array(voiceInfoSchema) }) },
  listDevices: {
    input: z.null(),
    output: z.object({ devices: z.array(deviceSchema), selected: z.number().nullable() }),
  },
  preview: {
    input: z
      .object({
        text: z.string().max(400).optional(),
        voice: voiceSchema.optional(),
        speed: z.number().optional(),
        lang: z.string().optional(),
        speech_gain: z.number().optional(),
      })
      .strict(),
    output: z.object({ status: z.string() }),
  },
  playSound: {
    input: z.object({ sound: z.enum(["working", "done", "attention", "error"]) }).strict(),
    output: z.object({ status: z.string() }),
  },
  setMuted: { input: z.object({ muted: z.boolean() }).strict(), output: z.object({ muted: z.boolean() }) },
  interruptAll: { input: z.null(), output: z.object({ sessions_cancelled: z.number() }) },
  engine: { input: z.null(), output: engineSchema },
  setupStatus: { input: z.null(), output: setupStateSchema },
  installUv: { input: z.null(), output: z.object({ started: z.boolean() }) },
  getPrefs: { input: z.null(), output: prefsSchema },
  setPrefs: { input: prefsSchema.partial().strict(), output: prefsSchema },
  listClients: { input: z.null(), output: z.object({ clients: z.array(clientInfoSchema) }) },
});

export const turnResultSchema = z.object({
  action: z.enum(["speech", "sound", "silent"]),
  text: z.string().optional(),
  sound: z.enum(["working", "done", "attention", "error"]).optional(),
  entry_id: z.number().int().optional(),
  speech_gain: z.number().optional(),
  sound_volume: z.number().optional(),
  muted: z.boolean().optional(),
});
export type TurnResult = z.infer<typeof turnResultSchema>;
