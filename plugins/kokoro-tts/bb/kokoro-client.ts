// Typed HTTP client for the Kokoro Python server.
export class ServerError extends Error {
  readonly fields: Record<string, string> | undefined;
  constructor(message: string, fields?: Record<string, string>) {
    super(message);
    this.fields = fields;
  }
}

export type HttpMethod = "GET" | "POST" | "PATCH";

export interface KokoroClient {
  readonly baseUrl: string;
  call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
  synthesize(text: string, signal: AbortSignal): AsyncGenerator<Uint8Array>;
}

export function createKokoroClient(baseUrl: string, fetchImpl: typeof fetch = fetch): KokoroClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), method === "PATCH" ? 30_000 : 4_000);
    let response: Response;
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
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
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

  async function* synthesize(text: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const res = await fetchImpl(`${base}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok || !res.body) throw new ServerError(`synthesize failed (HTTP ${res.status})`);
    yield* readFrames(res.body);
  }

  return { baseUrl: base, call, synthesize };
}

/** Parse the server's `/synthesize` stream: 4-byte LE length, then float32 PCM. */
export async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let buf = new Uint8Array(0);
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
        if (buf.length < 4 + n) break;
        yield buf.slice(4, 4 + n);
        buf = buf.slice(4 + n);
      }
    }
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
