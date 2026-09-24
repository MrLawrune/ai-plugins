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

function relay(serverUrl = "https://stt.example") {
  const up = upstream();
  const handler = createStreamRelay({
    config: () => ({ serverUrl, apiKey: "k" }),
    prefs: () => ({ ...DEFAULT_PREFS, customWords: ["tmux"] }),
    connect: (url) => { up.url = url; return up; },
    log: () => {},
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
