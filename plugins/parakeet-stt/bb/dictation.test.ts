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
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: true }),
    playSound: (n) => log.push(`sound:${n}`),
    notify: (k, m) => log.push(`${k}:${m}`),
    now: () => 0,
    ...over,
  };
  const c = new DictationController(deps);
  let draft = "fix the";
  c.register({ id: "t1", appendText: (t) => { draft = appendDictation(draft, t, false); }, submit: () => log.push("submit") });
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
  const h = harness({ prefs: () => ({ autoSubmit: true, trailingSpace: false, soundCues: false }) });
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
