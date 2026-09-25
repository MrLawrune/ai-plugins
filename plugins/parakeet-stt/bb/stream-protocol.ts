// Messages on the page ↔ relay ↔ server stream. Shared by the relay (server) and the page.
import { z } from "zod";
import type { Prefs } from "./schemas.ts";

const endReason = z.enum(["stopped", "silence", "command", "limit", "error"]);
export type EndReason = z.infer<typeof endReason>;

const serverEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("partial"), seq: z.number().int(), text: z.string() }),
  z.object({ type: z.literal("final"), seq: z.number().int(), text: z.string() }),
  z.object({ type: z.literal("command"), name: z.enum(["send", "stop", "clear", "start"]) }),
  z.object({ type: z.literal("state"), waiting: z.boolean() }),
  z.object({ type: z.literal("heard"), text: z.string() }),
  z.object({ type: z.literal("ended"), reason: endReason }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type CommandName = Extract<ServerEvent, { type: "command" }>["name"];

export function parseServerEvent(data: unknown): ServerEvent | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = serverEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function streamOptionsFrom(p: Prefs): Record<string, unknown> {
  return {
    pause_ms: p.pauseMs,
    silence_timeout_s: p.endOnSilence ? p.silenceTimeoutS : null,
    commands: p.voiceCommands ? { send: p.sendPhrase, stop: p.stopPhrase, clear: p.clearPhrase } : null,
    start: p.voiceCommands && p.waitForStart ? p.startPhrases : [],
    preview: p.livePreview,
    custom_words: p.customWords,
    remove_fillers: p.removeFillers,
    correction_threshold: p.correctionThreshold,
  };
}

export function upstreamUrl(serverUrl: string): string {
  const u = new URL(serverUrl.trim());
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/v1/stream`;
  return u.toString();
}
