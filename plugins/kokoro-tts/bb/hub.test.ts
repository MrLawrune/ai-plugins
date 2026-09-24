import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientRegistry } from "./clients.ts";
import { PlayerHub, type EntryStatus, type SocketLike } from "./hub.ts";
import type { PlayOn } from "./schemas.ts";

class FakeSocket implements SocketLike {
  sent: (string | Uint8Array)[] = [];
  closed: [number | undefined, string | undefined] | null = null;
  send(d: string | Uint8Array) { this.sent.push(d); }
  close(code?: number, reason?: string) { this.closed = [code, reason]; }
  json() { return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d)); }
  frames() { return this.sent.filter((d) => typeof d !== "string").length; }
}

const tick = () => new Promise((r) => setImmediate(r));

/** Fake clock: setTimer/clearTimer are real (cancelled timers never fire); advance() fires due timers in order. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { pending.set(++seq, { at: now + ms, fn }); return seq; },
    clearTimer: (h: unknown) => { pending.delete(h as number); },
    pending: () => pending.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

function setup(opts: {
  frames?: number; gate?: Promise<void>; gateAt?: number; playOn?: PlayOn; throwAfter?: number; registry?: ClientRegistry;
  clock?: ReturnType<typeof fakeClock>;
} = {}) {
  const clock = opts.clock ?? fakeClock();
  const registry = opts.registry ?? new ClientRegistry();
  const statuses: [number, EntryStatus, unknown][] = [];
  const aborted: boolean[] = [];
  const hub = new PlayerHub({
    registry,
    routing: () => ({ playOn: opts.playOn ?? "follow", pinnedDevice: null }),
    async *synthesize(_text, signal) {
      for (let i = 0; i < (opts.frames ?? 2); i++) {
        if (i === (opts.gateAt ?? 1) && opts.gate) await opts.gate;
        if (signal.aborted) { aborted.push(true); return; }
        if (opts.throwAfter !== undefined && i === opts.throwAfter) throw new Error("synth failed");
        yield new Uint8Array(new Float32Array([i]).buffer);
      }
    },
    reportStatus: async (id, s, extra) => { statuses.push([id, s, extra]); },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const connect = (id: string, focusedAt: number, unlocked = true) => {
    const s = new FakeSocket();
    hub.onMessage(s, JSON.stringify({ type: "hello", clientId: id, deviceName: id, focusedAt, audioUnlocked: unlocked }));
    return s;
  };
  const status = (s: FakeSocket, entryId: number, st: string) =>
    hub.onMessage(s, JSON.stringify({ type: "status", entryId, status: st, firstAudioMs: 300 }));
  return { hub, registry, statuses, clock, aborted, connect, status };
}

test("speak streams frames and end to the followed window only", async () => {
  const { hub, connect } = setup();
  const a = connect("a", 10);
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  assert.deepEqual(b.json(), [
    { type: "speak", entryId: 7, sessionId: "t1", sampleRate: 24000, gain: 1 },
    { type: "end", entryId: 7 },
  ]);
  assert.equal(b.frames(), 2);
  assert.equal(a.sent.length, 0);
});

test("playing then done reports both statuses", async () => {
  const { hub, connect, status, statuses } = setup();
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  status(b, 7, "playing");
  status(b, 7, "done");
  await tick();
  assert.deepEqual(statuses.map(([id, s]) => [id, s]), [[7, "playing"], [7, "done"]]);
});

test("no window -> error no client", async () => {
  const { hub, statuses } = setup();
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  assert.deepEqual(statuses, [[7, "error", { error: "no client" }]]);
});

test("missing ack fails over once to the next window with buffered frames", async () => {
  const { hub, connect, clock, statuses } = setup();
  const a = connect("a", 10);
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  clock.advance(2_999);
  assert.equal(a.sent.length, 0);
  clock.advance(1); // ack timeout for b
  assert.deepEqual(b.json().at(-1), { type: "stop", sessionId: "t1" });
  assert.equal(a.json()[0].type, "speak");
  assert.equal(a.frames(), 2);
  assert.deepEqual(a.json().at(-1), { type: "end", entryId: 7 });
  clock.advance(3_000); // ack timeout for a
  await tick();
  assert.deepEqual(statuses.at(-1), [7, "error", { error: "no client" }]);
});

test("slow synthesis of the first frame does not count against the ack window", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { hub, connect, clock, status, statuses } = setup({ gate, gateAt: 0 });
  const a = connect("a", 10);
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  clock.advance(5_000); // first sentence group still synthesizing
  assert.equal(b.frames(), 0);
  assert.equal(a.sent.length, 0, "no failover before any audio was sent");
  assert.equal(statuses.length, 0);
  release();
  await tick();
  assert.equal(b.frames(), 2);
  clock.advance(2_000); // within the ack window counted from the first frame
  status(b, 7, "playing");
  status(b, 7, "done");
  clock.advance(60_000); // no stale timer (ack or synthesis) may fire after the ack
  await tick();
  assert.deepEqual(statuses.map(([id, s]) => [id, s]), [[7, "playing"], [7, "done"]]);
  assert.ok(!b.json().some((m) => m.type === "stop"));
  assert.equal(a.sent.length, 0);
  assert.equal(clock.pending(), 0);
});

test("no audio within the synthesis deadline -> error synthesis timeout", async () => {
  const gate = new Promise<void>(() => {}); // synthesis never produces a frame
  const { hub, connect, clock, statuses } = setup({ gate, gateAt: 0 });
  const a = connect("a", 10);
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  clock.advance(29_999);
  assert.equal(statuses.length, 0);
  clock.advance(1);
  await tick();
  assert.deepEqual(statuses, [[7, "error", { error: "synthesis timeout" }]]);
  assert.deepEqual(b.json().at(-1), { type: "stop", sessionId: "t1" });
  assert.equal(a.sent.length, 0);
});

test("a target reporting done without ever playing -> error no audio", async () => {
  const { hub, connect, status, statuses } = setup();
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  status(b, 7, "done");
  await tick();
  assert.deepEqual(statuses, [[7, "error", { error: "no audio" }]]);
});

test("a client pruned by the TTL re-registers on its next message", async () => {
  let t = 1_000_000;
  const registry = new ClientRegistry(() => t, 45_000);
  const { hub, connect } = setup({ registry });
  const s = connect("a", 10);
  assert.equal(hub.hasReadyClient(), true);
  t += 60_000; // a throttled background tab went quiet past the TTL
  assert.equal(hub.hasReadyClient(), false); // live() pruned it
  assert.equal(registry.has("a"), false);
  hub.onMessage(s, JSON.stringify({ type: "ping" }));
  assert.equal(hub.hasReadyClient(), true);
  assert.deepEqual(hub.clients(), [{ clientId: "a", deviceName: "a", focusedAt: 10, audioUnlocked: true }]);
});

test("re-registration keeps focus and unlock state learned after hello", () => {
  let t = 1_000_000;
  const registry = new ClientRegistry(() => t, 45_000);
  const { hub, connect } = setup({ registry });
  const s = connect("a", 10, false);
  hub.onMessage(s, JSON.stringify({ type: "unlocked" }));
  hub.onMessage(s, JSON.stringify({ type: "focus", focusedAt: 50 }));
  t += 60_000;
  hub.clients(); // prune
  hub.onMessage(s, JSON.stringify({ type: "ping" }));
  assert.deepEqual(hub.clients(), [{ clientId: "a", deviceName: "a", focusedAt: 50, audioUnlocked: true }]);
});

test("onReadyChange fires when a window becomes ready and when it goes away", () => {
  const { hub, connect } = setup();
  const seen: boolean[] = [];
  hub.onReadyChange((r) => seen.push(r));
  const s = connect("a", 10, false);
  hub.onMessage(s, JSON.stringify({ type: "unlocked" }));
  hub.onMessage(s, JSON.stringify({ type: "ping" }));
  hub.onClose(s);
  assert.deepEqual(seen, [true, false]);
});

test("stop aborts synthesis and sends no further frames", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { hub, connect, status, statuses, aborted } = setup({ frames: 3, gate });
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  status(b, 7, "playing");
  hub.stop("t1");
  release();
  await tick();
  assert.equal(b.frames(), 1);
  assert.deepEqual(b.json().at(-1), { type: "stop", sessionId: "t1" });
  assert.deepEqual(aborted, [true]);
  assert.deepEqual(statuses.map(([, s]) => s), ["playing", "interrupted"]);
});

test("closing the only target after ack reports interrupted", async () => {
  const { hub, connect, status, statuses } = setup();
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  status(b, 7, "playing");
  hub.onClose(b);
  await tick();
  assert.deepEqual(statuses.at(-1)?.slice(0, 2), [7, "interrupted"]);
});

test("closing the target before ack fails over", async () => {
  const { hub, connect } = setup();
  const a = connect("a", 10);
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  hub.onClose(b);
  assert.equal(a.json()[0].type, "speak");
});

test("a new speak on the same session interrupts the previous one", async () => {
  const { hub, connect, status, statuses } = setup();
  const b = connect("b", 20);
  hub.speak(7, "One.", "t1", 1);
  await tick();
  status(b, 7, "playing");
  hub.speak(8, "Two.", "t1", 1);
  await tick();
  assert.ok(statuses.some(([id, s]) => id === 7 && s === "interrupted"));
  assert.ok(b.json().some((m) => m.type === "speak" && m.entryId === 8));
});

test("statuses from non-target windows are ignored", async () => {
  const { hub, connect, status, statuses } = setup();
  const a = connect("a", 10);
  connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  status(a, 7, "done");
  await tick();
  assert.deepEqual(statuses, []);
});

test("sound goes to the selected windows; all rule fans out", () => {
  const { hub, connect } = setup({ playOn: "all" });
  const a = connect("a", 10);
  const b = connect("b", 20);
  hub.sound("attention", 0.5, "t1");
  assert.deepEqual(a.json(), [{ type: "sound", sound: "attention", volume: 0.5, sessionId: "t1" }]);
  assert.deepEqual(b.json(), [{ type: "sound", sound: "attention", volume: 0.5, sessionId: "t1" }]);
});

test("hasReadyClient needs a live, unlocked window", () => {
  const { hub, connect } = setup();
  assert.equal(hub.hasReadyClient(), false);
  const s = connect("a", 10, false);
  assert.equal(hub.hasReadyClient(), false);
  hub.onMessage(s, JSON.stringify({ type: "unlocked" }));
  assert.equal(hub.hasReadyClient(), true);
});

test("messages before hello are ignored; clients() lists live windows", () => {
  const { hub, connect } = setup();
  const stray = new FakeSocket();
  hub.onMessage(stray, JSON.stringify({ type: "unlocked" }));
  connect("a", 10, false);
  assert.deepEqual(hub.clients(), [{ clientId: "a", deviceName: "a", focusedAt: 10, audioUnlocked: false }]);
});

test("reconnecting with the same clientId after ack reports interrupted", async () => {
  const { hub, connect, status, statuses } = setup();
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  status(b, 7, "playing");
  connect("b", 25); // a new socket sends hello for "b" before the old socket's close arrives
  await tick();
  assert.deepEqual(statuses.at(-1)?.slice(0, 2), [7, "interrupted"]);
});

test("a takeover hello closes the previous socket with 4001 superseded", () => {
  const { hub, connect } = setup();
  const b1 = connect("b", 20);
  connect("b", 25); // same clientId, new socket (e.g. a duplicated tab)
  assert.deepEqual(b1.closed, [4001, "superseded"]);
});

test("reconnecting with the same clientId before ack fails over", async () => {
  const { hub, connect } = setup();
  const a = connect("a", 10);
  connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  connect("b", 25); // reconnect before "b" ever acked entry 7
  assert.equal(a.json()[0].type, "speak");
});

test("closing one window under the all rule before ack keeps the other target alive", async () => {
  const { hub, connect } = setup({ playOn: "all" });
  const a = connect("a", 10);
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  hub.onClose(a);
  assert.equal(b.frames(), 2);
  assert.ok(!b.json().some((m) => m.type === "stop"));
});

test("a pre-ack error status retargets to the next window", async () => {
  const { hub, connect, statuses } = setup();
  const a = connect("a", 10);
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  hub.onMessage(b, JSON.stringify({ type: "status", entryId: 7, status: "error", error: "boom" }));
  assert.equal(a.json()[0].type, "speak");
  assert.equal(statuses.length, 0);
});

test("a synthesis failure mid-stream sends stop to the target before reporting error", async () => {
  const { hub, connect, statuses } = setup({ throwAfter: 1 });
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  assert.equal(b.frames(), 1);
  assert.deepEqual(b.json().at(-1), { type: "stop", sessionId: "t1" });
  assert.equal(statuses.at(-1)?.[1], "error");
});

test("stop aborts synthesis and sends no further frames even when the generator ignores the abort signal", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const registry = new ClientRegistry();
  const statuses: [number, EntryStatus, unknown][] = [];
  const hub = new PlayerHub({
    registry,
    routing: () => ({ playOn: "follow", pinnedDevice: null }),
    async *synthesize() {
      yield new Uint8Array(new Float32Array([0]).buffer);
      await gate; // the generator itself never checks the abort signal
      yield new Uint8Array(new Float32Array([1]).buffer);
      yield new Uint8Array(new Float32Array([2]).buffer);
    },
    reportStatus: async (id, s, extra) => { statuses.push([id, s, extra]); },
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  const b = new FakeSocket();
  hub.onMessage(b, JSON.stringify({ type: "hello", clientId: "b", deviceName: "b", focusedAt: 20, audioUnlocked: true }));
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  hub.onMessage(b, JSON.stringify({ type: "status", entryId: 7, status: "playing", firstAudioMs: 300 }));
  hub.stop("t1");
  release();
  await tick();
  assert.equal(b.frames(), 1);
  assert.deepEqual(b.json().at(-1), { type: "stop", sessionId: "t1" });
  assert.deepEqual(statuses.map(([, s]) => s), ["playing", "interrupted"]);
});

test("reportStatus calls are sequenced per entry even when the first resolves slowly", async () => {
  const registry = new ClientRegistry();
  const order: string[] = [];
  let releasePlaying!: () => void;
  const playingGate = new Promise<void>((r) => { releasePlaying = r; });
  const hub = new PlayerHub({
    registry,
    routing: () => ({ playOn: "follow", pinnedDevice: null }),
    async *synthesize() { yield new Uint8Array(new Float32Array([0]).buffer); },
    reportStatus: async (_id, status) => {
      order.push(`start:${status}`);
      if (status === "playing") await playingGate;
      order.push(`end:${status}`);
    },
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  const b = new FakeSocket();
  hub.onMessage(b, JSON.stringify({ type: "hello", clientId: "b", deviceName: "b", focusedAt: 20, audioUnlocked: true }));
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  hub.onMessage(b, JSON.stringify({ type: "status", entryId: 7, status: "playing", firstAudioMs: 300 }));
  hub.onMessage(b, JSON.stringify({ type: "status", entryId: 7, status: "done" }));
  await tick();
  assert.deepEqual(order, ["start:playing"]);
  releasePlaying();
  await tick();
  assert.deepEqual(order, ["start:playing", "end:playing", "start:done", "end:done"]);
});
