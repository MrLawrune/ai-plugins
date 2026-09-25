// Relays one page stream to the Parakeet server's /v1/stream, adding the API key and prefs so the
// browser never sees the key. Frames sent before the upstream opens are queued (bounded).
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

export function createStreamRelay(deps: {
  config(): { serverUrl: string; apiKey: string };
  /** Prefs for the page's device (from its start message; null when it sent none). */
  prefs(device: string | null): Prefs;
  connect(url: string): UpstreamSocket;
  log(msg: string): void;
}) {
  return () => {
    let up: UpstreamSocket | null = null;
    let open = false;
    let finished = false;
    let sawError = false;
    let queuedBytes = 0;
    const queue: (string | Uint8Array)[] = [];

    const toPage = (page: PageSocket, msg: object) => { if (page.readyState === 1) page.send(JSON.stringify(msg)); };
    const end = (page: PageSocket, message: string | null) => {
      if (finished) return;
      finished = true;
      if (message) toPage(page, { type: "error", message });
      toPage(page, { type: "ended", reason: "error" });
      page.close(1011, "stream ended");
    };

    const openUpstream = (page: PageSocket, device: string | null) => {
      const { serverUrl, apiKey } = deps.config();
      if (!serverUrl.trim()) return end(page, "Parakeet STT server URL is not set");
      let url: string;
      try { url = upstreamUrl(serverUrl); } catch { return end(page, `invalid server URL ${serverUrl}`); }
      const sock = deps.connect(url);
      up = sock;
      sock.binaryType = "arraybuffer";
      sock.onopen = () => {
        open = true;
        sock.send(JSON.stringify({ type: "start", api_key: apiKey, options: streamOptionsFrom(deps.prefs(device)) }));
        for (const m of queue.splice(0)) sock.send(m);
        queuedBytes = 0;
      };
      sock.onmessage = (ev) => {
        if (typeof ev.data !== "string" || finished) return;
        if (ev.data.includes('"type":"ended"')) finished = true;
        if (ev.data.includes('"type":"error"')) sawError = true;
        if (page.readyState === 1) page.send(ev.data);
      };
      sock.onerror = () => deps.log("upstream stream error");
      sock.onclose = (ev) => {
        if (finished) { page.close(1000, "done"); return; }
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
        }
        if (open && up) up.send(data);
        else if (typeof data === "string" || queuedBytes + data.byteLength <= MAX_QUEUED_BYTES) {
          queue.push(data);
          if (typeof data !== "string") queuedBytes += data.byteLength;
        }
      },
      onClose() {
        finished = true;
        up?.close(1000, "page closed");
      },
    };
  };
}
