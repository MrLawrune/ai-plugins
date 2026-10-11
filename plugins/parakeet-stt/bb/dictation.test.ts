import { test } from "node:test";
import assert from "node:assert/strict";
import { appendDictation, DictationController, matchesShortcut } from "./dictation.ts";
import { target, harness, streamHarness } from "./test-dictation.ts";

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
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const c = new DictationController({
    async startRecording() { return { async stop() { return new Blob(["x"]); }, cancel() {} }; },
    async transcribe() { await gate; return "lost words"; },
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: false, mode: "oneshot" as const, livePreview: true }),
    playSound: () => {},
    notify: (k, m) => log.push(`${k}:${m}`),
    now: () => 0,
  });
  const unregister = c.register(target({ appendText: () => log.push("appended") }));
  await c.start("t1");
  const stopping = c.stop(); // transcribing: closing now cannot cancel, the text has nowhere to go
  unregister();
  release();
  await stopping;
  assert.ok(!log.includes("appended"));
  assert.ok(log.some((l) => l.startsWith("info:") && l.includes("history")), log.join(" | "));
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

test("explicit oneshot mode overrides the continuous default (press-and-hold)", async () => {
  const s = streamHarness();
  await s.c.start("t1", "oneshot");
  assert.equal(s.c.snapshot().phase, "recording");
  assert.ok(s.log.includes("oneshot:start") && !s.log.includes("stream:start"));
});

test("a superseded one-shot mic prompt that resolves late is cancelled and leaves the new session alone", async () => {
  const prompts: Array<{ resolve: (h: import("./dictation.ts").RecordingHandle) => void; reject: (e: Error) => void }> = [];
  const h = harness({ startRecording: () => new Promise((resolve, reject) => { prompts.push({ resolve, reject }); }) });
  const first = h.c.start();
  h.c.cancel();
  const second = h.c.start();
  assert.equal(prompts.length, 2);
  const late = { cancelled: 0, stopped: 0 };
  prompts[0].resolve({ async stop() { late.stopped++; return new Blob(["x"]); }, cancel() { late.cancelled++; } });
  await first;
  assert.equal(late.cancelled, 1);
  assert.equal(late.stopped, 0);
  assert.equal(h.c.snapshot().phase, "recording");
  const live = { cancelled: 0 };
  prompts[1].resolve({ async stop() { return new Blob(["x"]); }, cancel() { live.cancelled++; } });
  await second;
  assert.equal(live.cancelled, 0);
  await h.c.stop();
  assert.equal(h.c.snapshot().phase, "idle");
  assert.equal(h.draft(), "fix the hello world");
});

test("a superseded one-shot mic prompt that fails late is ignored", async () => {
  const prompts: Array<{ resolve: (h: import("./dictation.ts").RecordingHandle) => void; reject: (e: Error) => void }> = [];
  const h = harness({ startRecording: () => new Promise((resolve, reject) => { prompts.push({ resolve, reject }); }) });
  const first = h.c.start();
  h.c.cancel();
  const second = h.c.start();
  prompts[0].reject(new Error("denied"));
  await first;
  assert.equal(h.c.snapshot().phase, "recording");
  assert.ok(!h.log.some((l) => l.startsWith("error:")), h.log.join(" | "));
  prompts[1].resolve({ async stop() { return new Blob(["x"]); }, cancel() {} });
  await second;
  assert.equal(h.c.snapshot().phase, "recording");
});

test("cancel while the mic prompt is pending, then the prompt is denied: no late error cue or toast", async () => {
  let deny!: (e: Error) => void;
  const h = harness({ startRecording: () => new Promise((_, reject) => { deny = reject; }) });
  const starting = h.c.start();
  h.c.cancel();
  deny(new DOMException("Permission denied", "NotAllowedError"));
  await starting;
  assert.equal(h.c.snapshot().phase, "idle");
  assert.ok(!h.log.some((l) => l.startsWith("error:") || l === "sound:error"), h.log.join(" | "));
});
