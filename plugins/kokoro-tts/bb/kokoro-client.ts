// Typed HTTP client for the Kokoro Python server.
export class ServerError extends Error {
  readonly fields: Record<string, string> | undefined;
  constructor(message: string, fields?: Record<string, string>) {
    super(message);
    this.fields = fields;
  }
}

export type HttpMethod = "GET" | "POST" | "PATCH";

export interface SynthOptions {
  voice?: string | Record<string, number>;
  speed?: number;
  lang?: string;
}

export interface KokoroClient {
  readonly baseUrl: string;
  call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
  synthesize(text: string, signal: AbortSignal, opts?: SynthOptions): AsyncGenerator<Uint8Array>;
}

const FRAME_END = 0;
const FRAME_ERROR = 0xffffffff;

export function createKokoroClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeouts: { default: number; patch: number } = { default: 4_000, patch: 30_000 },
): KokoroClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    // The deadline covers the body too: a server that sends headers and then
    // stalls (a model load blocking its loop) must not hang the caller.
    const timer = setTimeout(() => controller.abort(), method === "PATCH" ? timeouts.patch : timeouts.default);
    let response: Response;
    let text: string;
    try {
      try {
        response = await fetchImpl(`${base}${path}`, {
          method,
          headers: body === undefined ? undefined : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new ServerError(`Kokoro server unreachable at ${base} (${reason})`);
      }
      try {
        text = await response.text();
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new ServerError(`Kokoro server stopped responding at ${base} (${reason})`);
      }
    } finally {
      clearTimeout(timer);
    }
    let data: unknown = null;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      throw new ServerError(`Kokoro server returned non-JSON (${response.status})`);
    }
    if (!response.ok) {
      const err = (data ?? {}) as { error?: string; fields?: Record<string, string> };
      const detail = err.fields ? Object.entries(err.fields).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
      throw new ServerError(`${err.error ?? `HTTP ${response.status}`}${detail ? ` — ${detail}` : ""}`, err.fields);
    }
    return data as T;
  }

  async function* synthesize(text: string, signal: AbortSignal, opts: SynthOptions = {}): AsyncGenerator<Uint8Array> {
    const res = await fetchImpl(`${base}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kokoro-Frames": "2" },
      body: JSON.stringify({ text, ...opts }),
      signal,
    });
    if (!res.ok || !res.body) throw new ServerError(`synthesize failed (HTTP ${res.status})`);
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
  let buf = new Uint8Array(0);
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
      while (buf.length >= 4) {
        const n = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
        if (opts.markers && n === FRAME_END) { ended = true; return; }
        if (opts.markers && n === FRAME_ERROR) throw new ServerError("synthesis failed mid-reply");
        if (n % 4 !== 0) throw new ServerError(`frame of ${n} bytes is not float32 audio`);
        if (buf.length < 4 + n) break;
        yield buf.slice(4, 4 + n);
        buf = buf.slice(4 + n);
      }
    }
    if (buf.length > 0 || (opts.markers && !ended)) throw new ServerError("synthesis stream ended early");
  } finally {
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
