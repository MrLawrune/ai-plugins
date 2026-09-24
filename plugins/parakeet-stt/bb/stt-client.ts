// Typed client for the Parakeet STT server. Shared by the server entry and the host entry.
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

export function createSttClient(config: SttConfig, fetchImpl: typeof fetch = fetch): SttClient {
  const base = config.serverUrl.trim().replace(/\/+$/, "");

  async function request(path: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal): Promise<unknown> {
    if (!base) throw new SttError("not_configured", "Parakeet STT server URL is not set", null);
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    const relay = () => ctl.abort();
    outer?.addEventListener("abort", relay, { once: true });
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { ...init, signal: ctl.signal });
    } catch (cause) {
      if (timedOut) throw new SttError("timeout", `Parakeet STT server did not answer within ${timeoutMs} ms`, null);
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new SttError("unreachable", `Parakeet STT server unreachable at ${base} (${reason})`, null);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", relay);
    }
    let data: unknown = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const msg = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
      throw new SttError(codeForStatus(res.status), `Parakeet STT: ${msg}`, res.status);
    }
    return data;
  }

  const auth = (): Record<string, string> => (config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {});

  return {
    async health(timeoutMs = 4000) {
      const data = await request("/health", { method: "GET", headers: auth() }, timeoutMs);
      return data as SttHealth;
    },
    async transcribe(audio, mimeType, filename, opts) {
      const form = new FormData();
      form.set("file", new File([audio], filename, { type: mimeType }));
      form.set("model", MODEL_ID);
      form.set("custom_words", JSON.stringify(opts.customWords));
      form.set("remove_fillers", String(opts.removeFillers));
      form.set("correction_threshold", String(opts.correctionThreshold));
      const data = await request("/v1/audio/transcriptions", { method: "POST", headers: auth(), body: form }, opts.timeoutMs, opts.signal);
      const text = (data as { text?: unknown } | null)?.text;
      if (typeof text !== "string") throw new SttError("invalid_response", "Parakeet STT returned no text", null);
      return text;
    },
  };
}

export type AiFailureCode = "timeout" | "rate_limited" | "service_unavailable" | "auth_required" | "request_failed" | "invalid_response";

const AI_CODE: Record<SttErrorCode, AiFailureCode> = {
  not_configured: "auth_required",
  unauthorized: "auth_required",
  unreachable: "service_unavailable",
  unavailable: "service_unavailable",
  server_error: "service_unavailable",
  timeout: "timeout",
  bad_request: "request_failed",
  invalid_response: "invalid_response",
};

export function aiFailure(err: unknown): { ok: false; code: AiFailureCode; message: string } {
  if (err instanceof SttError) return { ok: false, code: AI_CODE[err.code], message: err.message || err.code };
  return { ok: false, code: "service_unavailable", message: err instanceof Error && err.message ? err.message : "Parakeet STT failed" };
}
