// The engine seam: anything that turns one text chunk into PCM.
import type { VoiceInfo } from "../schemas.ts";

/** Mono float32 little-endian PCM at 24000 Hz. Adapters convert to this. */
export type Pcm = Uint8Array;
export const SAMPLE_RATE = 24_000;

export interface SynthOpts { voice: string | Record<string, number>; speed: number; lang: string; trim: boolean }

export interface EngineHealth { reachable: boolean; loaded: boolean | null; version: string | null; forwards: boolean | null; error: string | null }

export type EngineErrorKind = "cancelled" | "config" | "unreachable" | "stream";

export class EngineError extends Error {
  readonly kind: EngineErrorKind;
  /** HTTP status when the engine answered with an error. */
  readonly status: number | undefined;
  constructor(kind: EngineErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface Engine {
  readonly url: string;
  health(signal: AbortSignal): Promise<EngineHealth>;
  voices(signal: AbortSignal): Promise<VoiceInfo[]>;
  synthesize(chunk: string, opts: SynthOpts, signal: AbortSignal): AsyncIterable<Pcm>;
}
