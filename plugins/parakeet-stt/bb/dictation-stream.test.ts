import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamServerError } from "./stream-protocol.ts";
import { streamHarness } from "./test-dictation.ts";

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

test("continuous: start phrase waits, starts, sends, and waits again", async () => {
  const cues: string[] = [];
  const s = streamHarness({
    prefs: () => ({ autoSubmit: false, trailingSpace: false, soundCues: true, mode: "continuous", livePreview: true }),
    playSound: (n) => cues.push(n),
  });
  await s.c.start();
  s.h().onState(true);
  assert.equal(s.c.snapshot().waiting, true);
  s.h().onCommand("start");
  s.h().onState(false);
  assert.equal(s.c.snapshot().waiting, false);
  s.h().onFinal("Fix it.", 1);
  s.h().onCommand("send");
  s.h().onState(true);
  assert.equal(s.c.snapshot().waiting, true);
  assert.deepEqual(s.log.filter((l) => l === "begin" || l === "submit"), ["begin", "begin", "submit"]);
  assert.deepEqual(cues, ["start", "start", "stop"]);
  await s.c.stop();
  assert.equal(s.c.snapshot().waiting, false);
});

test("continuous: heard text shows while waiting and clears on start", async () => {
  const s = streamHarness();
  await s.c.start();
  s.h().onState(true);
  s.h().onHeard("star new replay");
  assert.equal(s.c.snapshot().heard, "star new replay");
  s.h().onState(false);
  assert.equal(s.c.snapshot().heard, null);
});

