import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaPauser, pauseSupported, runCmd, type Runner } from "./pause.ts";

function fake(players: Record<string, string>) {
  const calls: string[] = [];
  const run: Runner = async (args) => {
    calls.push(args.join(" "));
    if (args[1] === "-l") return { code: 0, out: Object.keys(players).join("\n") };
    if (args[3] === "status") return { code: 0, out: players[args[2]] ?? "" };
    return { code: 0, out: "" };
  };
  const timers: { fn: () => void; ms: number }[] = [];
  return { calls, run, timers, setTimer: (fn: () => void, ms: number) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: (h: unknown) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); } };
}

test("pauses only playing players and resumes only those", async () => {
  const f = fake({ spotify: "Playing", vlc: "Paused" });
  const p = new MediaPauser({ run: f.run, setTimer: f.setTimer, clearTimer: f.clearTimer });
  assert.equal(await p.start("a", "pause"), true);
  await p.end("a");
  f.timers.find((t) => t.ms === 500)!.fn(); await new Promise((r) => setImmediate(r));
  assert.ok(f.calls.includes("playerctl -p spotify pause")); assert.ok(f.calls.includes("playerctl -p spotify play"));
  assert.ok(!f.calls.includes("playerctl -p vlc play"));
});
test("back-to-back replies share one pause", async () => {
  const f = fake({ spotify: "Playing" });
  const p = new MediaPauser({ run: f.run, setTimer: f.setTimer, clearTimer: f.clearTimer });
  await p.start("a", "pause"); await p.end("a"); await p.start("b", "pause");
  assert.equal(f.calls.filter((c) => c.endsWith("pause")).length, 1);
});
test("keep mode does nothing", async () => {
  const f = fake({ spotify: "Playing" });
  assert.equal(await new MediaPauser({ run: f.run }).start("a", "keep"), false); assert.equal(f.calls.length, 0);
});
test("dispose resumes", async () => {
  const f = fake({ spotify: "Playing" });
  const p = new MediaPauser({ run: f.run, setTimer: f.setTimer, clearTimer: f.clearTimer });
  await p.start("a", "pause"); await p.dispose();
  assert.ok(f.calls.includes("playerctl -p spotify play")); assert.equal(p.applied, false); assert.equal(f.timers.length, 0);
});
test("the safety timer force-resumes", async () => {
  const f = fake({ spotify: "Playing" });
  const p = new MediaPauser({ run: f.run, setTimer: f.setTimer, clearTimer: f.clearTimer });
  await p.start("a", "pause");
  f.timers.find((t) => t.ms === 600_000)!.fn(); await new Promise((r) => setImmediate(r));
  assert.ok(f.calls.includes("playerctl -p spotify play"));
});

test("a reply starting during the release delay keeps media paused", async () => {
  const f = fake({ spotify: "Playing" });
  const p = new MediaPauser({ run: f.run, setTimer: f.setTimer, clearTimer: f.clearTimer });
  await p.start("a", "pause"); await p.end("a");
  const release = f.timers.find((t) => t.ms === 500)!;
  await p.start("b", "pause");
  assert.equal(f.timers.includes(release), false);
  release.fn(); await new Promise((r) => setImmediate(r));
  assert.ok(!f.calls.includes("playerctl -p spotify play")); assert.equal(p.applied, true);
  await p.dispose();
});
test("ending an unknown key is a no-op", async () => {
  const f = fake({ spotify: "Playing" });
  const p = new MediaPauser({ run: f.run, setTimer: f.setTimer, clearTimer: f.clearTimer });
  await p.end("x");
  assert.equal(f.calls.length, 0); assert.equal(f.timers.length, 0);
});
test("a failed pause is not resumed, a failed list pauses nothing", async () => {
  const calls: string[] = [];
  const run: Runner = async (args) => {
    calls.push(args.join(" "));
    if (args[1] === "-l") return { code: 0, out: "a\nb\n" };
    if (args[3] === "status") return { code: 0, out: "Playing\n" };
    return { code: args[2] === "a" && args[3] === "pause" ? 1 : 0, out: "" };
  };
  const p = new MediaPauser({ run, setTimer: () => 0, clearTimer: () => {} });
  await p.start("k", "pause"); await p.dispose();
  assert.ok(!calls.includes("playerctl -p a play")); assert.ok(calls.includes("playerctl -p b play"));
  const none = new MediaPauser({ run: async (args) => { calls.push(`none ${args.join(" ")}`); return { code: 1, out: "" }; }, setTimer: () => 0, clearTimer: () => {} });
  assert.equal(await none.start("k", "pause"), true);
  assert.deepEqual(calls.filter((c) => c.startsWith("none")), ["none playerctl -l"]);
  await none.dispose();
});
test("commands get a 2 s timeout and a signal aborted only after dispose's resumes", async () => {
  const seen: { args: string; ms: number; aborted: boolean }[] = [];
  let signal: AbortSignal | undefined;
  const run: Runner = async (args, ms, s) => {
    signal = s; seen.push({ args: args.join(" "), ms, aborted: s.aborted });
    if (args[1] === "-l") return { code: 0, out: "spotify" };
    if (args[3] === "status") return { code: 0, out: "Playing" };
    return { code: 0, out: "" };
  };
  const p = new MediaPauser({ run, setTimer: () => 0, clearTimer: () => {} });
  await p.start("a", "pause"); await p.dispose();
  assert.ok(seen.every((s) => s.ms === 2000 && !s.aborted)); assert.equal(seen.at(-1)!.args, "playerctl -p spotify play");
  assert.equal(signal!.aborted, true);
});

test("pauseSupported needs linux and playerctl", () => {
  assert.equal(pauseSupported("linux", () => true), true);
  assert.equal(pauseSupported("linux", () => false), false);
  assert.equal(pauseSupported("darwin", () => true), false);
});

test("runCmd returns exit code and stdout", async () => {
  assert.deepEqual(await runCmd(["sh", "-c", "echo hi; exit 3"], 2000, new AbortController().signal), { code: 3, out: "hi\n" });
});
test("runCmd gives 127 for a missing tool", async () => {
  assert.deepEqual(await runCmd(["kokoro-no-such-tool-xyz"], 2000, new AbortController().signal), { code: 127, out: "" });
});
test("runCmd kills the child on timeout", async () => {
  const t0 = Date.now();
  const r = await runCmd(["sleep", "10"], 100, new AbortController().signal);
  assert.notEqual(r.code, 0); assert.ok(Date.now() - t0 < 2000);
});
test("runCmd kills the child on abort, including an already-aborted signal", async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const pending = runCmd(["sleep", "10"], 5000, ac.signal);
  setTimeout(() => ac.abort(), 50);
  assert.notEqual((await pending).code, 0);
  assert.notEqual((await runCmd(["sleep", "10"], 5000, ac.signal)).code, 0);
  assert.ok(Date.now() - t0 < 2000);
});
test("runCmd caps stdout at 64 KiB", async () => {
  const r = await runCmd(["sh", "-c", "head -c 200000 /dev/zero | tr '\\0' a"], 2000, new AbortController().signal);
  assert.equal(r.out.length, 64 * 1024);
});
