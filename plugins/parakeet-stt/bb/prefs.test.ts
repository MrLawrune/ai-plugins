import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS, PrefsStore, SETTINGS_KEY } from "./prefs.ts";
import type { Prefs } from "./schemas.ts";
import { memKv } from "./test-kv.ts";

test("defaults mirror Handy settings", () => {
  assert.equal(DEFAULT_PREFS.shortcut, "ctrl+space");
  assert.equal(DEFAULT_PREFS.autoSubmit, false);
  assert.equal(DEFAULT_PREFS.removeFillers, true);
  assert.equal(DEFAULT_PREFS.correctionThreshold, 0.18);
  assert.equal(DEFAULT_PREFS.historyMaxEntries, 50);
  assert.equal(DEFAULT_PREFS.historyMaxAgeDays, 7);
});

test("settings persist as a versioned row under \"settings\"", async () => {
  const kv = memKv();
  const store = new PrefsStore(kv);
  await store.load();
  await store.update("desktop", { autoSubmit: true });
  assert.equal(SETTINGS_KEY, "settings");
  const row = kv.data[SETTINGS_KEY] as { v: number; shared: unknown; profiles: Record<string, unknown>; devices: unknown };
  assert.equal(row.v, 2);
  assert.deepEqual(Object.keys(row.profiles), ["desktop", "touch"]);
  assert.deepEqual(row.devices, {});
  assert.equal((row.shared as { historyMaxEntries: number }).historyMaxEntries, 50);
  assert.equal(Object.keys(kv.data).length, 1);
});

test("load ignores older rows and falls back to defaults on a missing or invalid row", async () => {
  const legacy = new PrefsStore(memKv({ "profiles-v1": { shared: {}, profiles: { a: { name: "A", prefs: {} } }, devices: {} }, prefs: { autoSubmit: true } }));
  await legacy.load();
  assert.deepEqual(legacy.profiles().map((p) => p.id), ["desktop", "touch"]);
  assert.equal(legacy.get().autoSubmit, false);
  for (const bad of ["junk", null, 3, [], { v: 2 }, { v: 2, profiles: {} }]) {
    const store = new PrefsStore(memKv({ settings: bad }));
    await store.load();
    assert.deepEqual(store.get(), DEFAULT_PREFS);
    assert.deepEqual(store.profiles().map((p) => p.id), ["desktop", "touch"]);
  }
});

test("concurrent updates apply in call order", async () => {
  const kv = memKv();
  const slow = { ...kv, async set(k: string, v: unknown) { await new Promise((r) => setTimeout(r, Math.random() * 5)); await kv.set(k, v); } };
  const store = new PrefsStore(slow);
  await store.load();
  const words = Array.from({ length: 20 }, (_, i) => `w${i}`);
  await Promise.all(words.map((_, i) => store.update("desktop", { customWords: words.slice(0, i + 1) })));
  assert.deepEqual(store.get("desktop").customWords, words);
  const reloaded = new PrefsStore(kv);
  await reloaded.load();
  assert.deepEqual(reloaded.get("desktop").customWords, words);
});

test("concurrent profile creation stops at 20 profiles", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => store.createProfile(`P${i}`, "desktop")));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 18);
  assert.equal(store.profiles().length, 20);
});

test("20 concurrent updates of different fields keep every patch", async () => {
  const kv = memKv();
  const store = new PrefsStore({ ...kv, async set(k, v) { await new Promise((r) => setTimeout(r, Math.random() * 5)); await kv.set(k, v); } });
  await store.load();
  const patches: Partial<Prefs>[] = [
    { autoSubmit: true }, { trailingSpace: true }, { soundCues: false }, { holdToTalk: true }, { removeFillers: false },
    { correctionThreshold: 0.3 }, { historyMaxEntries: 10 }, { historyMaxAgeDays: 30 }, { pauseMs: 900 }, { endOnSilence: true },
    { silenceTimeoutS: 20 }, { voiceCommands: true }, { sendPhrase: "go" }, { stopPhrase: "halt" }, { clearPhrase: "wipe" },
    { waitForStart: true }, { hideNativeMic: false }, { keepListeningHidden: false }, { floatingMic: false }, { expandCompactDraft: false },
  ];
  await Promise.all(patches.map((p) => store.update("desktop", p)));
  const merged = Object.assign({}, ...patches);
  for (const [k, v] of Object.entries(merged)) assert.deepEqual(store.get("desktop")[k as keyof Prefs], v, k);
  const reloaded = new PrefsStore(kv);
  await reloaded.load();
  assert.deepEqual(reloaded.get("desktop"), store.get("desktop"));
});

