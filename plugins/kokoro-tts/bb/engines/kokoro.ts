// Engine adapter for a Kokoro synthesis server (v2 framed float32 PCM, already 24 kHz mono).
import { z } from "zod";
import { readFrames } from "../kokoro-client.ts";
import { voiceInfoSchema, type VoiceInfo } from "../schemas.ts";
import { EngineError, type Engine, type EngineHealth, type Pcm, type SynthOpts } from "./types.ts";

const QUERY_TIMEOUT_MS = 4_000;
const FORWARDS = "this server forwards to another one; point at the synthesis server directly";

function reason(cause: unknown): string {
  if (cause instanceof Error) {
    // undici's "fetch failed" hides the useful part (e.g. ECONNREFUSED) in `cause`.
    const inner = cause.cause;
    return inner instanceof Error && inner.message ? inner.message : cause.message;
  }
  return String(cause);
}

export function createKokoroEngine(url: string, fetchImpl: typeof fetch = fetch): Engine {
  const base = url.replace(/\/+$/, "");

  /** GET a JSON endpoint; the deadline covers the body too. */
  async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), QUERY_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base}${path}`, { signal: AbortSignal.any([signal, deadline.signal]) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function health(signal: AbortSignal): Promise<EngineHealth> {
    try {
      const body = (await getJson("/health", signal)) as { version?: string; engine?: { kind?: string; loaded?: boolean } } | null;
      const engine = body?.engine;
      return {
        reachable: true,
        loaded: engine?.kind === "local" && typeof engine.loaded === "boolean" ? engine.loaded : null,
        version: body?.version ?? null,
        forwards: engine?.kind === "remote",
        error: null,
      };
    } catch (cause) {
      return { reachable: false, loaded: null, version: null, forwards: null, error: reason(cause) };
    }
  }

  async function voices(signal: AbortSignal): Promise<VoiceInfo[]> {
    const body = (await getJson("/voices", signal)) as { voices?: unknown } | null;
    return z.array(voiceInfoSchema).parse(body?.voices);
  }

  async function* synthesize(chunk: string, opts: SynthOpts, signal: AbortSignal): AsyncGenerator<Pcm> {
    const { voice, speed, lang, trim } = opts;
    let res: Response;
    try {
      res = await fetchImpl(`${base}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kokoro-Frames": "2", "X-Kokoro-Hop": "1" },
        body: JSON.stringify({ text: chunk, voice, speed, lang, trim }),
        signal,
      });
    } catch (cause) {
      if (signal.aborted) throw new EngineError("cancelled", "cancelled");
      throw new EngineError("unreachable", `unreachable: ${reason(cause)}`);
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      throw new EngineError("unreachable", `unreachable: HTTP ${res.status} from ${base}`, res.status);
    }
    if (res.status === 409) {
      await res.body?.cancel().catch(() => undefined);
      throw new EngineError("config", FORWARDS, 409);
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string; fields?: Record<string, string> } | null;
      const detail = err?.fields ? Object.entries(err.fields).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
      throw new EngineError("config", `${err?.error ?? `HTTP ${res.status}`}${detail ? ` — ${detail}` : ""}`, res.status);
    }
    if (!res.body) throw new EngineError("stream", "the Kokoro server returned no audio");
    let frames = 0;
    try {
      for await (const frame of readFrames(res.body, { markers: res.headers.get("X-Kokoro-Frames") === "2" })) {
        frames++;
        yield frame;
      }
    } catch (cause) {
      if (signal.aborted) throw new EngineError("cancelled", "cancelled");
      throw new EngineError("stream", reason(cause));
    }
    if (frames === 0) throw new EngineError("stream", "the Kokoro server returned no audio");
  }

  return { url: base, health, voices, synthesize };
}
