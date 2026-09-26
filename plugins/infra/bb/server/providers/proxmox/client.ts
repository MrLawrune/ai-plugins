// Minimal Proxmox VE API client: GET only (plus the login ticket), token or password auth.
import { fetch as undiciFetch, type Dispatcher } from "undici";
import type { HealthCode } from "../types.ts";
import { createDispatcher, TlsPinError, type TlsMode } from "./tls.ts";

export type Auth = { kind: "token"; tokenId: string; secret: string } | { kind: "password"; username: string; password: string };

export interface ClientOptions {
  baseUrl: string;
  auth: Auth;
  tls: TlsMode;
  timeoutMs?: number;
  now?: () => number;
}

export class PveError extends Error {
  override name = "PveError";
  readonly code: HealthCode;
  readonly status: number | null;
  constructor(code: HealthCode, message: string, status: number | null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Tickets are valid for 2 h; renew well before. */
const TICKET_TTL_MS = 90 * 60_000;
const TLS_CODE = /^(ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT)/;

function classify(e: unknown): PveError {
  if (e instanceof PveError) return e;
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof TlsPinError) return new PveError("tls-mismatch", cur.message, null);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && TLS_CODE.test(code)) return new PveError("tls-mismatch", (cur as Error).message, null);
    cur = (cur as { cause?: unknown }).cause;
  }
  const inner = e instanceof Error && e.cause instanceof Error ? e.cause : e;
  return new PveError("unreachable", inner instanceof Error ? inner.message : String(inner), null);
}

export class PveClient {
  private readonly dispatcher: Dispatcher;
  private readonly base: string;
  private readonly opts: ClientOptions;
  private ticket: { value: string; at: number } | null = null;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.dispatcher = createDispatcher(opts.tls);
    this.base = opts.baseUrl.replace(/\/+$/, "") + "/api2/json";
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async request(method: "GET" | "POST", path: string, init: { headers: Record<string, string>; body?: string }, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 5000);
    try {
      return await undiciFetch(this.base + path, {
        method,
        headers: init.headers,
        body: init.body,
        dispatcher: this.dispatcher,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw classify(e);
    }
  }

  private async login(signal?: AbortSignal): Promise<string> {
    const a = this.opts.auth as Extract<Auth, { kind: "password" }>;
    const body = new URLSearchParams({ username: a.username, password: a.password }).toString();
    const res = await this.request("POST", "/access/ticket", { headers: { "content-type": "application/x-www-form-urlencoded" }, body }, signal);
    if (res.status === 401 || res.status === 403) throw new PveError("auth-failed", "login rejected", res.status);
    if (!res.ok) throw new PveError("degraded", `login failed: HTTP ${res.status}`, res.status);
    const json = (await res.json()) as { data?: { ticket?: string } };
    if (!json.data?.ticket) throw new PveError("auth-failed", "login returned no ticket", res.status);
    this.ticket = { value: json.data.ticket, at: this.now() };
    return json.data.ticket;
  }

  private async authHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    const a = this.opts.auth;
    if (a.kind === "token") return { authorization: `PVEAPIToken=${a.tokenId}=${a.secret}` };
    const fresh = this.ticket && this.now() - this.ticket.at < TICKET_TTL_MS;
    return { cookie: `PVEAuthCookie=${fresh ? this.ticket!.value : await this.login(signal)}` };
  }

  async get<T>(path: string, query?: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
    const qs = query ? "?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : "";
    let res = await this.request("GET", path + qs, { headers: await this.authHeaders(signal) }, signal);
    if (res.status === 401 && this.opts.auth.kind === "password") {
      await res.body?.cancel();
      this.ticket = null;
      res = await this.request("GET", path + qs, { headers: await this.authHeaders(signal) }, signal);
    }
    if (res.status === 401 || res.status === 403) throw new PveError("auth-failed", `HTTP ${res.status} for ${path}`, res.status);
    if (!res.ok) throw new PveError("degraded", `HTTP ${res.status} for ${path}`, res.status);
    return ((await res.json()) as { data: T }).data;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}
