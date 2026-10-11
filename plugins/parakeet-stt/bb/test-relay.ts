// Fixtures for the stream relay tests: fake page and upstream sockets, and a relay wired to them.
import { DEFAULT_PREFS } from "./prefs.ts";
import { createStreamRelay, type PageSocket, type UpstreamSocket } from "./stream-relay.ts";

export function page() {
  const sent: (string | Uint8Array)[] = [];
  const s: PageSocket & { sent: typeof sent; closed: number | null } = {
    sent, closed: null, readyState: 1,
    send(d) { sent.push(d); },
    close(code) { this.closed = code ?? 1000; },
  };
  return s;
}

export function upstream() {
  const sent: (string | Uint8Array)[] = [];
  const u: UpstreamSocket & { sent: typeof sent; closedWith: number | null; url?: string } = {
    sent, closedWith: null, binaryType: "blob", readyState: 0,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(d) { sent.push(d); },
    close(code) { this.closedWith = code ?? 1000; },
  };
  return u;
}

export const LIMITS = {
  maxSessions: 4, connectTimeoutMs: 10_000, idleTimeoutMs: 60_000,
  setTimer: (fn: () => void, ms: number): unknown => setTimeout(fn, ms).unref(),
  clearTimer: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  signal: new AbortController().signal,
};

export type Session = { text: string; durationMs: number; deviceId: string | null };

export function relay(serverUrl = "https://stt.example", devices: (string | null)[] = [], sessions: Session[] = [], now: () => number = () => 0, onSession?: (s: Session) => void) {
  const up = upstream();
  const handler = createStreamRelay({
    config: () => ({ serverUrl, apiKey: "k" }),
    prefs: (device) => { devices.push(device); return { ...DEFAULT_PREFS, customWords: ["tmux"], pauseMs: device === "phone-1" ? 900 : 600 }; },
    connect: (url) => { up.url = url; return up; },
    log: () => {},
    onSession: onSession ?? ((s) => { sessions.push(s); }),
    now,
    ...LIMITS,
  }).handler();
  return { up, handler };
}


// A relay with a controllable timer list, for the session cap, the timeouts and closeAll.
export function rig(over: { maxSessions?: number; signal?: AbortSignal } = {}) {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const ups: ReturnType<typeof upstream>[] = [];
  const sessions: Session[] = [];
  const relay = createStreamRelay({
    config: () => ({ serverUrl: "https://stt.example", apiKey: "k" }),
    prefs: () => DEFAULT_PREFS,
    connect: () => { const u = upstream(); ups.push(u); return u; },
    log: () => {},
    onSession: (s) => { sessions.push(s); },
    now: () => 0,
    ...LIMITS,
    maxSessions: over.maxSessions ?? 4,
    signal: over.signal ?? LIMITS.signal,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
  });
  const start = () => {
    const p = page();
    const h = relay.handler();
    h.onMessage(p, '{"type":"start"}');
    return { p, h };
  };
  const live = (ms: number) => timers.filter((t) => t.live && t.ms === ms);
  const fire = (ms: number) => { const t = live(ms)[0]!; t.live = false; t.fn(); };
  const types = (p: ReturnType<typeof page>) => p.sent.map((m) => JSON.parse(m as string).type as string).filter((t) => t === "error" || t === "ended");
  return { relay, ups, sessions, start, live, fire, types };
}