test("continuous: clear empties the draft and keeps listening", async () => {
  const s = streamHarness();
  await s.c.start();
  s.h().onFinal("Wrong words.", 0);
  s.h().onCommand("clear");
  s.h().onFinal("Take two.", 1);
  assert.equal(s.draft(), " Take two.");
  assert.equal(s.c.snapshot().phase, "streaming");
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

test("continuous: mic lost by the browser ends gracefully with a notice", async () => {
  const s = streamHarness();
  await s.c.start();
  s.interrupt("lost");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(s.log.includes("stream:stop"));
  assert.ok(s.log.some((l) => l.startsWith("info:") && l.includes("microphone")), s.log.join(" | "));
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

test("each start captures the insertion point once, before recording", async () => {
  const s = streamHarness();
  await s.c.start();
  assert.equal(s.log.filter((l) => l === "begin").length, 1);
  assert.ok(s.log.indexOf("begin") < s.log.indexOf("stream:start"));
});

test("cancel while the stream is connecting: a later connect failure does not start a recording", async () => {
  let fail!: (e: Error) => void;
  const s = streamHarness({ startStream: () => new Promise((_, reject) => { fail = reject; }) });
  const starting = s.c.start();
  s.c.cancel();
  fail(new Error("connect refused"));
  await starting;
  assert.equal(s.c.snapshot().phase, "idle");
  assert.ok(!s.log.includes("oneshot:start"), s.log.join(" | "));
  assert.equal(s.log.filter((l) => l === "end").length, 1);
});

test("a superseded connect that resolves late is cancelled and leaves the new session alone", async () => {
  const connects: Array<{ resolve: (h: import("./dictation.ts").StreamHandle) => void; reject: (e: Error) => void }> = [];
  let s2h: import("./dictation.ts").StreamHandlers | null = null;
  const s = streamHarness({
    startStream: (h) => new Promise((resolve, reject) => {
      connects.push({ resolve, reject });
      s2h = h;
    }),
  });
  const first = s.c.start();
  s.c.cancel();
  const second = s.c.start();
  assert.equal(connects.length, 2);
  const late = { stopped: 0, cancelled: 0 };
  connects[0].resolve({ async stop() { late.stopped++; }, cancel() { late.cancelled++; } });
  await first;
  assert.equal(late.cancelled, 1);
  assert.equal(late.stopped, 0);
  assert.equal(s.c.snapshot().phase, "streaming"); // the new session is untouched
  const live = { cancelled: 0 };
  connects[1].resolve({ async stop() { s2h!.onEnded("stopped"); }, cancel() { live.cancelled++; } });
  await second;
  assert.equal(live.cancelled, 0);
  assert.equal(s.c.snapshot().phase, "streaming");
  await s.c.stop();
  assert.equal(s.c.snapshot().phase, "idle");
  assert.ok(!s.log.includes("oneshot:start"));
});

test("a superseded connect that fails late does not fall back or disturb the new session", async () => {
  const connects: Array<{ resolve: (h: import("./dictation.ts").StreamHandle) => void; reject: (e: Error) => void }> = [];
  const s = streamHarness({ startStream: () => new Promise((resolve, reject) => { connects.push({ resolve, reject }); }) });
  const first = s.c.start();
  s.c.cancel();
  const second = s.c.start();
  connects[0].reject(new Error("connect refused"));
  await first;
  assert.equal(s.c.snapshot().phase, "streaming");
  assert.ok(!s.log.includes("oneshot:start"), s.log.join(" | "));
  assert.ok(!s.log.some((l) => l.startsWith("info:Streaming unavailable")), s.log.join(" | "));
  const live = { cancelled: 0 };
  connects[1].resolve({ async stop() {}, cancel() { live.cancelled++; } });
  await second;
  assert.equal(live.cancelled, 0);
  assert.equal(s.c.snapshot().phase, "streaming");
});

test("end() is not called while a stream falls back to one-shot", async () => {
  const s = streamHarness({ async startStream() { throw new Error("refused"); } });
  await s.c.start();
  assert.equal(s.log.filter((l) => l === "end").length, 0);
  await s.c.stop();
  assert.equal(s.log.filter((l) => l === "end").length, 1);
});

test("a fallback to one-shot never passes through idle", async () => {
  const s = streamHarness({ async startStream() { throw new Error("refused"); } });
  const phases: string[] = [];
  s.c.subscribe(() => phases.push(s.c.snapshot().phase));
  await s.c.start();
  assert.ok(!phases.includes("idle"), phases.join(","));
});

for (const message of ["Parakeet STT server URL is not set", "Can't reach the Parakeet server at https://stt.example", "Too many dictation sessions", "Invalid or missing API key"]) {
  test(`a server-reported stream failure ("${message}") is one error, no one-shot, back to idle`, async () => {
    const s = streamHarness({ async startStream() { throw new StreamServerError(message); } });
    await s.c.start();
    assert.equal(s.c.snapshot().phase, "idle");
    assert.ok(!s.log.includes("oneshot:start"), s.log.join(" | "));
    assert.deepEqual(s.log.filter((l) => /^(info|error):/.test(l)), [`error:${message}`]);
    assert.equal(s.log.filter((l) => l === "end").length, 1);
  });
}

test("a Stop pressed while the stream connects survives the fallback to one-shot", async () => {
  let fail!: (e: Error) => void;
  const s = streamHarness({ startStream: () => new Promise((_, reject) => { fail = reject; }) });
  const starting = s.c.start();
  await s.c.stop();
  fail(new Error("AudioWorklet is unavailable"));
  await starting;
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(s.log.includes("oneshot:start"));
  assert.equal(s.c.snapshot().phase, "idle", "the carried Stop ended the recording");
});

for (const mode of ["continuous", "oneshot"] as const) {
  test(`${mode}: a failed preflight is one error before any mic or socket opens`, async () => {
    let release!: (problem: string | null) => void;
    const s = streamHarness({ preflight: () => new Promise((r) => { release = r; }) });
    const starting = s.c.start("t1", mode);
    assert.notEqual(s.c.snapshot().phase, "idle", "a second press is ignored while the preflight runs");
    await s.c.toggle();
    release("Parakeet STT server URL is not set");
    await starting;
    assert.equal(s.c.snapshot().phase, "idle");
    assert.ok(!s.log.includes("oneshot:start") && !s.log.includes("stream:start"), s.log.join(" | "));
    assert.deepEqual(s.log.filter((l) => /^(info|error):/.test(l)), ["error:Parakeet STT server URL is not set"]);
    assert.equal(s.log.filter((l) => l === "end").length, 1);
  });
}

test("a passing preflight starts as before; a cancel during it starts nothing", async () => {
  const s = streamHarness({ async preflight() { return null; } });
  await s.c.start();
  assert.equal(s.c.snapshot().phase, "streaming");
  s.c.cancel();
  let release!: (problem: string | null) => void;
  const slow = streamHarness({ preflight: () => new Promise((r) => { release = r; }) });
  const starting = slow.c.start();
  slow.c.cancel();
  release(null);
  await starting;
  assert.ok(!slow.log.includes("stream:start"), slow.log.join(" | "));
  assert.equal(slow.c.snapshot().phase, "idle");
});
