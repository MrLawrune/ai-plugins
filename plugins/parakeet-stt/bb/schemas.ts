import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const SHORTCUTS = ["ctrl+space", "alt+space", "ctrl+shift+space", "off"] as const;
export const SOUNDS = ["start", "stop", "cancel", "error"] as const;
export type SoundName = (typeof SOUNDS)[number];

const customWordsSchema = z
  .array(z.string().max(64))
  .max(200)
  .transform((words) => [...new Set(words.map((w) => w.trim()).filter(Boolean))]);

export const prefsSchema = z.object({
  shortcut: z.enum(SHORTCUTS),
  holdToTalk: z.boolean(),
  autoSubmit: z.boolean(),
  trailingSpace: z.boolean(),
  soundCues: z.boolean(),
  customWords: customWordsSchema,
  removeFillers: z.boolean(),
  correctionThreshold: z.number().min(0).max(0.5),
  historyLimit: z.number().int().min(0).max(50),
  mode: z.enum(["continuous", "oneshot"]),
  livePreview: z.boolean(),
  pauseMs: z.number().int().min(300).max(1500),
  endOnSilence: z.boolean(),
  silenceTimeoutS: z.number().int().min(3).max(60),
  voiceCommands: z.boolean(),
  sendPhrase: z.string().trim().min(1).max(120),
  stopPhrase: z.string().trim().min(1).max(120),
  clearPhrase: z.string().trim().min(1).max(120),
  waitForStart: z.boolean(),
  startPhrases: z
    .array(z.string().max(60))
    .max(10)
    .transform((phrases) => [...new Set(phrases.map((p) => p.trim()).filter(Boolean))]),
  hideNativeMic: z.boolean(),
  keepListeningHidden: z.boolean(),
  floatingMic: z.boolean(),
  expandCompactDraft: z.boolean(),
}).strict();
export type Prefs = z.output<typeof prefsSchema>;

/** Settings that differ per device profile; everything else (vocabulary, phrase wording, history) is shared. */
export const PROFILE_KEYS = [
  "shortcut", "holdToTalk", "autoSubmit", "trailingSpace", "soundCues", "mode", "livePreview", "pauseMs",
  "endOnSilence", "silenceTimeoutS", "voiceCommands", "waitForStart", "hideNativeMic", "keepListeningHidden",
  "floatingMic", "expandCompactDraft",
] as const satisfies readonly (keyof Prefs)[];
export type ProfileKey = (typeof PROFILE_KEYS)[number];
export type ProfilePrefs = Pick<Prefs, ProfileKey>;
export type SharedPrefs = Omit<Prefs, ProfileKey>;

/** Touch screen (phones, tablets) or desktop (mouse and keyboard). */
export const DEVICE_KINDS = ["touch", "desktop"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
/** Also accepts the earlier phone/tablet kinds, which are both touch screens. */
export const deviceKindSchema = z.preprocess((v) => (v === "phone" || v === "tablet" ? "touch" : v), z.enum(DEVICE_KINDS));

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const nameSchema = z.string().trim().min(1).max(64);

export const profileInfoSchema = z.object({ id: idSchema, name: nameSchema });
export type ProfileInfo = z.infer<typeof profileInfoSchema>;

export const deviceSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: deviceKindSchema,
  profileId: idSchema,
  lastSeen: z.number(),
});
export type DeviceRecord = z.infer<typeof deviceSchema>;

export const historyEntrySchema = z.object({ id: z.string(), text: z.string(), at: z.number(), durationMs: z.number() });
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const healthResultSchema = z.object({
  configured: z.boolean(),
  up: z.boolean(),
  model: z.string().nullable(),
  version: z.string().nullable(),
  error: z.string().nullable(),
  lastLatencyMs: z.number().nullable(),
});
export type HealthResult = z.infer<typeof healthResultSchema>;

export const rpcContract = defineRpcContract({
  health: { input: z.null(), output: healthResultSchema },
  transcribe: {
    input: z.object({ audioBase64: z.string().min(1), mimeType: z.string().min(1), filename: z.string().min(1) }).strict(),
    output: z.object({ text: z.string(), durationMs: z.number() }),
  },
  /** Register (or refresh) this browser; returns its record and effective prefs. */
  hello: {
    input: z.object({ deviceId: idSchema, name: nameSchema, kind: deviceKindSchema }).strict(),
    output: z.object({ device: deviceSchema, prefs: prefsSchema }),
  },
  getPrefs: { input: z.object({ profileId: idSchema }).strict(), output: prefsSchema },
  setPrefs: {
    input: z.object({ profileId: idSchema, patch: z.object(prefsSchema.shape).partial().strict() }).strict(),
    output: prefsSchema,
  },
  listProfiles: { input: z.null(), output: z.object({ profiles: z.array(profileInfoSchema), devices: z.array(deviceSchema) }) },
  createProfile: { input: z.object({ name: nameSchema, copyFrom: idSchema }).strict(), output: profileInfoSchema },
  renameProfile: { input: profileInfoSchema.strict(), output: profileInfoSchema },
  deleteProfile: { input: z.object({ id: idSchema }).strict(), output: z.object({ deleted: z.literal(true) }) },
  updateDevice: {
    input: z.object({ id: idSchema, name: nameSchema.optional(), profileId: idSchema.optional() }).strict(),
    output: deviceSchema,
  },
  forgetDevice: { input: z.object({ id: idSchema }).strict(), output: z.object({ forgotten: z.literal(true) }) },
  listHistory: { input: z.null(), output: z.object({ entries: z.array(historyEntrySchema) }) },
  clearHistory: { input: z.null(), output: z.object({ cleared: z.literal(true) }) },
});
