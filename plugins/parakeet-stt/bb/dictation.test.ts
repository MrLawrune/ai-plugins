import { test } from "node:test";
import assert from "node:assert/strict";
import { appendDictation, DictationController, matchesShortcut, type DictationDeps, type Interruption } from "./dictation.ts";

function harness(over: Partial<DictationDeps> = {}) {
  const log: string[] = [];
  let interrupt: ((why: Interruption) => void) | null = null;
  const deps: DictationDeps = {
    async startRecording(onInterrupt) {
      interrupt = onInterrupt;
      log.push("rec:start");
      return { async stop() { log.push("rec:stop"); return new Blob(["x"]); }, cancel() { log.push("rec:cancel"); } };
    },
    async transcribe() { return "hello world"; },
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: true, mode: "oneshot" as const, livePreview: true }),
    playSound: (n) => log.push(`sound:${n}`),
    notify: (k, m) => log.push(`${k}:${m}`),
    now: () => 0,
    ...over,
  };
  const c = new DictationController(deps);
  let draft = "fix the";
  c.register({ id: "t1", setLive() {}, commitLive() {}, appendText: (t) => { draft = appendDictation(draft, t, false); }, submit: () => log.push("submit") });
  return { c, log, draft: () => draft, interrupt: (w: Interruption) => interrupt!(w) };
}

test("toggle records then transcribes into the target", async () => {
  const h = harness();
  await h.c.toggle();
  assert.equal(h.c.snapshot().phase, "recording");
  await h.c.toggle();
  assert.equal(h.c.snapshot().phase, "idle");
  assert.equal(h.draft(), "fix the hello world");
  assert.deepEqual(h.log, ["rec:start", "sound:start", "rec:stop", "sound:stop"]);
});

test("cancel discards audio", async () => {
  const h = harness();
  await h.c.start();
  h.c.cancel();
  assert.equal(h.c.snapshot().phase, "idle");
  assert.equal(h.draft(), "fix the");
  assert.ok(h.log.includes("rec:cancel") && h.log.includes("sound:cancel"));
});

test("empty transcript leaves draft and says no speech", async () => {
  const h = harness({ async transcribe() { return "  "; } });
  await h.c.start();
  await h.c.stop();
  assert.equal(h.draft(), "fix the");
  assert.ok(h.log.includes("info:No speech detected"));
});

test("mic failure notifies and returns to idle; next press works", async () => {
  let fail = true;
  const h = harness({
    async startRecording() {
      if (fail) throw new DOMException("Permission denied", "NotAllowedError");
      return { async stop() { return new Blob(["x"]); }, cancel() {} };
    },
  });
  await h.c.start();
  assert.equal(h.c.snapshot().phase, "idle");
  assert.ok(h.log.some((l) => l.startsWith("error:") && l.includes("Permission denied")));
  fail = false;
  await h.c.start();
  assert.equal(h.c.snapshot().phase, "recording");
});

test("transcription failure plays error and keeps draft", async () => {
  const h = harness({ async transcribe() { throw new Error("server down"); } });
  await h.c.start();
  await h.c.stop();
  assert.equal(h.c.snapshot().phase, "idle");
  assert.ok(h.log.includes("sound:error") && h.log.includes("error:server down"));
  assert.equal(h.draft(), "fix the");
});

test("page hidden mid-recording still transcribes, with a notice", async () => {
  const h = harness();
  await h.c.start();
  h.interrupt("hidden");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.c.snapshot().phase, "idle");
  assert.equal(h.draft(), "fix the hello world");
  assert.ok(h.log.some((l) => l.startsWith("info:") && l.includes("hidden")));
});

test("autoSubmit submits after appending", async () => {
  const h = harness({ prefs: () => ({ autoSubmit: true, trailingSpace: false, soundCues: false, mode: "oneshot" as const, livePreview: true }) });
  await h.c.start();
  await h.c.stop();
  assert.equal(h.log.at(-1), "submit");
  assert.ok(!h.log.some((l) => l.startsWith("sound:")));
});

test("toggle is ignored while transcribing", async () => {
  let release!: (t: string) => void;
  const h = harness({ transcribe: () => new Promise<string>((r) => { release = r; }) });
  await h.c.start();
  const stopping = h.c.stop();
  assert.equal(h.c.snapshot().phase, "transcribing");
  await h.c.toggle();
  assert.equal(h.c.snapshot().phase, "transcribing");
  release("ok");
  await stopping;
  assert.equal(h.c.snapshot().phase, "idle");
});

test("no registered target -> start is a no-op", async () => {
  const c = new DictationController(null);
  await c.start();
  assert.equal(c.snapshot().phase, "idle");
});

