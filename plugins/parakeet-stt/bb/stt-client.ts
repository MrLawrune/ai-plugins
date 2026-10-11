// Typed client for the Parakeet STT server.
export const MODEL_ID = "parakeet-tdt-0.6b-v2";

export type SttErrorCode =
  | "not_configured" | "unreachable" | "timeout" | "unauthorized"
  | "bad_request" | "unavailable" | "server_error" | "invalid_response";

export class SttError extends Error {
  readonly code: SttErrorCode;
  readonly status: number | null;
  constructor(code: SttErrorCode, message: string, status: number | null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface SttConfig { serverUrl: string; apiKey: string }
export interface TranscribeOptions {
  customWords: string[];
  removeFillers: boolean;
  correctionThreshold: number;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface SttHealth { status: string; version: string; model: string; ready: boolean; uptime_s: number }
export interface SttClient {
  health(timeoutMs?: number): Promise<SttHealth>;
  transcribe(audio: Uint8Array<ArrayBuffer>, mimeType: string, filename: string, opts: TranscribeOptions): Promise<string>;
}

function codeForStatus(status: number): SttErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 503) return "unavailable";
  if (status >= 500) return "server_error";
  return "bad_request";
}

interface Reply { status: number; ok: boolean; data: unknown }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The body the server sends with HTTP 503 from /health while its model loads. */
function loadingHealth(data: unknown): SttHealth | null {
  if (!isRecord(data) || data.ready !== false || typeof data.model !== "string" || typeof data.version !== "string") return null;
  return { status: typeof data.status === "string" ? data.status : "loading", version: data.version, model: data.model, ready: false, uptime_s: typeof data.uptime_s === "number" ? data.uptime_s : 0 };
}

export function createSttClient(config: SttConfig, fetchImpl: typeof fetch = fetch): SttClient {
  const base = config.serverUrl.trim().replace(/\/+$/, "");

  /** One request, deadline and cancellation covering the headers and the whole body. */
  async function call(path: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal): Promise<Reply> {
    if (!base) throw new SttError("not_configured", "Parakeet STT server URL is not set", null);
    const ctl = new AbortController();
    let timedOut = false;
    const failure = (cause: unknown): SttError => {
      if (timedOut) return new SttError("timeout", `Parakeet STT server did not answer within ${timeoutMs} ms`, null);
      const reason = cause instanceof Error ? cause.message : String(cause);
      return new SttError("unreachable", `Parakeet STT server unreachable at ${base} (${reason})`, null);
    };
    if (outer?.aborted) throw failure("aborted");
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    const relay = () => ctl.abort();
    outer?.addEventListener("abort", relay, { once: true });
    try {
      let res: Response;
      try {
        res = await fetchImpl(`${base}${path}`, { ...init, signal: ctl.signal });
      } catch (cause) {
        throw failure(cause);
      }
      let data: unknown = null;
      try {
        data = await res.json();
      } catch (cause) {
        if (ctl.signal.aborted) throw failure(cause);
        data = null; // not JSON: the status decides
      }
      return { status: res.status, ok: res.ok, data };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", relay);
    }
  }

  const httpError = ({ status, data }: Reply): SttError => {
    const msg = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${status}`;
    return new SttError(codeForStatus(status), `Parakeet STT: ${msg}`, status);
  };

  const auth = (): Record<string, string> => (config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {});

  return {
    async health(timeoutMs = 4000) {
      const reply = await call("/health", { method: "GET", headers: auth() }, timeoutMs);
      if (reply.ok) return reply.data as SttHealth;
      const loading = reply.status === 503 ? loadingHealth(reply.data) : null;
      if (loading) return loading;
      throw httpError(reply);
    },
    async transcribe(audio, mimeType, filename, opts) {
      const form = new FormData();
      form.set("file", new File([audio], filename, { type: mimeType }));
      form.set("model", MODEL_ID);
      form.set("custom_words", JSON.stringify(opts.customWords));
      form.set("remove_fillers", String(opts.removeFillers));
      form.set("correction_threshold", String(opts.correctionThreshold));
      const reply = await call("/v1/audio/transcriptions", { method: "POST", headers: auth(), body: form }, opts.timeoutMs, opts.signal);
      if (!reply.ok) throw httpError(reply);
      const text = (reply.data as { text?: unknown } | null)?.text;
      if (typeof text !== "string") throw new SttError("invalid_response", "Parakeet STT returned no text", null);
      return text;
    },
  };
}
