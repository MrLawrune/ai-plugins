import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type Mode, type Settings } from "../schemas.ts";
import { TurnCoordinator, voiceLabel } from "./turns.ts";

interface Options {
  settings?: Partial<Settings>;
  ready?: boolean;
  /** Make the named log method throw. */
  failLog?: "add";
}

function harness(o: Options = {}) {
  const calls: unknown[][] = [];
  const published: unknown[] = [];
  const warnings: string[] = [];
  let muted = false;
  let nextId = 1;
  const turns = new TurnCoordinator({
    settings: () => ({ ...DEFAULT_SETTINGS, ...o.settings }),
    muted: () => muted,
    log: {
      add: (text, sessionId, voice) => {
        calls.push(["add", text, sessionId, voice]);
        if (o.failLog === "add") throw new Error("db down");
        return { id: nextId++, ts: 0, session_id: sessionId, text: text.replace(/\s+/gu, " ").trim(), status: "queued" };
      },
      setStatus: (...a) => { calls.push(["setStatus", ...a]); },
      deleteThread: (...a) => { calls.push(["deleteThread", ...a]); return 0; },
    },
    hub: {
      speak: (...a) => { calls.push(["speak", ...a]); },
      sound: (...a) => { calls.push(["sound", ...a]); },
      stop: (...a) => { calls.push(["stop", ...a]); },
      hasReadyClient: () => o.ready ?? true,
    },
    publish: (channel, payload) => {
      assert.equal(channel, "kokoro-turn");
      published.push(payload);
    },
    warn: (m) => { warnings.push(m); },
  });
  const speaks = () => calls.filter((c) => c[0] === "speak");
  return { turns, calls, published, warnings, speaks, setMuted: (m: boolean) => { muted = m; } };
}

const A = "All done.";
const brief: Mode = "brief";

test("speaks the directive and logs the unstripped say", async () => {
  const { turns, calls, published } = harness();
  await turns.idle("t", 'Done.\n::kokoro-tts{weight="speech" say="Tests **pass**."}', brief);
  assert.deepEqual(calls, [
    ["add", "Tests **pass**.", "t", "af_sky"],
    ["speak", 1, "Tests pass.", "t", 1],
  ]);
  assert.deepEqual(published, [
    { threadId: "t", pending: true },
    { threadId: "t", action: "speech", text: "Tests **pass**.", say: "Tests **pass**." },
  ]);
  assert.equal(turns.hasSpoken("t"), true);
});

test("the logged text the card sees is the store's normalized text", async () => {
  const { turns, published } = harness();
  await turns.idle("t", 'x\n::kokoro-tts{weight="speech" say="One\ttwo."}', brief);
  assert.deepEqual(published.at(-1), { threadId: "t", action: "speech", text: "One two.", say: "One\ttwo." });
});

test("empty or whitespace text does nothing", async () => {
  const { turns, calls, published } = harness();
  await turns.idle("t", "   ", brief);
  assert.deepEqual([calls, published], [[], []]);
});

test("muted turns publish muted and set no repeat key", async () => {
  const h = harness();
  h.setMuted(true);
  await h.turns.idle("t", `x\n::kokoro-tts{weight="speech" say="${A}"}`, brief);
  assert.deepEqual(h.published, [{ threadId: "t", pending: true }, { threadId: "t", action: "silent", muted: true, say: A }]);
  assert.deepEqual(h.calls, []);
  h.setMuted(false);
  await h.turns.idle("t", `x\n::kokoro-tts{weight="speech" say="${A}"}`, brief);
  assert.equal(h.speaks().length, 1);
});

test("repeat survives an active/idle cycle", async () => {
  const h = harness();
  await h.turns.idle("t", A, brief);
  await h.turns.interrupt("t");
  await h.turns.idle("t", ` ${A} `, brief);
  assert.equal(h.speaks().length, 1);
  assert.deepEqual(h.calls.at(-1), ["stop", "t"]);
  assert.deepEqual(h.published.at(-1), { threadId: "t", action: "silent" });
});

test("a repeat tells cards its say", async () => {
  const h = harness();
  const text = `x\n::kokoro-tts{weight="speech" say="${A}"}`;
  await h.turns.idle("t", text, brief);
  await h.turns.idle("t", text, brief);
  assert.deepEqual(h.published.at(-1), { threadId: "t", action: "silent", say: A });
});

test("a different thread may say the same thing", async () => {
  const h = harness();
  await h.turns.idle("t1", A, brief);
  await h.turns.idle("t2", A, brief);
  assert.equal(h.speaks().length, 2);
});

test("archive and delete forget the repeat key; only delete drops log rows", async () => {
  const h = harness();
  await h.turns.idle("t", A, brief);
  await h.turns.archived("t");
  assert.equal(h.turns.hasSpoken("t"), false);
  await h.turns.idle("t", A, brief);
  await h.turns.deleted("t");
  await h.turns.idle("t", A, brief);
  assert.equal(h.speaks().length, 3);
  assert.deepEqual(h.calls.filter((c) => c[0] === "stop" || c[0] === "deleteThread"), [
    ["stop", "t"], ["stop", "t"], ["deleteThread", "t"],
  ]);
});

