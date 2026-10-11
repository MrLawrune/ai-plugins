import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { deviceKindSchema, deviceSchema, healthResultSchema, historyEntrySchema, idSchema, nameSchema, prefsSchema, profileInfoSchema, serverResultSchema } from "./schemas.ts";

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
  /** The server URL and whether a key is set (the key itself never leaves the backend). */
  getServer: { input: z.null(), output: serverResultSchema },
  /** Writes through the plugin settings; an omitted field is unchanged and a null key is cleared. The handler validates the URL. */
  setServer: {
    input: z.object({ serverUrl: z.string().trim().max(2048).optional(), apiKey: z.string().max(512).nullable().optional() }).strict(),
    output: serverResultSchema,
  },
  /** The one-time note left by the 0.1.0 migration, or null once dismissed. */
  getNote: { input: z.null(), output: z.object({ note: z.string().nullable() }) },
  dismissNote: { input: z.null(), output: z.object({ dismissed: z.literal(true) }) },
});
