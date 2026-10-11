// Relays one page stream to the Parakeet server's /v1/stream, adding the API key and prefs so the
// browser never sees the key. Frames sent before the upstream opens are queued (bounded); the number
// of sessions, the connect wait and the time without audio are bounded too.
import type { Prefs } from "./schemas.ts";
import { streamOptionsFrom, upstreamUrl } from "./stream-protocol.ts";

export interface PageSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface UpstreamSocket {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

const MAX_QUEUED_BYTES = 5 * 16000 * 2; // ~5 s of PCM16

/** The `type` and `text` of an upstream JSON object frame; null for anything else (forwarded, ignored for state). */
function parseFrame(data: string): { type?: unknown; text?: unknown } | null {
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "object" && v !== null ? (v as { type?: unknown; text?: unknown }) : null;
  } catch {
    return null;
  }
}

export function createStreamRelay(deps: {
  config(): { serverUrl: string; apiKey: string };
  /** Prefs for the page's device (from its start message; null when it sent none). */
  prefs(device: string | null): Prefs;
  connect(url: string): UpstreamSocket;
  log(msg: string): void;
  /** Called once per session with the joined final texts, when the session finishes. */
  onSession(s: { text: string; durationMs: number; deviceId: string | null }): void;
  now(): number;
  /** Concurrent sessions allowed; the next one is refused with close code 4429. */
  maxSessions: number;
  /** Longest wait for the upstream to open. */
  connectTimeoutMs: number;
  /** Longest stretch without a binary frame from the page. */
  idleTimeoutMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Aborts when the plugin unloads: every session closes. */
  signal: AbortSignal;
}) {
  const sessions = new Set<() => void>();
  const closeAll = () => { for (const close of [...sessions]) close(); };
  if (deps.signal.aborted) closeAll();
  else deps.signal.addEventListener("abort", closeAll, { once: true });

  const handler = () => {
    let up: UpstreamSocket | null = null;
    let open = false;
    let finished = false;
    let sawError = false;
    let queuedBytes = 0;
    const queue: (string | Uint8Array)[] = [];
    const finals: string[] = [];
    let reported = false;
    let pageClosed = false;
    let startedAt = 0;
    let sessionDevice: string | null = null;
    let pageRef: PageSocket | null = null;
    let connectTimer: unknown = null;
    let idleTimer: unknown = null;

    const stopTimers = () => {
      if (connectTimer !== null) deps.clearTimer(connectTimer);
      if (idleTimer !== null) deps.clearTimer(idleTimer);
      connectTimer = idleTimer = null;
    };
    const release = () => { stopTimers(); sessions.delete(closeSession); };
    const closeUp = (code: number, reason: string) => { try { up?.close(code, reason); } catch { /* already closed */ } };
    const closeSession = () => {
      if (pageRef && !finished) end(pageRef, "Parakeet STT is restarting");
      else { closeUp(1001, "plugin stopping"); release(); }
    };
    const armIdle = (page: PageSocket) => {
      if (idleTimer !== null) deps.clearTimer(idleTimer);
      idleTimer = deps.setTimer(() => {
        idleTimer = null;
        end(page, `Dictation idle for ${Math.round(deps.idleTimeoutMs / 1000)} s`);
      }, deps.idleTimeoutMs);
    };

    const report = () => {
      if (reported) return;
      reported = true;
      const text = finals.join(" ").trim();
      if (!text) return;
      // History is best-effort: a failure here must not stop the socket cleanup around it.
      try { deps.onSession({ text, durationMs: deps.now() - startedAt, deviceId: sessionDevice }); }
      catch (e) { deps.log(`dictation history write failed: ${e instanceof Error ? e.message : String(e)}`); }
    };
    const toPage = (page: PageSocket, msg: object) => { if (page.readyState === 1) page.send(JSON.stringify(msg)); };
    const end = (page: PageSocket, message: string | null) => {
      if (finished) return;
      finished = true;
      release();
      closeUp(1000, "stream ended");
      if (message) toPage(page, { type: "error", message });
      toPage(page, { type: "ended", reason: "error" });
      pageClosed = true;
      page.close(1011, "stream ended");
      report();
    };

    const openUpstream = (page: PageSocket, device: string | null) => {
      const { serverUrl, apiKey } = deps.config();
      startedAt = deps.now();
      sessionDevice = device;
      if (!serverUrl.trim()) return end(page, "Parakeet STT server URL is not set");
      let url: string;
      try { url = upstreamUrl(serverUrl); } catch { return end(page, `invalid server URL ${serverUrl}`); }
      if (deps.signal.aborted) return end(page, "Parakeet STT is restarting");
      if (sessions.size >= deps.maxSessions) {
        finished = true;
        toPage(page, { type: "error", message: "Too many dictation sessions" });
        page.close(4429, "busy");
        return;
      }
      let sock: UpstreamSocket;
      try { sock = deps.connect(url); } catch (e) { return end(page, `Parakeet STT connection failed: ${e instanceof Error ? e.message : String(e)}`); }
      up = sock;
      pageRef = page;
      sessions.add(closeSession);
      connectTimer = deps.setTimer(() => {
        connectTimer = null;
        end(page, "Parakeet STT server did not answer");
      }, deps.connectTimeoutMs);
      armIdle(page);
      sock.binaryType = "arraybuffer";
      sock.onopen = () => {
        if (connectTimer !== null) deps.clearTimer(connectTimer);
        connectTimer = null;
        open = true;
        sock.send(JSON.stringify({ type: "start", api_key: apiKey, options: streamOptionsFrom(deps.prefs(device)) }));
        for (const m of queue.splice(0)) sock.send(m);
        queuedBytes = 0;
      };
      sock.onmessage = (ev) => {
        if (typeof ev.data !== "string" || finished) return;
        // Classify by the parsed type, not the text: the server's JSON spacing is its own business.
        const frame = parseFrame(ev.data);
        if (frame) {
          if (frame.type === "final" && typeof frame.text === "string" && frame.text.trim()) finals.push(frame.text.trim());
          else if (frame.type === "ended") { finished = true; stopTimers(); report(); }
          else if (frame.type === "error") sawError = true;
        }
        if (page.readyState === 1) page.send(ev.data);
      };
      sock.onerror = () => deps.log("upstream stream error");
      sock.onclose = (ev) => {
        report();
        if (finished) { release(); if (!pageClosed) page.close(1000, "done"); return; }
        end(page, sawError ? null : ev.reason || `Parakeet STT stream closed (${ev.code})`);
      };
    };

    return {
      onMessage(page: PageSocket, data: string | Uint8Array) {
        if (finished) return;
        if (typeof data === "string") {
          let msg: { type?: unknown; device?: unknown };
          try { msg = JSON.parse(data) as typeof msg; } catch { return; }
          const kind = msg.type;
          if (kind === "start" && !up) return openUpstream(page, typeof msg.device === "string" ? msg.device : null);
          if (kind !== "stop" || !up) return;
        } else if (!up) {
          return;
        } else if (pageRef) armIdle(pageRef);
        if (open && up) up.send(data);
        else if (typeof data === "string" || queuedBytes + data.byteLength <= MAX_QUEUED_BYTES) {
          queue.push(data);
          if (typeof data !== "string") queuedBytes += data.byteLength;
        }
      },
      onClose() {
        finished = true;
        release();
        closeUp(1000, "page closed");
        report();
      },
    };
  };

  return { handler, closeAll, active: () => sessions.size };
}
