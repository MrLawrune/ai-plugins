import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS } from "./prefs.ts";
import { createStreamRelay, type PageSocket, type UpstreamSocket } from "./stream-relay.ts";

function page() {
  const sent: (string | Uint8Array)[] = [];
  const s: PageSocket & { sent: typeof sent; closed: number | null } = {
    sent, closed: null, readyState: 1,
    send(d) { sent.push(d); },
    close(code) { this.closed = code ?? 1000; },
  };
  return s;
}

function upstream() {
  const sent: (string | Uint8Array)[] = [];
  const u: UpstreamSocket & { sent: typeof sent; closedWith: number | null; url?: string } = {
    sent, closedWith: null, binaryType: "blob", readyState: 0,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(d) { sent.push(d); },
    close(code) { this.closedWith = code ?? 1000; },
  };
  return u;
}

const LIMITS = {
  maxSessions: 4, connectTimeoutMs: 10_000, idleTimeoutMs: 60_000,
  setTimer: (fn: () => void, ms: number): unknown => setTimeout(fn, ms).unref(),
  clearTimer: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  signal: new AbortController().signal,
};

type Session = { text: string; durationMs: number; deviceId: string | null };

function relay(serverUrl = "https://stt.example", devices: (string | null)[] = [], sessions: Session[] = [], now: () => number = () => 0, onSession?: (s: Session) => void) {
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

test("start opens upstream with key and prefs, then pipes both ways", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  assert.equal(up.url, "wss://stt.example/v1/stream");
  up.readyState = 1; up.onopen!();
  const start = JSON.parse(up.sent[0] as string);
  assert.equal(start.type, "start");
  assert.equal(start.api_key, "k");
  assert.deepEqual(start.options.custom_words, ["tmux"]);
  handler.onMessage(p, new Uint8Array([1, 2]));
  assert.deepEqual(up.sent[1], new Uint8Array([1, 2]));
  up.onmessage!({ data: '{"type":"ready"}' });
  assert.deepEqual(p.sent, ['{"type":"ready"}']);
});

test("uses the prefs of the device named in the start message", () => {
  const devices: (string | null)[] = [];
  const { up, handler } = relay("https://stt.example", devices);
  handler.onMessage(page(), '{"type":"start","device":"phone-1"}');
  up.readyState = 1; up.onopen!();
  assert.deepEqual(devices, ["phone-1"]);
  assert.equal(JSON.parse(up.sent[0] as string).options.pause_ms, 900);
});

test("queues frames until upstream opens", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  handler.onMessage(p, new Uint8Array([7]));
  handler.onMessage(p, '{"type":"stop"}');
  assert.equal(up.sent.length, 0);
  up.readyState = 1; up.onopen!();
  assert.equal(JSON.parse(up.sent[0] as string).type, "start");
  assert.deepEqual(up.sent.slice(1), [new Uint8Array([7]), '{"type":"stop"}']);
});

test("abnormal upstream close tells the page", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  up.onclose!({ code: 1006, reason: "" });
  assert.deepEqual(p.sent.map((m) => JSON.parse(m as string).type), ["error", "ended"]);
  assert.equal(JSON.parse(p.sent[1] as string).reason, "error");
  assert.ok(p.closed !== null);
});

test("server rejection message is forwarded before ended", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  up.onmessage!({ data: '{"type":"error","message":"Invalid or missing API key"}' });
  up.onclose!({ code: 4401, reason: "Invalid or missing API key" });
  assert.equal(JSON.parse(p.sent[0] as string).message, "Invalid or missing API key");
  assert.deepEqual(p.sent.map((m) => JSON.parse(m as string).type), ["error", "ended"]); // one error, not two
});

test("no server url -> error + ended without connecting", () => {
  const { up, handler } = relay("");
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  assert.equal(up.url, undefined);
  assert.deepEqual(p.sent.map((m) => JSON.parse(m as string).type), ["error", "ended"]);
});

test("page closing closes upstream", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  handler.onClose();
  assert.equal(up.closedWith, 1000);
});

test("ended from server passes through and does not add a second ended", () => {
  const { up, handler } = relay();
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  up.onmessage!({ data: '{"type":"ended","reason":"stopped"}' });
  up.onclose!({ code: 1000, reason: "" });
  assert.equal(p.sent.filter((m) => (m as string).includes('"ended"')).length, 1);
});