test("a failed write leaves the committed state and does not block the queue", async () => {
  const kv = memKv();
  let fail = true;
  const store = new PrefsStore({ get: kv.get, async set(k, v) { if (fail) throw new Error("disk"); await kv.set(k, v); } });
  await store.load();
  await assert.rejects(store.update("desktop", { autoSubmit: true }), /disk/);
  assert.equal(store.get("desktop").autoSubmit, false);
  fail = false;
  await store.update("desktop", { trailingSpace: true });
  assert.deepEqual([store.get("desktop").autoSubmit, store.get("desktop").trailingSpace], [false, true]);
});

test("hello writes only for a new device or after ten minutes", async () => {
  const kv = memKv();
  const store = new PrefsStore(kv);
  await store.load();
  await store.hello("d1", "Linux PC", "desktop", 1_000);
  assert.equal(kv.writes, 1);
  const quick = await store.hello("d1", "Linux PC", "desktop", 1_000 + 599_999);
  assert.equal(quick.lastSeen, 600_999);
  assert.equal(store.devices()[0]!.lastSeen, 600_999); // in memory only
  assert.equal(kv.writes, 1);
  await store.hello("d1", "Linux PC", "desktop", 600_999 + 600_000);
  assert.equal(kv.writes, 2);
  await store.hello("d1", "Work PC", "touch", 2_000_000);
  assert.deepEqual([store.devices()[0]!.name, store.devices()[0]!.kind], ["Linux PC", "desktop"]); // known devices keep name and kind
  assert.equal(kv.writes, 3);
});

test("hello measures ten minutes from the stored last-seen, not the in-memory one", async () => {
  const kv = memKv();
  const store = new PrefsStore(kv);
  await store.load();
  await store.hello("d1", "Linux PC", "desktop", 1_000);
  await store.hello("d1", "Linux PC", "desktop", 400_000);
  assert.equal(kv.writes, 1);
  await store.hello("d1", "Linux PC", "desktop", 700_000);
  assert.equal(kv.writes, 2);
  assert.equal((kv.data[SETTINGS_KEY] as { devices: Record<string, { lastSeen: number }> }).devices.d1!.lastSeen, 700_000);
  await store.hello("d1", "Linux PC", "desktop", 1_000_000); // 300 s after the write
  assert.equal(kv.writes, 2);
  const reloaded = new PrefsStore(kv);
  await reloaded.load();
  await reloaded.hello("d1", "Linux PC", "desktop", 1_000_000); // load seeds the stored times
  assert.equal(kv.writes, 2);
  await reloaded.hello("d1", "Linux PC", "desktop", 1_300_000);
  assert.equal(kv.writes, 3);
});

test("a renamed device keeps its name when the browser says hello with its guessed name", async () => {
  const kv = memKv();
  const store = new PrefsStore(kv);
  await store.load();
  await store.hello("d1", "Linux PC", "desktop", 1_000);
  await store.updateDevice("d1", { name: "Desk" });
  const writes = kv.writes;
  const device = await store.hello("d1", "Linux PC", "desktop", 2_000);
  assert.deepEqual([device.name, device.lastSeen], ["Desk", 2_000]);
  assert.equal(kv.writes, writes);
  assert.equal((await store.hello("d1", "Linux PC", "desktop", 700_000)).name, "Desk"); // ≥10 min: written, name kept
  assert.equal(kv.writes, writes + 1);
});

test("history size prefs are shared, bounded, and persisted", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  await store.update("touch", { historyMaxEntries: 1000, historyMaxAgeDays: 90 });
  assert.deepEqual([store.get("desktop").historyMaxEntries, store.get("desktop").historyMaxAgeDays], [1000, 90]);
  await store.update("touch", { historyMaxEntries: 0 });
  assert.equal(store.get().historyMaxEntries, 0);
  for (const patch of [{ historyMaxEntries: 1001 }, { historyMaxEntries: -1 }, { historyMaxAgeDays: 0 }, { historyMaxAgeDays: 91 }, { historyMaxAgeDays: 1.5 }]) {
    await assert.rejects(store.update("touch", patch), /historyMax/, JSON.stringify(patch));
  }
  assert.equal(store.get().historyMaxEntries, 0);
});

test("update validates, persists, notifies; profile keys stay per profile, shared keys are shared", async () => {
  const kv = memKv();
  const store = new PrefsStore(kv);
  await store.load();
  const seen: boolean[] = [];
  store.onChange((n) => seen.push(n.waitForStart));
  await store.update("touch", { waitForStart: true, customWords: ["tmux"] });
  assert.deepEqual(seen, [true]);
  assert.equal(store.get("touch").waitForStart, true);
  assert.equal(store.get("desktop").waitForStart, false);
  assert.deepEqual(store.get("desktop").customWords, ["tmux"]);
  await assert.rejects(store.update("touch", { correctionThreshold: 2 }));
  assert.equal(store.get("touch").correctionThreshold, 0.18);
  await assert.rejects(store.update("nope", { autoSubmit: true }));
  const reloaded = new PrefsStore(kv);
  await reloaded.load();
  assert.equal(reloaded.get("touch").waitForStart, true);
  assert.deepEqual(reloaded.get("desktop").customWords, ["tmux"]);
});

