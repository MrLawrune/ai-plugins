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
  sendPhrase: z.string().trim().min(1).max(40),
  stopPhrase: z.string().trim().min(1).max(40),
  clearPhrase: z.string().trim().min(1).max(40),
  waitForStart: z.boolean(),
  startPhrases: z
    .array(z.string().max(40))
    .max(10)
    .transform((phrases) => [...new Set(phrases.map((p) => p.trim()).filter(Boolean))]),
  hideNativeMic: z.boolean(),
  keepListeningHidden: z.boolean(),
  floatingMic: z.boolean(),
  expandCompactDraft: z.boolean(),
}).strict();
export type Prefs = z.output<typeof prefsSchema>;

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
  getPrefs: { input: z.null(), output: prefsSchema },
  setPrefs: { input: z.object(prefsSchema.shape).partial().strict(), output: prefsSchema },
  listHistory: { input: z.null(), output: z.object({ entries: z.array(historyEntrySchema) }) },
  clearHistory: { input: z.null(), output: z.object({ cleared: z.literal(true) }) },
});
