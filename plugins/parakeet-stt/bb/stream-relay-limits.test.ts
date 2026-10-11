import { test } from "node:test";
import assert from "node:assert/strict";
import { page, rig } from "./test-relay.ts";

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

test("closeAll after an ended frame closes the page too, without waiting for the upstream close", () => {
  const r = rig();
  const { p } = r.start();
  r.ups[0]!.onmessage!({ data: '{"type":"ended","reason":"stopped"}' });
  assert.equal(p.closed, null);
  r.relay.closeAll();
  assert.notEqual(p.closed, null);
  assert.notEqual(r.ups[0]!.closedWith, null);
  assert.equal(r.relay.active(), 0);
  r.relay.closeAll(); // idempotent
  r.ups[0]!.onclose!({ code: 1001, reason: "" });
  assert.equal(p.sent.filter((m) => (m as string).includes('"ended"')).length, 1);
});

test("an upstream that never opened reads as unreachable, naming the server", () => {
  const r = rig();
  const { p } = r.start();
  r.ups[0]!.onclose!({ code: 1006, reason: "" });
  assert.equal(JSON.parse(p.sent[0] as string).message, "Can't reach the Parakeet server at https://stt.example");
  assert.deepEqual(r.types(p), ["error", "ended"]);
  const open = r.start();
  r.ups[1]!.readyState = 1; r.ups[1]!.onopen!();
  r.ups[1]!.onclose!({ code: 1006, reason: "" });
  assert.equal(JSON.parse(open.p.sent[0] as string).message, "Parakeet STT stream closed (1006)");
});
