// Typed HTTP client for the Kokoro Python server.
export class ServerError extends Error {
  readonly fields: Record<string, string> | undefined;
  /** HTTP status when the server answered; undefined when it could not be reached. */
  readonly status: number | undefined;
  constructor(message: string, fields?: Record<string, string>, status?: number) {
    super(message);
    this.fields = fields;
    this.status = status;
  }
}

export type HttpMethod = "GET" | "POST" | "PATCH";

export interface SynthOptions {
  voice?: string | Record<string, number>;
  speed?: number;
  lang?: string;
  /** Previews pick one engine: no failover. */
  slot?: "main" | "backup";
}

export interface KokoroClient {
  readonly baseUrl: string;
  /** `signal` cancels the call too (it also has its own timeout). */
  call<T>(method: HttpMethod, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  synthesize(text: string, signal: AbortSignal, opts?: SynthOptions): AsyncGenerator<Uint8Array>;
}

const FRAME_END = 0;
const FRAME_ERROR = 0xffffffff;
/**
 * Largest wire frame accepted. The server sends one frame per model batch
 * (about 2.4 MB for a long sentence at half speed); the chain re-slices them.
 */
export const WIRE_FRAME_MAX = 16 << 20;

export function createKokoroClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeouts: { default: number; patch: number } = { default: 4_000, patch: 30_000 },
): KokoroClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function call<T>(method: HttpMethod, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    // The deadline covers the body too: a server that sends headers and then
    // stalls (a model load blocking its loop) must not hang the caller.
    const timer = setTimeout(() => controller.abort(), method === "PATCH" ? timeouts.patch : timeouts.default);
    const cancelled = () => (signal?.aborted ? new ServerError(`cancelled: ${method} ${path}`) : null);
    let response: Response;
    let text: string;
    try {
      try {
        response = await fetchImpl(`${base}${path}`, {
          method,
          headers: body === undefined ? undefined : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw cancelled() ?? new ServerError(`Kokoro server unreachable at ${base} (${reason})`);
      }
      try {
        text = await response.text();
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw cancelled() ?? new ServerError(`Kokoro server stopped responding at ${base} (${reason})`);
      }
    } finally {
      clearTimeout(timer);
    }
    let data: unknown = null;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      throw new ServerError(`Kokoro server returned non-JSON (${response.status})`, undefined, response.status);
    }
    if (!response.ok) {
      const err = (data ?? {}) as { error?: string; fields?: Record<string, string> };
      const detail = err.fields ? Object.entries(err.fields).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
      throw new ServerError(`${err.error ?? `HTTP ${response.status}`}${detail ? ` — ${detail}` : ""}`, err.fields, response.status);
    }
    return data as T;
  }

  async function* synthesize(text: string, signal: AbortSignal, opts: SynthOptions = {}): AsyncGenerator<Uint8Array> {
    const { slot: _slot, ...params } = opts;
    const res = await fetchImpl(`${base}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kokoro-Frames": "2" },
      body: JSON.stringify({ text, ...params }),
      signal,
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new ServerError(`synthesize failed (HTTP ${res.status})`);
    }
    let frames = 0;
    for await (const frame of readFrames(res.body, { markers: res.headers.get("X-Kokoro-Frames") === "2" })) {
      frames++;
      yield frame;
    }
    if (frames === 0) throw new ServerError("the Kokoro server returned no audio");
  }

  return { baseUrl: base, call, synthesize };
}

/**
 * Parse the server's `/synthesize` stream: 4-byte LE length, then float32 PCM.
 * With markers (the server echoed `X-Kokoro-Frames: 2`), a zero length ends the
 * reply and 0xFFFFFFFF reports a failure after audio was sent.
 */
export async function* readFrames(
  body: ReadableStream<Uint8Array>,
  opts: { markers?: boolean } = {},
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  // Received bytes not yet yielded, kept as chunks so a large frame is copied once.
  let parts: Uint8Array[] = [];
  let have = 0;
  /** Removes and returns the first n buffered bytes. */
  const take = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const p = parts[0];
      const k = Math.min(p.length, n - o);
      out.set(p.subarray(0, k), o);
      o += k;
      if (k === p.length) parts.shift();
      else parts[0] = p.subarray(k);
    }
    have -= n;
    return out;
  };
  let ended = false;
  let need: number | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length === 0) continue;
      parts.push(value);
      have += value.length;
      for (;;) {
        if (need === null) {
          if (have < 4) break;
          const head = take(4);
          const n = new DataView(head.buffer).getUint32(0, true);
          if (opts.markers && n === FRAME_END) { ended = true; return; }
          if (opts.markers && n === FRAME_ERROR) throw new ServerError("synthesis failed mid-reply");
          if (n % 4 !== 0) throw new ServerError(`bad frame length ${n}`);
          if (n > WIRE_FRAME_MAX) throw new ServerError(`frame too large (${n} bytes)`);
          need = n;
        }
        if (have < need) break;
        const frame = take(need);
        need = null;
        yield frame;
      }
    }
    if (have > 0 || need !== null || (opts.markers && !ended)) throw new ServerError("synthesis stream ended early");
  } finally {
    parts = [];
    await reader.cancel().catch(() => undefined);
  }
}

export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export function portOf(url: string): number {
  const u = new URL(url);
  return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
}
