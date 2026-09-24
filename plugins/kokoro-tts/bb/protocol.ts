// Messages on the per-window player WebSocket (backend <-> content script).
import { z } from "zod";

export const SOUNDS = ["working", "done", "attention", "error"] as const;
export type SoundName = (typeof SOUNDS)[number];

const clientMsgSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    clientId: z.string().min(1).max(64),
    deviceName: z.string().min(1).max(64),
    focusedAt: z.number(),
    audioUnlocked: z.boolean(),
  }),
  z.object({ type: z.literal("focus"), focusedAt: z.number() }),
  z.object({ type: z.literal("unlocked") }),
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("status"),
    entryId: z.number().int(),
    status: z.enum(["playing", "done", "interrupted", "error"]),
    firstAudioMs: z.number().optional(),
    error: z.string().max(200).optional(),
  }),
]);
export type ClientMsg = z.infer<typeof clientMsgSchema>;

export type ServerMsg =
  | { type: "speak"; entryId: number; sessionId: string; sampleRate: number; gain: number }
  | { type: "end"; entryId: number }
  | { type: "sound"; sound: SoundName; volume: number; sessionId: string }
  | { type: "stop"; sessionId: string | null };

export function parseClientMsg(raw: string): ClientMsg | null {
  try {
    const r = clientMsgSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Binary audio message: 4-byte LE entry id, then float32 PCM bytes. */
export function encodeFrame(entryId: number, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + pcm.length);
  new DataView(out.buffer).setUint32(0, entryId, true);
  out.set(pcm, 4);
  return out;
}

export function decodeFrame(buf: Uint8Array): { entryId: number; pcm: Float32Array } {
  const entryId = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
  const bytes = buf.slice(4);
  return { entryId, pcm: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2) };
}
