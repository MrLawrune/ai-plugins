import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientRegistry } from "./clients.ts";
import { BACKSTOP_MS, MAX_FRAME_BYTES, MAX_REPLY_BYTES, PlayerHub, type EntryStatus, type HubDeps, type SocketLike } from "./hub.ts";
import type { PlayOn } from "./schemas.ts";

class FakeSocket implements SocketLike {
  sent: (string | Uint8Array)[] = [];
  closed: [number | undefined, string | undefined] | null = null;
  /** Set by connect(): lets holding() ask the hub. */
  holderOf?: () => string[];
  id = "";
  send(d: string | Uint8Array) { this.sent.push(d); }
  holding() { return this.holderOf?.().includes(this.id) ?? false; }
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
  clock?: ReturnType<typeof fakeClock>; routing?: () => { playOn: PlayOn; pinnedDevice: string | null };
  synthesize?: HubDeps["synthesize"]; maxQueued?: number; maxReplyBytes?: number;
} = {}) {
  const clock = opts.clock ?? fakeClock();
  const registry = opts.registry ?? new ClientRegistry();
  const statuses: [number, EntryStatus, unknown][] = [];
  const speaking: { key: string; on: boolean; title?: string }[] = [];
  const aborted: boolean[] = [];
  /** Entry ids passed to synthesize, in call order. */
  const synthCalls: number[] = [];
  const synthStarts: number[] = [];
  const sessions: [number, string][] = [];
  async function* fakeSynth(_text: string, signal: AbortSignal) {
    for (let i = 0; i < (opts.frames ?? 2); i++) {
      if (i === (opts.gateAt ?? 1) && opts.gate) await opts.gate;
      if (signal.aborted) { aborted.push(true); return; }
      if (opts.throwAfter !== undefined && i === opts.throwAfter) throw new Error("synth failed");
      yield new Uint8Array(new Float32Array([i]).buffer);
    }
  }
  const hub = new PlayerHub({
    registry,
    routing: opts.routing ?? (() => ({ playOn: opts.playOn ?? "follow", pinnedDevice: null })),
    synthesize(text, signal, synthOpts, entryId) {
      synthCalls.push(entryId);
      return (opts.synthesize ?? fakeSynth)(text, signal, synthOpts, entryId);
    },
    reportStatus: async (id, s, extra, sessionId) => { statuses.push([id, s, extra]); sessions.push([id, sessionId]); },
    maxQueued: opts.maxQueued,
    maxReplyBytes: opts.maxReplyBytes,
    onSynthStart: (id) => { synthStarts.push(id); },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    speaking: (e) => { speaking.push(e); },
  });
  const connect = (id: string, focusedAt: number, unlocked = true, deviceName = id) => {
    const s = new FakeSocket();
    s.id = id;
    s.holderOf = () => hub.holderIds();
    hub.onMessage(s, JSON.stringify({ type: "hello", clientId: id, deviceName, focusedAt, audioUnlocked: unlocked }));
    return s;
  };
  const status = (s: FakeSocket, entryId: number, st: string) =>
    hub.onMessage(s, JSON.stringify({ type: "status", entryId, status: st, firstAudioMs: 300 }));
  return { hub, registry, statuses, clock, aborted, connect, status, speaking, synthCalls, synthStarts, sessions };
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
  clock.advance(74_999);
  await tick();
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
  assert.deepEqual(hub.clients(), [{ clientId: "a", deviceName: "a", focusedAt: 10, audioUnlocked: true, local: false }]);
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
  assert.deepEqual(hub.clients(), [{ clientId: "a", deviceName: "a", focusedAt: 50, audioUnlocked: true, local: false }]);
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

test("closing the only target after ack reports interrupted (nothing to hold for under the all rule)", async () => {
  const { hub, connect, status, statuses } = setup({ playOn: "all" });
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  status(b, 7, "playing");
  hub.onClose(b);
  await tick();
  assert.deepEqual(statuses.at(-1)?.slice(0, 2), [7, "interrupted"]);
});

test("closing a non-holder target before ack fails over", async () => {
  const { hub, connect } = setup({ playOn: "all" });
  const a = connect("a", 10);
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  hub.onClose(a);
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
  assert.deepEqual(hub.clients(), [{ clientId: "a", deviceName: "a", focusedAt: 10, audioUnlocked: false, local: false }]);
});

test("reconnecting with the same clientId after ack reports interrupted (all rule)", async () => {
  const { hub, connect, status, statuses } = setup({ playOn: "all" });
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

test("the holder reconnecting on a new socket gets its reply again there, not elsewhere", async () => {
  const { hub, connect, status } = setup();
  const a = connect("a", 10);
  connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  const b2 = connect("b", 20); // signal blip: new socket before the old one's close arrives
  assert.equal(a.sent.length, 0);
  assert.deepEqual(b2.json().map((m) => m.type), ["speak", "end"]);
  assert.equal(b2.frames(), 2);
  status(b2, 7, "playing");
  // ...and after it started playing, too
  const b3 = connect("b", 20);
  assert.deepEqual(b3.json().map((m) => m.type), ["speak", "end"]);
});

test("a pinned holder pruned while silent is held for even when another window connects", async () => {
  const clock = fakeClock();
  const registry = new ClientRegistry(clock.now, 150_000);
  const { hub, connect } = setup({ clock, registry, routing: () => ({ playOn: "pinned", pinnedDevice: "phone" }) });
  const phone = connect("phone", 5);
  clock.advance(160_000); // phone frozen past the TTL
  const desk = connect("desk", 10); // a sync runs here
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  assert.equal(desk.sent.length, 0);
  hub.onMessage(phone, JSON.stringify({ type: "ping" }));
  assert.equal(phone.json()[0].type, "speak");
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
  assert.deepEqual(statuses.at(-1), [7, "error", { error: "synth failed" }]);
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

test("the output holder follows focus", () => {
  const { hub, connect } = setup();
  const desk = connect("desk", 10);
  const tab = connect("tab", 5);
  assert.equal(desk.holding(), true);
  assert.equal(tab.holding(), false);
  hub.onMessage(tab, JSON.stringify({ type: "focus", focusedAt: 20 }));
  assert.equal(desk.holding(), false);
  assert.equal(tab.holding(), true);
});

test("a locked window does not hold the output until it unlocks", () => {
  const { hub, connect } = setup();
  const tab = connect("tab", 10, false);
  assert.equal(tab.holding(), false);
  hub.onMessage(tab, JSON.stringify({ type: "unlocked" }));
  assert.equal(tab.holding(), true);
});

test("pinning moves the holder", () => {
  let pinnedDevice: string | null = null;
  const { hub, connect } = setup({ routing: () => ({ playOn: pinnedDevice ? "pinned" : "follow", pinnedDevice }) });
  const desk = connect("desk", 20);
  const phone = connect("phone", 10);
  pinnedDevice = "phone";
  hub.routingChanged();
  assert.equal(phone.holding(), true);
  assert.equal(desk.holding(), false);
});

test("the holder drops off: replies wait for it, then play when it reconnects", async () => {
  const { hub, connect, status, statuses } = setup();
  const desk = connect("desk", 10);
  const tab = connect("tab", 20);
  hub.onClose(tab); // signal lost in the car
  hub.speak(7, "Hello.", "t1", 1);
  hub.sound("done", 1, "t1");
  await tick();
  assert.equal(desk.sent.length, 0, "nothing plays at home");
  assert.equal(desk.holding(), false);
  assert.equal(statuses.length, 0);
  const back = connect("tab", 0); // same tab reconnects; screen still off so no focus
  assert.equal(back.holding(), true);
  await tick();
  assert.deepEqual(back.json().map((m) => m.type), ["speak", "end"]);
  assert.equal(back.frames(), 2, "the reply was synthesized once dispatched");
  status(back, 7, "playing");
  status(back, 7, "done");
  await tick();
  assert.deepEqual(statuses.map(([, st]) => st), ["playing", "done"]);
  assert.equal(desk.sent.length, 0);
});

test("a reloaded tab on the away device must unlock before held replies play", async () => {
  const { hub, connect } = setup();
  connect("desk", 10);
  hub.onClose(connect("tab-old", 20, true, "Tablet"));
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  const fresh = connect("tab-new", 0, false, "Tablet");
  assert.equal(fresh.sent.length, 0);
  hub.onMessage(fresh, JSON.stringify({ type: "unlocked" }));
  assert.equal(fresh.json()[0].type, "speak");
  assert.equal(fresh.holding(), true, "it keeps the away window's place as last used");
});

test("held replies play one at a time, oldest first", async () => {
  const { hub, connect, status } = setup();
  connect("desk", 10);
  hub.onClose(connect("tab", 20));
  hub.speak(7, "One.", "t1", 1);
  hub.speak(8, "Two.", "t2", 1);
  await tick();
  const tab = connect("tab", 0);
  assert.deepEqual(tab.json().filter((m) => m.type === "speak").map((m) => m.entryId), [7]);
  status(tab, 7, "playing");
  status(tab, 7, "done");
  assert.deepEqual(tab.json().filter((m) => m.type === "speak").map((m) => m.entryId), [7, 8]);
});

test("using another device takes the output, held replies included", async () => {
  const { hub, connect } = setup();
  const desk = connect("desk", 10);
  hub.onClose(connect("tab", 20));
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  hub.onMessage(desk, JSON.stringify({ type: "focus", focusedAt: 30 }));
  assert.equal(desk.json()[0].type, "speak");
  assert.equal(desk.holding(), true);
});

test("after the hold window, replies go back to normal routing", async () => {
  const { hub, connect, clock } = setup();
  const desk = connect("desk", 10);
  hub.onClose(connect("tab", 20));
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  clock.advance(15 * 60_000);
  assert.equal(desk.json()[0].type, "speak");
  assert.equal(desk.holding(), true);
});

test("a pinned device that drops off holds even when another device is used", async () => {
  const { hub, connect } = setup({ routing: () => ({ playOn: "pinned", pinnedDevice: "phone" }) });
  const desk = connect("desk", 10);
  hub.onClose(connect("phone", 5));
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  hub.onMessage(desk, JSON.stringify({ type: "focus", focusedAt: 30 }));
  assert.equal(desk.sent.length, 0);
});

test("the holder dropping mid-reply replays it from the start when back", async () => {
  const { hub, connect, status } = setup();
  const desk = connect("desk", 10);
  const tab = connect("tab", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  status(tab, 7, "playing");
  hub.onClose(tab);
  assert.equal(desk.sent.length, 0);
  const back = connect("tab", 0);
  assert.deepEqual(back.json().map((m) => m.type), ["speak", "end"]);
  assert.equal(back.frames(), 2);
});

test("a holder pruned while its frozen socket stays open is treated as away", async () => {
  const clock = fakeClock();
  const registry = new ClientRegistry(clock.now, 150_000);
  const { hub, connect } = setup({ clock, registry });
  const tab = connect("tab", 20);
  clock.advance(100_000);
  const desk = connect("desk", 10);
  clock.advance(60_000); // tab silent past the TTL, desk still fresh
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  assert.equal(desk.sent.length, 0);
  hub.onMessage(tab, JSON.stringify({ type: "ping" })); // it thaws
  assert.equal(tab.json()[0].type, "speak");
});

test("all rule never holds", async () => {
  const { hub, connect } = setup({ playOn: "all" });
  const desk = connect("desk", 10);
  hub.onClose(connect("tab", 20));
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  assert.equal(desk.json()[0].type, "speak");
});

test("pingAll sends a keepalive to every window", () => {
  const { hub, connect } = setup();
  const a = connect("a", 10);
  const b = connect("b", 20, false);
  hub.pingAll();
  assert.deepEqual(a.json(), [{ type: "ping" }]);
  assert.deepEqual(b.json(), [{ type: "ping" }]);
});

test("speaking events bracket playback", async () => {
  const { hub, connect, speaking } = setup();
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  hub.onMessage(b, JSON.stringify({ type: "status", entryId: 7, status: "playing" }));
  hub.onMessage(b, JSON.stringify({ type: "status", entryId: 7, status: "playing" }));
  assert.deepEqual(speaking, [{ key: "7", on: true, local: false }]);
  hub.onMessage(b, JSON.stringify({ type: "status", entryId: 7, status: "done" }));
  assert.deepEqual(speaking.at(-1), { key: "7", on: false });
});

test("speaking ends when a playing reply is held for a dropped holder or stopped", async () => {
  const { hub, connect, status, speaking } = setup();
  connect("desk", 10);
  const tab = connect("tab", 20);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  status(tab, 7, "playing");
  hub.onClose(tab);
  assert.deepEqual(speaking.map((e) => e.on), [true, false]);
  hub.stop(null);
  assert.equal(speaking.length, 2);
});

test("replies from different threads play one after another, never over each other", async () => {
  const { hub, connect, status, statuses } = setup();
  const b = connect("b", 20);
  hub.speak(7, "One.", "t1", 1);
  hub.speak(8, "Two.", "t2", 1);
  await tick();
  const speaks = () => b.json().filter((m) => m.type === "speak").map((m) => m.entryId);
  assert.deepEqual(speaks(), [7]);
  status(b, 7, "playing");
  status(b, 7, "done");
  assert.deepEqual(speaks(), [7, 8]);
  await tick();
  assert.equal(b.frames(), 4, "the queued reply was synthesized once dispatched");
  status(b, 8, "playing");
  status(b, 8, "done");
  await tick();
  // Reports are chained per entry, so entries may interleave in the log; each is in order.
  for (const id of [7, 8]) assert.deepEqual(statuses.filter(([e]) => e === id).map(([, st]) => st), ["playing", "done"]);
});

test("a newer reply in the same thread replaces its queued one", async () => {
  const { hub, connect, statuses } = setup();
  const b = connect("b", 20);
  hub.speak(7, "One.", "t1", 1);
  hub.speak(8, "Two.", "t2", 1);
  hub.speak(9, "Two again.", "t2", 1);
  await tick();
  assert.ok(statuses.some(([id, st]) => id === 8 && st === "interrupted"));
  hub.stop("t1");
  assert.deepEqual(b.json().filter((m) => m.type === "speak").map((m) => m.entryId), [7, 9]);
});

test("a window that never says done can't stall the queue", async () => {
  const { hub, connect, status, clock, statuses } = setup();
  const b = connect("b", 20);
  hub.speak(7, "One.", "t1", 1);
  hub.speak(8, "Two.", "t2", 1);
  await tick();
  status(b, 7, "playing"); // then silence
  clock.advance(31_000); // two tiny frames of audio + 30 s slack
  await tick();
  assert.ok(statuses.some(([id, st, x]) => id === 7 && st === "error" && (x as { error: string }).error === "no end from window"));
  assert.deepEqual(b.json().filter((m) => m.type === "speak").map((m) => m.entryId), [7, 8]);
});

test("a window marked local is reported so, in clients() and speaking events", async () => {
  const { hub, speaking } = setup();
  const s = new FakeSocket();
  hub.markLocal(s, true);
  hub.onMessage(s, JSON.stringify({ type: "hello", clientId: "desk", deviceName: "desk", focusedAt: 10, audioUnlocked: true }));
  assert.equal(hub.clients()[0].local, true);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  hub.onMessage(s, JSON.stringify({ type: "status", entryId: 7, status: "playing" }));
  assert.deepEqual(speaking, [{ key: "7", on: true, local: true }]);
});

test("speak forwards synthesis options", async () => {
  const seen: unknown[] = [];
  const registry = new ClientRegistry();
  const clock = fakeClock();
  const hub = new PlayerHub({
    registry,
    routing: () => ({ playOn: "follow", pinnedDevice: null }),
    async *synthesize(_text, _signal, opts) { seen.push(opts); yield new Uint8Array(4); },
    reportStatus: async () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
  });
  const s = new FakeSocket();
  hub.onMessage(s, JSON.stringify({ type: "hello", clientId: "a", deviceName: "a", focusedAt: 1, audioUnlocked: true }));
  hub.speak(7, "Hi.", "preview", 1, { voice: "af_bella", speed: 1.3 });
  await tick();
  assert.deepEqual(seen, [{ voice: "af_bella", speed: 1.3 }]);
});

test("held jobs do not synthesize until dispatched", async () => {
  const { hub, connect, status, synthCalls, synthStarts, sessions } = setup();
  const b = connect("b", 20);
  hub.speak(7, "One.", "t1", 1);
  hub.speak(8, "Two.", "t2", 1);
  await tick();
  assert.deepEqual(synthCalls, [7]);
  status(b, 7, "playing");
  status(b, 7, "done");
  await tick();
  assert.deepEqual(synthCalls, [7, 8]);
  assert.deepEqual(synthStarts, [7, 8]);
  assert.deepEqual(sessions, [[7, "t1"], [7, "t1"]]);
});

test("queue cap drops the oldest held job as interrupted", async () => {
  const { hub, connect, status, statuses } = setup({ maxQueued: 2 });
  const b = connect("b", 20);
  hub.speak(1, "A.", "ta", 1);
  hub.speak(2, "B.", "tb", 1);
  hub.speak(3, "C.", "tc", 1);
  hub.speak(4, "D.", "td", 1);
  await tick();
  assert.deepEqual(statuses, [[2, "interrupted", undefined]]);
  const speaks = () => b.json().filter((m) => m.type === "speak").map((m) => m.entryId);
  status(b, 1, "playing");
  status(b, 1, "done");
  assert.deepEqual(speaks(), [1, 3]);
  await tick();
  status(b, 3, "playing");
  status(b, 3, "done");
  assert.deepEqual(speaks(), [1, 3, 4]);
});

test("stopAll interrupts every playing and held job and counts them", async () => {
  const { hub, connect, statuses } = setup();
  const b = connect("b", 20);
  hub.speak(1, "A.", "ta", 1);
  hub.speak(2, "B.", "tb", 1);
  hub.speak(3, "C.", "tc", 1);
  await tick();
  assert.equal(hub.stopAll(), 3);
  await tick();
  assert.deepEqual(statuses.map(([id, s]) => [id, s]).sort(), [[1, "interrupted"], [2, "interrupted"], [3, "interrupted"]]);
  assert.ok(b.json().some((m) => m.type === "stop" && m.sessionId === "ta"));
  assert.equal(hub.stopAll(), 0, "nothing left");
});

test("the queue holds 16 by default", async () => {
  const { hub, connect, statuses } = setup();
  connect("b", 20);
  for (let i = 0; i <= 17; i++) hub.speak(i, "Hi.", `t${i}`, 1);
  await tick();
  assert.deepEqual(statuses, [[1, "interrupted", undefined]]);
});

test("backstop is 75 s from dispatch", async () => {
  const never = new Promise<void>(() => {});
  const { hub, connect, status, clock, statuses } = setup({
    async *synthesize(text) {
      if (text === "B.") yield new Uint8Array(4); // B plays; its synthesis never completes
      await never;
    },
  });
  const b = connect("b", 20);
  hub.speak(1, "B.", "tb", 1);
  hub.speak(2, "A.", "ta", 1); // held behind B
  await tick();
  status(b, 1, "playing");
  clock.advance(50_000);
  status(b, 1, "done");
  await tick();
  clock.advance(25_000); // 75 s after speak(A)
  await tick();
  assert.deepEqual(statuses.filter(([id]) => id === 2), []);
  clock.advance(49_999);
  await tick();
  assert.deepEqual(statuses.filter(([id]) => id === 2), []);
  clock.advance(1); // 75 s after A started synthesizing
  await tick();
  assert.deepEqual(statuses.filter(([id]) => id === 2), [[2, "error", { error: "synthesis timeout" }]]);
  assert.deepEqual(b.json().at(-1), { type: "stop", sessionId: "ta" });
});

test("oversized frame ends the job", async () => {
  assert.equal(MAX_FRAME_BYTES, 1 << 20);
  const { hub, connect, statuses } = setup({
    async *synthesize() { yield new Uint8Array((1 << 20) + 4); },
  });
  const b = connect("b", 20);
  hub.speak(7, "Hi.", "t1", 1);
  await tick();
  assert.equal(b.frames(), 0);
  assert.deepEqual(b.json().at(-1), { type: "stop", sessionId: "t1" });
  assert.deepEqual(statuses, [[7, "error", { error: "frame too large" }]]);
});

test("a frame that is not whole float32 samples ends the job", async () => {
  const { hub, connect, statuses } = setup({
    async *synthesize() { yield new Uint8Array(4); yield new Uint8Array(6); },
  });
  const b = connect("b", 20);
  hub.speak(7, "Hi.", "t1", 1);
  await tick();
  assert.equal(b.frames(), 1);
  assert.deepEqual(b.json().at(-1), { type: "stop", sessionId: "t1" });
  assert.deepEqual(statuses, [[7, "error", { error: "bad frame length 6" }]]);
});

test("an error before any engine audio carries the reply's mode for the error cue", async () => {
  const { hub, connect, statuses } = setup({ async *synthesize() { throw new Error("unreachable: connect ECONNREFUSED"); } });
  connect("b", 20);
  hub.speak(7, "Hi.", "t1", 1, undefined, "conversational");
  await tick();
  assert.deepEqual(statuses, [[7, "error", { error: "unreachable: connect ECONNREFUSED", errorCue: "conversational" }]]);
});

test("any pre-audio error cues, not only unreachable: a backup that answered 4xx last", async () => {
  const { hub, connect, statuses } = setup({ async *synthesize() { throw new Error("this server forwards to another one"); } });
  connect("b", 20);
  hub.speak(7, "Hi.", "t1", 1, undefined, "brief");
  await tick();
  assert.deepEqual(statuses, [[7, "error", { error: "this server forwards to another one", errorCue: "brief" }]]);
});

test("the synthesis backstop with nothing heard cues too", async () => {
  const { hub, connect, clock, statuses } = setup({ gate: new Promise<void>(() => {}), gateAt: 0 });
  connect("b", 20);
  hub.speak(7, "Hi.", "t1", 1, undefined, "brief");
  await tick();
  clock.advance(BACKSTOP_MS);
  await tick();
  assert.deepEqual(statuses, [[7, "error", { error: "synthesis timeout", errorCue: "brief" }]]);
});

test("no error cue mid-reply, for no client, or without a mode (replay, preview)", async () => {
  const mid = setup({ throwAfter: 1 });
  mid.connect("b", 20);
  mid.hub.speak(7, "Hi.", "t1", 1, undefined, "brief");
  await tick();
  assert.deepEqual(mid.statuses, [[7, "error", { error: "synth failed" }]]);

  const nobody = setup({ async *synthesize() { throw new Error("unreachable: x"); } });
  nobody.hub.speak(8, "Hi.", "t1", 1, undefined, "brief");
  await tick();
  assert.deepEqual(nobody.statuses, [[8, "error", { error: "no client" }]]);

  const replay = setup({ async *synthesize() { throw new Error("unreachable: x"); } });
  replay.connect("b", 20);
  replay.hub.speak(9, "Hi.", "t1", 1);
  await tick();
  assert.deepEqual(replay.statuses, [[9, "error", { error: "unreachable: x" }]]);
});

test("a reply past its audio budget stops synthesis and its windows and ends as too long", async () => {
  assert.equal(MAX_REPLY_BYTES, 64 << 20);
  let pulled = 0;
  const { hub, connect, statuses, aborted } = setup({
    maxReplyBytes: 40,
    async *synthesize(_t, signal) {
      for (;;) {
        if (signal.aborted) { aborted.push(true); return; }
        pulled++;
        yield new Uint8Array(16);
      }
    },
  });
  const b = connect("b", 20);
  hub.speak(7, "Hello.", "t1", 1, undefined, "brief");
  await tick();
  assert.equal(b.frames(), 2, "two 16-byte pieces fit, the third would pass 40");
  assert.ok(pulled <= 4, "synthesis stopped");
  assert.deepEqual(b.json().at(-1), { type: "stop", sessionId: "t1" });
  // Audio was heard, so no error cue.
  assert.deepEqual(statuses, [[7, "error", { error: "reply too long" }]]);
  // The next reply is not held behind it.
  hub.speak(8, "Next.", "t2", 1);
  await tick();
  assert.ok(b.json().some((m) => m.type === "speak" && m.entryId === 8));
});


/** Connects a window and marks it local (on this computer) or not. */
function connectAs(hub: PlayerHub, id: string, focusedAt: number, local: boolean) {
  const s = new FakeSocket();
  s.id = id;
  hub.markLocal(s, local);
  hub.onMessage(s, JSON.stringify({ type: "hello", clientId: id, deviceName: id, focusedAt, audioUnlocked: true }));
  return s;
}
const playing = (hub: PlayerHub, s: FakeSocket, entryId: number, st = "playing") =>
  hub.onMessage(s, JSON.stringify({ type: "status", entryId, status: st }));

test("play on all: a local window acking after a remote one still pauses local media", async () => {
  const { hub, speaking } = setup({ playOn: "all" });
  const phone = connectAs(hub, "phone", 10, false);
  const desk = connectAs(hub, "desk", 20, true);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  playing(hub, phone, 7);
  playing(hub, desk, 7);
  assert.deepEqual(speaking, [{ key: "7", on: true, local: false }, { key: "7", on: true, local: true }]);
  playing(hub, phone, 7, "done");
  playing(hub, desk, 7, "done");
  assert.deepEqual(speaking.at(-1), { key: "7", on: false });
});

test("play on all: local acking first pauses once; a remote ack adds nothing", async () => {
  const { hub, speaking } = setup({ playOn: "all" });
  const phone = connectAs(hub, "phone", 10, false);
  const desk = connectAs(hub, "desk", 20, true);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  playing(hub, desk, 7);
  playing(hub, phone, 7);
  assert.deepEqual(speaking, [{ key: "7", on: true, local: true }]);
});

test("play on all: the last local window leaving ends the pause while a remote one plays on", async () => {
  const { hub, speaking, statuses } = setup({ playOn: "all" });
  const phone = connectAs(hub, "phone", 10, false);
  const desk = connectAs(hub, "desk", 20, true);
  const laptop = connectAs(hub, "laptop", 30, true);
  hub.speak(7, "Hello.", "t1", 1);
  await tick();
  playing(hub, phone, 7);
  playing(hub, desk, 7);
  playing(hub, laptop, 7);
  assert.deepEqual(speaking, [{ key: "7", on: true, local: false }, { key: "7", on: true, local: true }]);
  playing(hub, desk, 7, "done"); // one local window finished; another still plays
  assert.equal(speaking.length, 2);
  hub.onClose(laptop); // the last local one disconnects
  assert.deepEqual(speaking.at(-1), { key: "7", on: false, local: true });
  assert.ok(!statuses.some(([, st]) => st === "done" || st === "interrupted"), "the phone still plays");
  playing(hub, phone, 7, "done");
  await tick();
  assert.deepEqual(speaking.at(-1), { key: "7", on: false });
  assert.deepEqual(statuses.at(-1), [7, "done", undefined]);
});

test("liveEntryIds lists the replies playing or waiting, not finished ones", async () => {
  const { hub, connect, status } = setup();
  const b = connect("b", 20);
  hub.speak(7, "One.", "t1", 1);
  hub.speak(8, "Two.", "t2", 1);
  await tick();
  assert.deepEqual(hub.liveEntryIds().sort(), [7, 8]);
  status(b, 7, "playing");
  status(b, 7, "done");
  assert.deepEqual(hub.liveEntryIds(), [8]);
});
