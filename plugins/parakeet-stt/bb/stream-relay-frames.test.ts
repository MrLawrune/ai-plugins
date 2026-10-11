import { test } from "node:test";
import assert from "node:assert/strict";
import { page, relay, rig, type Session } from "./test-relay.ts";

// The Python server frames JSON with json.dumps defaults (": " and ", "); the relay must not care.
const py = (o: Record<string, unknown>) => `{${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")}}`;
for (const [style, enc] of [["compact JSON", (o: Record<string, unknown>) => JSON.stringify(o)], ["Python-style JSON", py]] as const) {
  const kinds = (p: ReturnType<typeof page>) => p.sent.map((m) => (JSON.parse(m as string) as { type: string }).type);

  test(`${style}: finals are logged once, joined, on ended; the frames reach the page unchanged`, () => {
    const sessions: Session[] = [];
    let t = 1000;
    const { up, handler } = relay("https://stt.example", [], sessions, () => t);
    const p = page();
    handler.onMessage(p, '{"type":"start","device":"phone-1"}');
    const frames = [enc({ type: "final", seq: 0, text: "one" }), enc({ type: "partial", seq: 1, text: "tw" }), enc({ type: "final", seq: 1, text: "two" })];
    for (const f of frames) up.onmessage!({ data: f });
    t = 3500;
    const ended = enc({ type: "ended", reason: "stopped" });
    up.onmessage!({ data: ended });
    assert.deepEqual(p.sent, [...frames, ended]);
    assert.deepEqual(sessions, [{ text: "one two", durationMs: 2500, deviceId: "phone-1" }]);
    up.onclose!({ code: 1000, reason: "" });
    handler.onClose();
    assert.equal(sessions.length, 1);
  });

  test(`${style}: ended then a normal upstream close 1000 gives the page no error and closes it normally`, () => {
    const r = rig({ maxSessions: 1 });
    const { p, h } = r.start();
    r.ups[0]!.onmessage!({ data: enc({ type: "final", seq: 0, text: "hello" }) });
    r.ups[0]!.onmessage!({ data: enc({ type: "ended", reason: "stopped" }) });
    assert.equal(r.live(60_000).length, 0, "idle timer stopped on ended");
    r.ups[0]!.onclose!({ code: 1000, reason: "" });
    assert.deepEqual(kinds(p), ["final", "ended"]);
    assert.equal(JSON.parse(p.sent[1] as string).reason, "stopped");
    assert.equal(p.closed, 1000);
    assert.equal(r.relay.active(), 0);
    h.onClose();
    assert.deepEqual(r.sessions.map((s) => s.text), ["hello"]);
  });

  test(`${style}: a server error is forwarded once, the close adds only ended`, () => {
    const { up, handler } = relay();
    const p = page();
    handler.onMessage(p, '{"type":"start"}');
    up.onmessage!({ data: enc({ type: "error", message: "Invalid or missing API key" }) });
    up.onclose!({ code: 4401, reason: "Invalid or missing API key" });
    assert.deepEqual(kinds(p), ["error", "ended"]);
    assert.equal(JSON.parse(p.sent[0] as string).message, "Invalid or missing API key");
    assert.equal(JSON.parse(p.sent[1] as string).reason, "error");
  });

  test(`${style}: upstream closing without ended still logs the finals and tells the page`, () => {
    const sessions: Session[] = [];
    const { up, handler } = relay("https://stt.example", [], sessions);
    const p = page();
    handler.onMessage(p, '{"type":"start"}');
    up.onmessage!({ data: enc({ type: "final", seq: 0, text: "kept" }) });
    up.onclose!({ code: 1006, reason: "" });
    assert.deepEqual(kinds(p), ["final", "error", "ended"]);
    assert.deepEqual(sessions.map((s) => s.text), ["kept"]);
  });
}

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