test("two finals then ended -> onSession once with the joined text", () => {
  const sessions: Session[] = [];
  let t = 1000;
  const { up, handler } = relay("https://stt.example", [], sessions, () => t);
  const p = page();
  handler.onMessage(p, '{"type":"start","device":"phone-1"}');
  up.onmessage!({ data: '{"type":"final","text":"one"}' });
  up.onmessage!({ data: '{"type":"partial","text":"tw"}' });
  up.onmessage!({ data: '{"type":"final","text":"two"}' });
  t = 3500;
  up.onmessage!({ data: '{"type":"ended","reason":"stopped"}' });
  up.onclose!({ code: 1000, reason: "" });
  handler.onClose();
  assert.deepEqual(sessions, [{ text: "one two", durationMs: 2500, deviceId: "phone-1" }]);
});

test("page closing mid-session logs the finals heard so far, once", () => {
  const sessions: Session[] = [];
  const { up, handler } = relay("https://stt.example", [], sessions);
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  up.onmessage!({ data: '{"type":"final","text":"half"}' });
  handler.onClose();
  handler.onClose();
  assert.deepEqual(sessions.map((s) => [s.text, s.deviceId]), [["half", null]]);
});

test("upstream closing without ended logs the finals once", () => {
  const sessions: Session[] = [];
  const { up, handler } = relay("https://stt.example", [], sessions);
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  up.onmessage!({ data: '{"type":"final","text":"kept"}' });
  up.onclose!({ code: 1006, reason: "" });
  handler.onClose();
  assert.deepEqual(sessions.map((s) => s.text), ["kept"]);
});

test("a session with no finals is not logged", () => {
  const sessions: Session[] = [];
  const { up, handler } = relay("https://stt.example", [], sessions);
  const p = page();
  handler.onMessage(p, '{"type":"start"}');
  up.onmessage!({ data: '{"type":"partial","text":"x"}' });
  up.onmessage!({ data: '{"type":"final","text":"  "}' });
  up.onmessage!({ data: '{"type":"ended","reason":"stopped"}' });
  handler.onClose();
  assert.deepEqual(sessions, []);
});

test("messages without a final are not JSON-parsed", () => {
  const sessions: Session[] = [];
  const { up, handler } = relay("https://stt.example", [], sessions);
  handler.onMessage(page(), '{"type":"start"}');
  const realParse = JSON.parse;
  let parses = 0;
  JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { parses++; return realParse(...a); }) as typeof JSON.parse;
  try {
    up.onmessage!({ data: '{"type":"partial","text":"x"}' });
    up.onmessage!({ data: '{"type":"ready"}' });
  } finally { JSON.parse = realParse; }
  assert.equal(parses, 0);
});

test("a failing history write does not stop cleanup: upstream closes and the page still gets ended", () => {
  const boom = () => { throw new Error("db closed"); };
  const a = relay("https://stt.example", [], [], () => 0, boom);
  const p = page();
  a.handler.onMessage(p, '{"type":"start"}');
  a.up.onmessage!({ data: '{"type":"final","text":"x"}' });
  a.up.onmessage!({ data: '{"type":"ended","reason":"stopped"}' });
  assert.deepEqual(p.sent.map((m) => JSON.parse(m as string).type), ["final", "ended"]);
  a.up.onclose!({ code: 1000, reason: "" });
  assert.equal(p.closed, 1000);

  const b = relay("https://stt.example", [], [], () => 0, boom);
  const p2 = page();
  b.handler.onMessage(p2, '{"type":"start"}');
  b.up.onmessage!({ data: '{"type":"final","text":"x"}' });
  assert.doesNotThrow(() => b.handler.onClose());
  assert.equal(b.up.closedWith, 1000);
});

