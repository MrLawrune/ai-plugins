// The plugin's RPC contract. It lives apart from schemas.ts because the server
// SDK it needs is not available to the frontend bundle, which uses the schemas.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  configPatchSchema,
  configResponseSchema,
  deviceSchema,
  prefsSchema,
  scopePatchSchema,
  speechLogEntrySchema,
  statusSchema,
  threadIdSchema,
  voiceInfoSchema,
  voiceSchema,
  voiceScopeSchema,
} from "./schemas.ts";

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  /** One thread's recent speech-log entries, oldest first. */
  speechLog: {
    input: z.object({ threadId: z.string().min(1).max(128) }).strict(),
    output: z.object({ entries: z.array(speechLogEntrySchema) }),
  },
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
  replay: {
    input: z.object({ threadId: z.string().min(1).max(128), text: z.string().min(1).max(2000) }).strict(),
    output: z.object({ status: z.string() }),
  },
  setMuted: { input: z.object({ muted: z.boolean() }).strict(), output: z.object({ muted: z.boolean() }) },
  interruptAll: { input: z.null(), output: z.object({ sessions_cancelled: z.number() }) },
  /** Stops one thread's speech, wherever it plays. */
  stop: { input: z.object({ threadId: z.string().min(1).max(128) }).strict(), output: z.object({ status: z.string() }) },
  installUv: { input: z.null(), output: z.object({ started: z.boolean() }) },
  getPrefs: { input: z.null(), output: prefsSchema },
  setPrefs: { input: prefsSchema.partial().strict(), output: prefsSchema },
  getVoiceScope: {
    input: z.object({ threadId: threadIdSchema, projectId: threadIdSchema }).strict(),
    output: voiceScopeSchema,
  },
  /** A null in the patch clears that field of the thread's or project's setting. */
  setVoiceScope: {
    input: z
      .object({
        threadId: threadIdSchema,
        projectId: threadIdSchema,
        scope: z.enum(["thread", "project"]),
        patch: scopePatchSchema,
      })
      .strict(),
    output: voiceScopeSchema,
  },
});
