import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationController, type DictationDeps } from "./dictation.ts";
import { target, harness, streamHarness } from "./test-dictation.ts";

/** The controller re-checks a closed composer after a microtask and a frame (no rAF under node:test). */
const frame = () => new Promise((r) => setTimeout(r, 20));

test("two surfaces for one composer: unmounting one keeps the other usable", async () => {
  const log: string[] = [];
  const c = new DictationController({
    async startRecording() { return { async stop() { return new Blob(["x"]); }, cancel() {} }; },
    async transcribe() { return "hi"; },
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: false, mode: "oneshot" as const, livePreview: true }),
    playSound: () => {},
    notify: (k, m) => log.push(`${k}:${m}`),
    now: () => 0,
  });
  c.register(target({ appendText: (t) => log.push(`action:${t}`) }));
  const unregisterBanner = c.register(target({ appendText: (t) => log.push(`banner:${t}`) }));
  unregisterBanner();
  await c.toggle("t1");
  assert.equal(c.snapshot().phase, "recording");
  await c.toggle("t1");
  assert.deepEqual(log, ["action:hi"]);
});

test("targetCount tracks registrations and notifies subscribers", () => {
  const c = new DictationController(null);
  let notified = 0;
  c.subscribe(() => notified++);
  assert.equal(c.targetCount(), 0);
  const off = c.register(target({ id: "a" }));
  assert.equal(c.targetCount(), 1);
  off();
  assert.equal(c.targetCount(), 0);
  assert.equal(notified, 2);
});

test("end() runs exactly once on every way a session finishes", async () => {
  const ends = async (run: (s: ReturnType<typeof streamHarness>) => Promise<void> | void, over: Partial<DictationDeps> = {}) => {
    const s = streamHarness(over);
    await run(s);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(s.c.snapshot().phase, "idle");
    return s.log.filter((l) => l === "end").length;
  };
  assert.equal(await ends(async (s) => { await s.c.start(); await s.c.stop(); }), 1, "stop");
  assert.equal(await ends(async (s) => { await s.c.start(); s.c.cancel(); }), 1, "cancel");
  assert.equal(await ends(async (s) => { await s.c.start(); s.h().onError("boom"); s.h().onEnded("error"); }), 1, "stream error");
  assert.equal(await ends(async (s) => { await s.c.start(); s.h().onEnded("silence"); }), 1, "stream ended");
  assert.equal(await ends(async (s) => { await s.c.start("t1", "oneshot"); await s.c.stop(); }), 1, "one-shot done");
  assert.equal(await ends(async (s) => { await s.c.start("t1", "oneshot"); s.c.cancel(); }), 1, "one-shot cancel");
  assert.equal(await ends(async (s) => { await s.c.start("t1", "oneshot"); await s.c.stop(); }, { async transcribe() { throw new Error("down"); } }), 1, "one-shot failure");
  assert.equal(await ends((s) => s.c.start("t1", "oneshot"), { async startRecording() { throw new Error("no mic"); } }), 1, "mic refused");
});

test("targetCount counts distinct ids; has() reports a mounted id", () => {
  const c = new DictationController(null);
  const a1 = c.register(target({ id: "a" }));
  const a2 = c.register(target({ id: "a" }));
  assert.equal(c.targetCount(), 1);
  assert.equal(c.has("a"), true);
  assert.equal(c.has("b"), false);
  a1();
  assert.equal(c.targetCount(), 1);
  a2();
  assert.equal(c.targetCount(), 0);
  assert.equal(c.has("a"), false);
});

test("the last target of the active session unregistering ends the session at once", async () => {
  const h = harness();
  const ends: string[] = [];
  const off = h.c.register(target({ id: "t2", end: () => ends.push("end") }));
  await h.c.start("t2");
  assert.equal(h.c.snapshot().phase, "recording");
  off(); // the composer closed
  await frame();
  assert.equal(h.c.snapshot().phase, "idle");
  assert.ok(h.log.includes("rec:cancel"), "mic released");
  assert.deepEqual(ends, ["end"]);
  assert.equal(h.log.filter((l) => l === "info:The composer closed; dictation stopped.").length, 1);
});

test("another registration with the same id keeps the session alive", async () => {
  const h = harness();
  const ends: string[] = [];
  const off1 = h.c.register(target({ id: "t2", end: () => ends.push("end") }));
  const off2 = h.c.register(target({ id: "t2", end: () => ends.push("end") }));
  await h.c.start("t2");
  off1();
  assert.equal(h.c.snapshot().phase, "recording");
  assert.deepEqual(ends, []);
  assert.ok(!h.log.some((l) => l.includes("composer closed")));
  off2();
  await frame();
  assert.equal(h.c.snapshot().phase, "idle");
  assert.equal(ends.length, 1);
});

test("an unrelated target unregistering leaves the session alone", async () => {
  const h = harness();
  const off = h.c.register(target({ id: "other" }));
  await h.c.start("t1");
  off();
  assert.equal(h.c.snapshot().phase, "recording");
});

test("a remount of the same composer in the same tick keeps the session", async () => {
  const h = harness();
  const ends: string[] = [];
  const off = h.c.register(target({ id: "t2", end: () => ends.push("end") }));
  await h.c.start("t2");
  off(); // the surface unmounts ...
  h.c.register(target({ id: "t2", end: () => ends.push("end") })); // ... and a new one mounts in the same commit
  await frame();
  assert.equal(h.c.snapshot().phase, "recording");
  assert.deepEqual(ends, []);
  assert.ok(!h.log.some((l) => l.includes("composer closed")), h.log.join(" | "));
});

test("a session that finished before the deferred check is not cancelled again", async () => {
  const h = harness();
  const off = h.c.register(target({ id: "t2" }));
  await h.c.start("t2");
  off();
  h.c.cancel();
  await frame();
  assert.equal(h.log.filter((l) => l === "sound:cancel").length, 1);
});

test("the closed-composer check also runs when the page is hidden and no animation frame fires", async () => {
  const g = globalThis as { requestAnimationFrame?: unknown };
  const saved = g.requestAnimationFrame;
  g.requestAnimationFrame = () => 0; // a hidden document never calls its frame callbacks
  try {
    const h = harness();
    const ends: string[] = [];
    const off = h.c.register(target({ id: "t2", end: () => ends.push("end") }));
    await h.c.start("t2");
    off();
    await frame();
    assert.equal(h.c.snapshot().phase, "idle");
    assert.ok(h.log.includes("rec:cancel"), "mic released");
    assert.deepEqual(ends, ["end"]);
  } finally {
    if (saved === undefined) delete g.requestAnimationFrame;
    else g.requestAnimationFrame = saved;
  }
});
