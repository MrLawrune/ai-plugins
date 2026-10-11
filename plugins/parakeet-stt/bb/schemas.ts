import { z } from "zod";

export const SHORTCUTS = ["ctrl+space", "alt+space", "ctrl+shift+space", "off"] as const;
export const SOUNDS = ["start", "stop", "cancel", "error"] as const;
export type SoundName = (typeof SOUNDS)[number];

const customWordsSchema = z
  .array(z.string().max(64))
  .max(200)
  .transform((words) => [...new Set(words.map((w) => w.trim()).filter(Boolean))]);

/** Bounds of the history retention settings. */
export const HISTORY_MAX_ENTRIES = 1000;
export const HISTORY_MAX_AGE_DAYS = 90;

export const prefsSchema = z.object({
  shortcut: z.enum(SHORTCUTS),
  holdToTalk: z.boolean(),
  autoSubmit: z.boolean(),
  trailingSpace: z.boolean(),
  soundCues: z.boolean(),
  customWords: customWordsSchema,
  removeFillers: z.boolean(),
  correctionThreshold: z.number().min(0).max(0.5),
  historyMaxEntries: z.number().int().min(0).max(HISTORY_MAX_ENTRIES),
  historyMaxAgeDays: z.number().int().min(1).max(HISTORY_MAX_AGE_DAYS),
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

/** Settings that differ per device profile; everything else (vocabulary, phrase wording, history size) is shared. */
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

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const nameSchema = z.string().trim().min(1).max(64);

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

export const historyEntrySchema = z.object({
  id: z.number(),
  text: z.string(),
  at: z.number(),
  durationMs: z.number(),
  source: z.enum(["oneshot", "stream", "voice"]),
});
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

/** Server URL setting: empty (unset) or an absolute http(s) URL. */
export const SERVER_URL_ERROR = "Enter an http or https URL";
export const serverUrlSchema = z
  .string()
  .trim()
  .refine((v) => v === "" || (z.url().safeParse(v).success && /^https?:\/\//i.test(v)), SERVER_URL_ERROR);

export const serverResultSchema = z.object({ serverUrl: z.string(), apiKeySet: z.boolean(), needsReload: z.boolean() });
export type ServerResult = z.infer<typeof serverResultSchema>;