test("empty after strip plays done and logs empty", async () => {
  const { turns, calls, published } = harness({ settings: { sound_volume: 0.4 } });
  await turns.idle("t", "x\n::kokoro-tts{weight=\"speech\" say=\"`~/x`\"}", brief);
  assert.deepEqual(calls, [["add", "`~/x`", "t", "af_sky"], ["setStatus", 1, "empty"], ["sound", "done", 0.4, "t"]]);
  assert.deepEqual(published.at(-1), { threadId: "t", action: "sound", text: "`~/x`", say: "`~/x`" });
});

test("strip_markdown off speaks the say as written", async () => {
  const { turns, speaks } = harness({ settings: { strip_markdown: false, speech_gain: 0.8 } });
  await turns.idle("t", 'x\n::kokoro-tts{weight="speech" say="**Yes**."}', brief);
  assert.deepEqual(speaks(), [["speak", 1, "**Yes**.", "t", 0.8]]);
});

test("ambient caps speech to a sound", async () => {
  const { turns, calls, published } = harness({ settings: { sound_volume: 0.6 } });
  await turns.idle("t", A, "ambient");
  assert.deepEqual(calls, [["sound", "attention", 0.6, "t"]]);
  assert.deepEqual(published.at(-1), { threadId: "t", action: "sound" });
  assert.equal(turns.hasSpoken("t"), true);
});

test("a silent route publishes silent and marks nothing spoken", async () => {
  const { turns, calls, published } = harness();
  await turns.idle("t", 'x\n::kokoro-tts{weight="silent"}', brief);
  assert.deepEqual(calls, []);
  assert.deepEqual(published.at(-1), { threadId: "t", action: "silent" });
  assert.equal(turns.hasSpoken("t"), false);
});

test("a failing step warns and still settles the card", async () => {
  const { turns, published, warnings } = harness({ failLog: "add" });
  await turns.idle("t", A, brief);
  assert.deepEqual(published.at(-1), { threadId: "t", action: "silent" });
  assert.match(warnings[0] ?? "", /db down/u);
});

test("calls for one thread run in order", async () => {
  const { turns, calls } = harness();
  const idle = turns.idle("t", A, brief);
  const del = turns.deleted("t");
  await Promise.all([idle, del]);
  const names = calls.map((c) => c[0]);
  assert.ok(names.indexOf("add") < names.indexOf("deleteThread"), names.join(","));
  assert.ok(names.indexOf("speak") < names.indexOf("stop"), names.join(","));
});

test("attention plays the ping unless muted, quiet, or switched off", async () => {
  const on = harness({ settings: { sound_volume: 0.5 } });
  await on.turns.attention("t", brief);
  assert.deepEqual(on.calls, [["sound", "attention", 0.5, "t"]]);
  assert.equal(on.turns.hasSpoken("t"), true);
  const quiet = harness();
  await quiet.turns.attention("t", "quiet");
  const off = harness({ settings: { attention_sound: false } });
  await off.turns.attention("t", brief);
  const muted = harness();
  muted.setMuted(true);
  await muted.turns.attention("t", brief);
  assert.deepEqual([quiet.calls, off.calls, muted.calls], [[], [], []]);
});

test("replay bypasses mute and repeat", async () => {
  const h = harness();
  h.setMuted(true);
  await h.turns.idle("t", A, brief);
  assert.equal(h.speaks().length, 0);
  assert.deepEqual(await h.turns.replay("t", ` **${A}** `), { status: "playing" });
  assert.deepEqual(h.calls, [["add", `**${A}**`, "t", "af_sky"], ["speak", 1, A, "t", 1]]);
});

test("replay caps text at 2000 code points and reports empty after strip", async () => {
  const h = harness({ settings: { strip_markdown: false } });
  await h.turns.replay("t", "😀".repeat(2500));
  assert.equal(Array.from(h.calls[0][1] as string).length, 2000);
  const s = harness();
  assert.deepEqual(await s.turns.replay("t", "`~/x`"), { status: "empty_after_strip" });
  assert.deepEqual(s.calls, []);
});

test("no window → replay no_window", async () => {
  const { turns, calls } = harness({ ready: false });
  assert.deepEqual(await turns.replay("t", A), { status: "no_window" });
  assert.deepEqual(calls, []);
});

test("repeat map is bounded", async () => {
  const h = harness();
  for (let i = 0; i < 600; i++) await h.turns.idle(`t${i}`, A, brief);
  // t0 fell out of the 500-thread map, so the same text speaks again.
  await h.turns.idle("t0", A, brief);
  assert.equal(h.speaks().length, 601);
  // t599 is still remembered.
  await h.turns.idle("t599", A, brief);
  assert.equal(h.speaks().length, 601);
});

test("dispose drops repeat keys and spoken threads", async () => {
  const h = harness();
  await h.turns.idle("t", A, brief);
  h.turns.dispose();
  assert.equal(h.turns.hasSpoken("t"), false);
  await h.turns.idle("t", A, brief);
  assert.equal(h.speaks().length, 2);
});

test("voiceLabel names a voice or a blend", () => {
  assert.equal(voiceLabel("af_sky"), "af_sky");
  assert.equal(voiceLabel({ af_sky: 0.6, am_adam: 0.4 }), "af_sky + am_adam");
  assert.equal(voiceLabel({}), null);
});
