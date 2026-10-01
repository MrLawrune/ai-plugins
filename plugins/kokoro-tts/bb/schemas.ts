import { z } from "zod";

export const voiceSchema = z.union([z.string(), z.record(z.string(), z.number())]);
export const modeSchema = z.enum(["quiet", "ambient", "brief", "conversational", "verbose", "full"]);
export type Mode = z.infer<typeof modeSchema>;
export const scopeSettingSchema = z.object({ mode: modeSchema.optional(), voiceChildren: z.boolean().optional() }).strict();
export type ScopeSetting = z.infer<typeof scopeSettingSchema>;
export const restartSchema = z.object({
  model_path: z.string(),
  voices_path: z.string(),
  port: z.number(),
  config_path: z.string(),
  headless: z.boolean().optional(),
});

export const availableSchema = z.object({ cpu: z.boolean(), cuda: z.boolean(), openvino: z.boolean() });

const healthSchema = z.object({
  status: z.string(),
  version: z.string().nullable().optional(),
  model: z.string(),
  active_sessions: z.number(),
  provider: z.string().optional(),
  engine: z.unknown().optional(),
  muted: z.boolean().optional(),
  uptime_s: z.number().optional(),
  started_by: z.string().nullable().optional(),
  headless: z.boolean().optional(),
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

export const voiceInfoSchema = z.object({
  name: z.string(),
  lang_code: z.string(),
  lang: z.string(),
  language: z.string(),
  gender: z.string(),
});
export type VoiceInfo = z.infer<typeof voiceInfoSchema>;

/** Health wrapped so the page can render "server down" without throwing. */
export const healthResultSchema = z.union([
  z.object({ up: z.literal(true), health: healthSchema }),
  z.object({ up: z.literal(false), error: z.string() }),
]);
export type HealthResult = z.infer<typeof healthResultSchema>;

export const speechLogEntrySchema = z.object({
  id: z.number(),
  ts: z.number(),
  session_id: z.string(),
  text: z.string(),
  status: z.enum(["queued", "playing", "done", "interrupted", "error", "muted", "empty"]),
  first_audio_ms: z.number().optional(),
  voice: z.string().optional(),
  error: z.string().optional(),
  engine: z.string().optional(),
});
export type SpeechLogEntry = z.infer<typeof speechLogEntrySchema>;

export const prefsSchema = z.object({
  manageServer: z.boolean(),
  runtime: z.enum(["cpu", "gpu"]),
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
  /** The window is on the computer running bb and Kokoro (reached over loopback). */
  local: z.boolean().optional(),
});
export type PublicClientInfo = z.infer<typeof clientInfoSchema>;

export const resolvedVoiceSchema = z.object({
  mode: modeSchema,
  voiced: z.boolean(),
  modeFrom: z.enum(["thread", "parent", "project", "global"]),
  isChild: z.boolean(),
  childrenFrom: z.enum(["parent", "project"]).nullable(),
});

/** One thread's own and project voice settings, and what they resolve to. */
export const voiceScopeSchema = z.object({
  thread: scopeSettingSchema,
  project: scopeSettingSchema,
  globalMode: modeSchema,
  effective: resolvedVoiceSchema,
  /** The resolution without this thread's own setting: what "Default" gives. */
  inherited: resolvedVoiceSchema,
  parentThreadId: z.string().nullable(),
});
export type VoiceScopeState = z.infer<typeof voiceScopeSchema>;

export const scopePatchSchema = z
  .object({ mode: modeSchema.nullable().optional(), voiceChildren: z.boolean().nullable().optional() })
  .strict();
export type ScopePatchInput = z.infer<typeof scopePatchSchema>;

export const threadIdSchema = z.string().min(1).max(128);

export const engineRefSchema = z.union([z.literal("local"), z.object({ url: z.string().trim().url().max(512) }).strict()]);
export type EngineRef = z.infer<typeof engineRefSchema>;

export const retentionSchema = z
  .object({
    maxAgeDays: z.number().int().min(1).max(90),
    maxEntries: z.number().int().min(100).max(10000),
  })
  .strict();

/** Plugin-owned speech settings (the `settings` KV row). */
export const settingsSchema = z
  .object({
    v: z.literal(1),
    mode: modeSchema,
    voice: voiceSchema,
    speed: z.number().min(0.5).max(2),
    lang: z.string().trim().min(1).max(16),
    trim: z.boolean(),
    strip_markdown: z.boolean(),
    speech_gain: z.number().min(0).max(2),
    sound_volume: z.number().min(0).max(2),
    working_sound: z.boolean(),
    attention_sound: z.boolean(),
    lead_in_ms: z.number().int().min(0).max(2000),
    gap_ms: z.number().int().min(0).max(1000),
    other_audio: z.enum(["keep", "pause"]),
    engines: z.object({ main: engineRefSchema, backup: engineRefSchema.nullable() }).strict(),
    retention: retentionSchema,
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  mode: "brief",
  voice: "af_sky",
  speed: 1,
  lang: "en-us",
  trim: true,
  strip_markdown: true,
  speech_gain: 1,
  sound_volume: 1,
  working_sound: true,
  attention_sound: true,
  lead_in_ms: 300,
  gap_ms: 60,
  other_audio: "keep",
  engines: { main: "local", backup: null },
  retention: { maxAgeDays: 7, maxEntries: 1000 },
};

export const settingsPatchSchema = settingsSchema.omit({ v: true }).partial().strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** The local engine's runtime knobs, which stay server-owned. */
export const runtimeConfigSchema = z.object({
  provider: z.enum(["cpu", "cuda", "openvino"]),
  idle_unload_minutes: z.number().int().min(0),
  intra_op_threads: z.number().int().min(0),
  gpu_mem_limit_mb: z.number().int().min(0),
});
export const runtimePatchSchema = runtimeConfigSchema.partial().strict();
export type RuntimePatch = z.infer<typeof runtimePatchSchema>;

export const runtimeInfoSchema = z.object({
  config: runtimeConfigSchema,
  providers_available: availableSchema,
  restart_required: restartSchema,
  restart_command: z.string(),
});

export const configResponseSchema = z.object({
  config: settingsSchema,
  muted: z.boolean(),
  /** Linux with playerctl: other media can be paused while speech plays. */
  pause_other_audio_supported: z.boolean(),
  /** The local engine's runtime; null when the plugin does not manage a local engine. */
  runtime: runtimeInfoSchema.nullable(),
  note: z.string().nullable(),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

/** Strict members: a patch touches speech settings or engine runtime, never both. */
export const configPatchSchema = z.union([settingsPatchSchema, runtimePatchSchema]);

export const engineStatusSchema = z.object({
  slot: z.enum(["main", "backup"]),
  url: z.string(),
  local: z.boolean(),
  health: healthResultSchema,
  breaker: z.enum(["closed", "open", "half-open"]),
});

export const statusSchema = z.object({
  /** The main engine's health; the page header reads it. */
  health: healthResultSchema,
  engines: z.array(engineStatusSchema),
  setup: setupStateSchema,
  clients: z.array(clientInfoSchema),
  muted: z.boolean(),
  latency: z.object({ median_ms: z.number().nullable(), samples: z.number() }),
});
export type KokoroStatus = z.infer<typeof statusSchema>;
