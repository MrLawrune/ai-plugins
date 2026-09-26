import { test } from "node:test";
import assert from "node:assert/strict";
import { createPatchQueue, type SaveState } from "./patch-queue.ts";

type P = { speed: number; speech_gain: number; mode: string };

function fakeTimers() {
  let seq = 0;
  const due = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void) => { due.set(++seq, fn); return seq; },
    clearTimer: (h: unknown) => { due.delete(h as number); },
    fireAll: () => { const fns = [...due.values()]; due.clear(); fns.forEach((f) => f()); },
    count: () => due.size,
  };
}

function harness(send: (p: Partial<P>) => Promise<Partial<P>>) {
  const timers = fakeTimers();
  const committed: [Partial<P>, (keyof P)[]][] = [];
  const failed: [(keyof P)[], string][] = [];
  const states: SaveState["kind"][] = [];
  let last: SaveState = { kind: "idle" };
  const q = createPatchQueue<P, Partial<P>>({
    send,
    onCommitted: (r, keys) => committed.push([r, keys]),
    onFailed: (keys, m) => failed.push([keys, m]),
    onState: (s) => { states.push(s.kind); last = s; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { q, timers, committed, failed, states, last: () => last };
}

test("debounced edits to two fields go out together", async () => {
  const sent: Partial<P>[] = [];
  const h = harness(async (p) => { sent.push(p); return p; });
  h.q.set({ speed: 1.2 }, 350);
  h.q.set({ speech_gain: 0.8 }, 350);
  assert.equal(h.timers.count(), 1);
  h.timers.fireAll();
  await h.q.flush();
  assert.deepEqual(sent, [{ speed: 1.2, speech_gain: 0.8 }]);
  assert.deepEqual(h.states, ["saving", "saved"]);
});

test("an edit made during a save goes out after it, and is not reported as committed early", async () => {
  const sent: Partial<P>[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = harness(async (p) => { sent.push(p); if (sent.length === 1) await gate; return p; });
  h.q.set({ speed: 1.1 });
  h.q.set({ speed: 1.3, mode: "full" });
  release();
  await h.q.flush();
  assert.deepEqual(sent, [{ speed: 1.1 }, { speed: 1.3, mode: "full" }]);
  assert.deepEqual(h.committed.map(([, keys]) => keys), [[], ["speed", "mode"]]);
});

test("a failure reverts only that batch's keys and offers a retry", async () => {
  let fail = true;
  const sent: Partial<P>[] = [];
  const h = harness(async (p) => {
    sent.push(p);
    if (fail) { fail = false; throw new Error("server busy"); }
    return p;
  });
  h.q.set({ speed: 1.4 });
  await h.q.flush();
  assert.deepEqual(h.failed, [[["speed"], "server busy"]]);
  const s = h.last();
  assert.equal(s.kind, "error");
  if (s.kind === "error") s.retry();
  await h.q.flush();
  assert.deepEqual(sent, [{ speed: 1.4 }, { speed: 1.4 }]);
  assert.equal(h.last().kind, "saved");
});

test("flush sends a pending debounced edit immediately", async () => {
  const sent: Partial<P>[] = [];
  const h = harness(async (p) => { sent.push(p); return p; });
  h.q.set({ speed: 0.9 }, 350);
  await h.q.flush();
  assert.deepEqual(sent, [{ speed: 0.9 }]);
  assert.equal(h.timers.count(), 0);
});

test("a failed batch followed by a successful one in the same drain still ends in error", async () => {
  const sent: Partial<P>[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const h = harness(async (p) => {
    sent.push(p);
    if (sent.length === 1) { await gate; throw new Error("server busy"); }
    return p;
  });
  h.q.set({ speed: 1.4 });
  h.q.set({ mode: "full" });
  release();
  await h.q.flush();
  const s = h.last();
  assert.equal(s.kind, "error");
  assert.ok(!h.states.includes("saved"));
  if (s.kind === "error") s.retry();
  await h.q.flush();
  assert.deepEqual(sent, [{ speed: 1.4 }, { mode: "full" }, { speed: 1.4 }]);
  assert.equal(h.last().kind, "saved");
});