test("appendDictation spacing", () => {
  assert.equal(appendDictation("", "Hi.", false), "Hi.");
  assert.equal(appendDictation("a", "Hi.", false), "a Hi.");
  assert.equal(appendDictation("a\n", "Hi.", false), "a\nHi.");
  assert.equal(appendDictation("a ", "Hi.", true), "a Hi. ");
});

test("matchesShortcut is exact", () => {
  const ev = (code: string, m: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });
  assert.equal(matchesShortcut(ev("Space", { ctrlKey: true }), "ctrl+space"), true);
  assert.equal(matchesShortcut(ev("Space", { ctrlKey: true, shiftKey: true }), "ctrl+space"), false);
  assert.equal(matchesShortcut(ev("Space", { ctrlKey: true, shiftKey: true }), "ctrl+shift+space"), true);
  assert.equal(matchesShortcut(ev("Space", { altKey: true }), "alt+space"), true);
  assert.equal(matchesShortcut(ev("Space"), "ctrl+space"), false);
  assert.equal(matchesShortcut(ev("Space", { ctrlKey: true }), "off"), false);
});

test("stop pressed before the mic resolves still stops once it does (hold-to-talk release)", async () => {
  let resolveMic!: () => void;
  const log: string[] = [];
  const h = harness({
    startRecording: () => new Promise((r) => {
      resolveMic = () => r({ async stop() { log.push("rec:stop"); return new Blob(["x"]); }, cancel() {} });
    }),
  });
  const starting = h.c.start();
  const stopping = h.c.stop();
  resolveMic();
  await starting;
  await stopping;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.c.snapshot().phase, "idle");
  assert.deepEqual(log, ["rec:stop"]);
  assert.equal(h.draft(), "fix the hello world");
});

test("composer closed before the transcript arrives: user is told where the text went", async () => {
  const log: string[] = [];
  const c = new DictationController({
    async startRecording() { return { async stop() { return new Blob(["x"]); }, cancel() {} }; },
    async transcribe() { return "lost words"; },
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: false, mode: "oneshot" as const, livePreview: true }),
    playSound: () => {},
    notify: (k, m) => log.push(`${k}:${m}`),
    now: () => 0,
  });
  const unregister = c.register({ id: "t1", setLive() {}, commitLive() {}, appendText: () => log.push("appended"), submit: () => {} });
  await c.start("t1");
  unregister();
  await c.stop();
  assert.ok(!log.includes("appended"));
  assert.ok(log.some((l) => l.startsWith("info:") && l.includes("history")), log.join(" | "));
});

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
  c.register({ id: "t1", setLive() {}, commitLive() {}, appendText: (t) => log.push(`action:${t}`), submit: () => {} });
  const unregisterBanner = c.register({ id: "t1", setLive() {}, commitLive() {}, appendText: (t) => log.push(`banner:${t}`), submit: () => {} });
  unregisterBanner();
  await c.toggle("t1");
  assert.equal(c.snapshot().phase, "recording");
  await c.toggle("t1");
  assert.deepEqual(log, ["action:hi"]);
});

test("cancel while the mic prompt is pending releases the mic once it resolves", async () => {
  let resolveMic!: () => void;
  const log: string[] = [];
  const h = harness({
    startRecording: () => new Promise((r) => {
      resolveMic = () => r({ async stop() { log.push("rec:stop"); return new Blob(["x"]); }, cancel() { log.push("rec:cancel"); } });
    }),
  });
  const starting = h.c.start();
  h.c.cancel();
  resolveMic();
  await starting;
  assert.equal(h.c.snapshot().phase, "idle");
  assert.deepEqual(log, ["rec:cancel"]);
});

function streamHarness(over: Partial<DictationDeps> = {}) {
  const log: string[] = [];
  let handlers: import("./dictation.ts").StreamHandlers | null = null;
  let interrupt: ((w: Interruption) => void) | null = null;
  let draft = "Start.";
  let live = "";
  const deps: DictationDeps = {
    async startRecording() { log.push("oneshot:start"); return { async stop() { return new Blob(["x"]); }, cancel() {} }; },
    async transcribe() { return "one shot text"; },
    async startStream(h, onInterrupt) {
      handlers = h; interrupt = onInterrupt; log.push("stream:start");
      return {
        async stop() { log.push("stream:stop"); h.onEnded("stopped"); },
        cancel() { log.push("stream:cancel"); },
      };
    },
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: false, mode: "continuous", livePreview: true }),
    playSound: () => {},
    notify: (k, m) => log.push(`${k}:${m}`),
    now: () => 0,
    ...over,
  };
  const c = new DictationController(deps);
  c.register({
    id: "t1",
    appendText: (t) => { draft = `${draft} ${t}`; },
    submit: () => log.push("submit"),
    setLive: (t) => { live = t; },
    commitLive: (t) => { live = ""; if (t) draft = `${draft} ${t}`; },
  });
  return { c, log, h: () => handlers!, interrupt: (w: Interruption) => interrupt!(w), draft: () => draft, live: () => live };
}