// Bounded relay: session cap, connect/idle timeouts, closeAll, abort signal.
function rig(over: { maxSessions?: number; signal?: AbortSignal } = {}) {
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

test("the 5th concurrent session is rejected with 4429 and takes no slot", () => {
  const r = rig();
  const open = [r.start(), r.start(), r.start(), r.start()];
  assert.equal(r.relay.active(), 4);
  const fifth = r.start();
  assert.equal(JSON.parse(fifth.p.sent[0] as string).message, "Too many dictation sessions");
  assert.equal(fifth.p.closed, 4429);
  assert.equal(r.ups.length, 4);
  assert.equal(r.relay.active(), 4);
  fifth.h.onClose();
  assert.equal(r.relay.active(), 4);
  open[0]!.h.onClose();
  assert.equal(r.relay.active(), 3);
  const again = r.start();
  assert.equal(again.p.closed, null);
  assert.equal(r.relay.active(), 4);
});

test("a finished session frees its slot (ended + upstream close)", () => {
  const r = rig({ maxSessions: 1 });
  const a = r.start();
  r.ups[0]!.onmessage!({ data: '{"type":"ended","reason":"stopped"}' });
  r.ups[0]!.onclose!({ code: 1000, reason: "" });
  a.h.onClose();
  assert.equal(r.relay.active(), 0);
  assert.equal(r.start().p.closed, null);
});

test("no upstream open within the connect timeout closes both with an error", () => {
  const r = rig();
  const { p } = r.start();
  assert.equal(r.live(10_000).length, 1);
  r.fire(10_000);
  assert.deepEqual(r.types(p), ["error", "ended"]);
  assert.equal(JSON.parse(p.sent[0] as string).message, "Parakeet STT server did not answer");
  assert.equal(p.closed, 1011);
  assert.notEqual(r.ups[0]!.closedWith, null);
  assert.equal(r.relay.active(), 0);
  assert.equal(r.live(60_000).length, 0, "idle timer stopped too");
});

test("the connect timer is cleared when upstream opens", () => {
  const r = rig();
  r.start();
  r.ups[0]!.readyState = 1; r.ups[0]!.onopen!();
  assert.equal(r.live(10_000).length, 0);
  assert.equal(r.live(60_000).length, 1);
});

test("a connect timeout reports history exactly once", () => {
  const r = rig();
  const { p, h } = r.start();
  r.ups[0]!.onmessage!({ data: '{"type":"final","text":"early"}' });
  r.fire(10_000);
  h.onClose();
  r.ups[0]!.onclose!({ code: 1006, reason: "" });
  assert.deepEqual(r.sessions.map((s) => s.text), ["early"]);
  assert.equal(p.closed, 1011);
});

test("no binary frame for 60 s ends the session with the idle error; each frame resets the timer", () => {
  const r = rig();
  const { p, h } = r.start();
  r.ups[0]!.readyState = 1; r.ups[0]!.onopen!();
  const before = r.live(60_000)[0]!;
  h.onMessage(p, new Uint8Array([1]));
  assert.equal(before.live, false, "old idle timer replaced");
  assert.equal(r.live(60_000).length, 1);
  h.onMessage(p, '{"type":"stop"}'); // control frames do not reset it
  assert.equal(r.live(60_000).length, 1);
  r.ups[0]!.onmessage!({ data: '{"type":"final","text":"said"}' });
  r.fire(60_000);
  assert.deepEqual(r.types(p), ["error", "ended"]);
  assert.equal(JSON.parse(p.sent.at(-2) as string).message, "Dictation idle for 60 s");
  assert.equal(JSON.parse(p.sent.at(-1) as string).reason, "error");
  assert.equal(p.closed, 1011);
  assert.notEqual(r.ups[0]!.closedWith, null);
  assert.equal(r.relay.active(), 0);
  h.onClose();
  assert.deepEqual(r.sessions.map((s) => s.text), ["said"]);
});

test("closeAll closes every page and upstream, frees the slots and reports history once", () => {
  const r = rig();
  const a = r.start(); const b = r.start();
  r.ups[0]!.onmessage!({ data: '{"type":"final","text":"one"}' });
  r.relay.closeAll();
  for (const x of [a, b]) { assert.deepEqual(r.types(x.p), ["error", "ended"]); assert.equal(x.p.closed, 1011); }
  assert.ok(r.ups.every((u) => u.closedWith !== null));
  assert.equal(r.relay.active(), 0);
  assert.equal(r.live(10_000).length + r.live(60_000).length, 0);
  a.h.onClose(); b.h.onClose();
  assert.deepEqual(r.sessions.map((s) => s.text), ["one"]);
});

test("aborting the signal triggers closeAll; a start after abort is refused", () => {
  const ctl = new AbortController();
  const r = rig({ signal: ctl.signal });
  const a = r.start();
  ctl.abort();
  assert.equal(a.p.closed, 1011);
  assert.notEqual(r.ups[0]!.closedWith, null);
  const late = r.start();
  assert.equal(late.p.closed, 1011);
  assert.equal(r.ups.length, 1, "no upstream after abort");
});
