// Host-config RPC shared by server.ts (client) and host.ts (handler). Must stay free of
// @get-bb/plugin-sdk/ai-services: the bb server runtime cannot resolve that subpath.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostConfigSchema = z.object({
  serverUrl: z.string(),
  apiKey: z.string(),
  customWords: z.array(z.string()),
  removeFillers: z.boolean(),
  correctionThreshold: z.number(),
}).strict();
export type HostConfig = z.infer<typeof hostConfigSchema>;

export const configureContract = defineRpcContract({
  "stt.configure": { input: hostConfigSchema, output: z.object({ ok: z.literal(true) }).strict() },
});