test("continuous: partials set the live tail, finals commit, send submits, stop ends", async () => {
  const s = streamHarness();
  await s.c.toggle();
  assert.equal(s.c.snapshot().phase, "streaming");
  s.h().onPartial("hello wor", 0);
  assert.equal(s.live(), "hello wor");
  s.h().onFinal("Hello world.", 0);
  assert.equal(s.live(), "");
  assert.equal(s.draft(), "Start. Hello world.");
  s.h().onCommand("send");
  assert.ok(s.log.includes("submit"));
  await s.c.toggle();
  assert.equal(s.c.snapshot().phase, "idle");
  assert.ok(s.log.includes("stream:stop"));
});

test("continuous: live preview off ignores partials", async () => {
  const s = streamHarness({ prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: false, mode: "continuous", livePreview: false }) });
  await s.c.start();
  s.h().onPartial("ignored", 0);
  assert.equal(s.live(), "");
});

test("continuous: connect failure falls back to one-shot", async () => {
  const s = streamHarness({ async startStream() { throw new Error("connect refused"); } });
  await s.c.start();
  assert.equal(s.c.snapshot().phase, "recording");
  assert.ok(s.log.includes("oneshot:start"));
  assert.ok(s.log.some((l) => l.startsWith("info:") && l.includes("one-shot")));
});

test("continuous: disconnect keeps the live text as solid and warns", async () => {
  const s = streamHarness();
  await s.c.start();
  s.h().onPartial("half a sen", 0);
  s.h().onError("Parakeet STT stream closed (1006)");
  s.h().onEnded("error");
  assert.equal(s.c.snapshot().phase, "idle");
  assert.equal(s.draft(), "Start. half a sen");
  assert.ok(s.log.some((l) => l.includes("may be incomplete")));
});

test("continuous: silence end notifies", async () => {
  const s = streamHarness();
  await s.c.start();
  s.h().onEnded("silence");
  assert.equal(s.c.snapshot().phase, "idle");
  assert.ok(s.log.some((l) => l.startsWith("info:") && l.toLowerCase().includes("silence")));
});

test("continuous: cancel clears the tail and stops streaming", async () => {
  const s = streamHarness();
  await s.c.start();
  s.h().onPartial("draft words", 0);
  s.c.cancel();
  assert.equal(s.live(), "");
  assert.ok(s.log.includes("stream:cancel"));
  assert.equal(s.c.snapshot().phase, "idle");
});

test("continuous: page hidden stops the stream gracefully", async () => {
  const s = streamHarness();
  await s.c.start();
  s.interrupt("hidden");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(s.log.includes("stream:stop"));
  assert.equal(s.c.snapshot().phase, "idle");
});

test("stop during stream connect stops once connected", async () => {
  let release!: () => void;
  const s = streamHarness({
    startStream: (h) => new Promise((resolve) => {
      release = () => resolve({ async stop() { h.onEnded("stopped"); }, cancel() {} });
    }),
  });
  const starting = s.c.start();
  const stopping = s.c.stop();
  release();
  await starting;
  await stopping;
  assert.equal(s.c.snapshot().phase, "idle");
});

test("explicit oneshot mode overrides the continuous default (press-and-hold)", async () => {
  const s = streamHarness();
  await s.c.start("t1", "oneshot");
  assert.equal(s.c.snapshot().phase, "recording");
  assert.ok(s.log.includes("oneshot:start") && !s.log.includes("stream:start"));
});

test("continuous: mic lost by the browser ends gracefully with a notice", async () => {
  const s = streamHarness();
  await s.c.start();
  s.interrupt("lost");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(s.log.includes("stream:stop"));
  assert.ok(s.log.some((l) => l.startsWith("info:") && l.includes("microphone")), s.log.join(" | "));
});

test("targetCount tracks registrations and notifies subscribers", () => {
  const c = new DictationController(null);
  let notified = 0;
  c.subscribe(() => notified++);
  assert.equal(c.targetCount(), 0);
  const off = c.register({ id: "a", appendText() {}, submit() {}, setLive() {}, commitLive() {} });
  assert.equal(c.targetCount(), 1);
  off();
  assert.equal(c.targetCount(), 0);
  assert.equal(notified, 2);
});