test("custom words are trimmed and de-duplicated", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  const p = await store.update("desktop", { customWords: [" tmux ", "tmux", "", "CLAUDE.md"] });
  assert.deepEqual(p.customWords, ["tmux", "CLAUDE.md"]);
});

test("new devices get their kind's profile", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  await store.update("touch", { floatingMic: false });
  const phone = await store.hello("p1", "Android phone", "touch", 1);
  const pc = await store.hello("d1", "Linux PC", "desktop", 2);
  const tab = await store.hello("t1", "Android tablet", "touch", 3);
  assert.deepEqual([phone.profileId, pc.profileId, tab.profileId], ["touch", "desktop", "touch"]);
  assert.equal(store.forDevice("t1").floatingMic, false);
  assert.equal(store.forDevice("unknown").floatingMic, true); // first profile (Desktop)
  const again = await store.hello("p1", "ignored", "touch", 9);
  assert.deepEqual([again.name, again.lastSeen], ["Android phone", 9]);
  assert.deepEqual(store.devices().map((d) => d.id), ["p1", "t1", "d1"]);
});

test("named profiles: create, assign, rename, delete", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  await store.hello("p1", "Android phone", "touch", 1);
  await store.hello("p2", "Work phone", "touch", 2);
  await store.update("touch", { waitForStart: true });
  const hf = await store.createProfile("Hands free", "touch");
  assert.equal(hf.id, "hands-free");
  assert.equal(store.get("hands-free").waitForStart, true);
  assert.equal((await store.createProfile("Hands free", "desktop")).id, "hands-free-2");
  await store.updateDevice("p2", { profileId: "hands-free", name: "Pixel" });
  assert.deepEqual(store.devices().find((d) => d.id === "p2"), { id: "p2", name: "Pixel", kind: "touch", profileId: "hands-free", lastSeen: 2 });
  await assert.rejects(store.updateDevice("p2", { profileId: "missing" }));
  await store.renameProfile("hands-free", "Car");
  assert.equal(store.profiles().find((p) => p.id === "hands-free")?.name, "Car");
  await store.deleteProfile("hands-free");
  assert.equal(store.devices().find((d) => d.id === "p2")?.profileId, "touch");
  await store.forgetDevice("p2");
  assert.equal(store.devices().some((d) => d.id === "p2"), false);
});

test("the last profile cannot be deleted", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  await store.deleteProfile("touch");
  await assert.rejects(store.deleteProfile("desktop"));
});

test("streaming defaults", () => {
  assert.equal(DEFAULT_PREFS.mode, "continuous");
  assert.equal(DEFAULT_PREFS.livePreview, true);
  assert.equal(DEFAULT_PREFS.pauseMs, 600);
  assert.equal(DEFAULT_PREFS.endOnSilence, false);
  assert.equal(DEFAULT_PREFS.silenceTimeoutS, 8);
  assert.equal(DEFAULT_PREFS.voiceCommands, false);
  assert.equal(DEFAULT_PREFS.sendPhrase, "send it");
  assert.equal(DEFAULT_PREFS.stopPhrase, "stop listening");
  assert.equal(DEFAULT_PREFS.hideNativeMic, true);
});

test("keeps listening with the screen off by default", () => {
  assert.equal(DEFAULT_PREFS.keepListeningHidden, true);
});

test("floating mic on phones by default", () => {
  assert.equal(DEFAULT_PREFS.floatingMic, true);
});

test("collapsed composer shows more lines by default", () => {
  assert.equal(DEFAULT_PREFS.expandCompactDraft, true);
});

test("a stored settings row with one invalid field keeps every other field", async () => {
  const kv = memKv({
    settings: {
      v: 2,
      shared: { ...DEFAULT_PREFS, correctionThreshold: 9, sendPhrase: "ship it", customWords: ["tmux"] },
      profiles: { desktop: { name: "Desktop", prefs: { autoSubmit: true, pauseMs: 1 } }, touch: { name: "Touch screen", prefs: { floatingMic: false } } },
      devices: { d1: { id: "d1", name: "", kind: "toaster", profileId: "touch", lastSeen: 4 } },
    },
  });
  const store = new PrefsStore(kv);
  await store.load();
  const desktop = store.get("desktop");
  assert.equal(desktop.correctionThreshold, DEFAULT_PREFS.correctionThreshold);
  assert.equal(desktop.sendPhrase, "ship it");
  assert.deepEqual(desktop.customWords, ["tmux"]);
  assert.equal(desktop.autoSubmit, true);
  assert.equal(desktop.pauseMs, DEFAULT_PREFS.pauseMs);
  assert.equal(store.get("touch").floatingMic, false);
  assert.deepEqual(store.devices().map((d) => [d.id, d.name, d.kind, d.profileId]), [["d1", "Device", "desktop", "touch"]]);
});
