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
  })();
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
