import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS, PrefsStore } from "./prefs.ts";
import { memKv } from "./test-kv.ts";

test("defaults mirror Handy settings", () => {
  assert.equal(DEFAULT_PREFS.shortcut, "ctrl+space");
  assert.equal(DEFAULT_PREFS.autoSubmit, false);
  assert.equal(DEFAULT_PREFS.removeFillers, true);
  assert.equal(DEFAULT_PREFS.correctionThreshold, 0.18);
  assert.equal(DEFAULT_PREFS.historyLimit, 5);
});

test("prefs saved before profiles seed the Desktop and Phone profiles", async () => {
  const store = new PrefsStore(memKv({ prefs: { autoSubmit: true, customWords: ["tmux"], shortcut: "alt+space" } }));
  await store.load();
  assert.deepEqual(store.profiles().map((p) => p.id), ["desktop", "phone"]);
  for (const id of ["desktop", "phone"]) {
    assert.equal(store.get(id).autoSubmit, true);
    assert.equal(store.get(id).shortcut, "alt+space");
    assert.equal(store.get(id).mode, "continuous"); // fields added later get defaults
    assert.deepEqual(store.get(id).customWords, ["tmux"]);
  }
  const bad = new PrefsStore(memKv({ prefs: { shortcut: "f13" } }));
  await bad.load();
  assert.deepEqual(bad.get(), DEFAULT_PREFS);
});

test("update validates, persists, notifies; profile keys stay per profile, shared keys are shared", async () => {
  const kv = memKv();
  const store = new PrefsStore(kv);
  await store.load();
  const seen: boolean[] = [];
  store.onChange((n) => seen.push(n.waitForStart));
  await store.update("phone", { waitForStart: true, customWords: ["tmux"] });
  assert.deepEqual(seen, [true]);
  assert.equal(store.get("phone").waitForStart, true);
  assert.equal(store.get("desktop").waitForStart, false);
  assert.deepEqual(store.get("desktop").customWords, ["tmux"]);
  await assert.rejects(store.update("phone", { correctionThreshold: 2 }));
  assert.equal(store.get("phone").correctionThreshold, 0.18);
  await assert.rejects(store.update("nope", { autoSubmit: true }));
  const reloaded = new PrefsStore(kv);
  await reloaded.load();
  assert.equal(reloaded.get("phone").waitForStart, true);
  assert.deepEqual(reloaded.get("desktop").customWords, ["tmux"]);
});

test("custom words are trimmed and de-duplicated", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  const p = await store.update("desktop", { customWords: [" tmux ", "tmux", "", "CLAUDE.md"] });
  assert.deepEqual(p.customWords, ["tmux", "CLAUDE.md"]);
});

test("new devices get their kind's profile; tablets start from Phone", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  await store.update("phone", { floatingMic: false });
  const phone = await store.hello("p1", "Android phone", "phone", 1);
  const pc = await store.hello("d1", "Linux PC", "desktop", 2);
  const tab = await store.hello("t1", "Android tablet", "tablet", 3);
  assert.deepEqual([phone.profileId, pc.profileId, tab.profileId], ["phone", "desktop", "tablet"]);
  assert.equal(store.get("tablet").floatingMic, false);
  assert.equal(store.forDevice("p1").floatingMic, false);
  assert.equal(store.forDevice("unknown").floatingMic, true); // first profile (Desktop)
  const again = await store.hello("p1", "ignored", "phone", 9);
  assert.deepEqual([again.name, again.lastSeen], ["Android phone", 9]);
  assert.deepEqual(store.devices().map((d) => d.id), ["p1", "t1", "d1"]);
});

test("named profiles: create, assign, rename, delete", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  await store.hello("p1", "Android phone", "phone", 1);
  await store.hello("p2", "Work phone", "phone", 2);
  await store.update("phone", { waitForStart: true });
  const hf = await store.createProfile("Hands free", "phone");
  assert.equal(hf.id, "hands-free");
  assert.equal(store.get("hands-free").waitForStart, true);
  assert.equal((await store.createProfile("Hands free", "desktop")).id, "hands-free-2");
  await store.updateDevice("p2", { profileId: "hands-free", name: "Pixel" });
  assert.deepEqual(store.devices().find((d) => d.id === "p2"), { id: "p2", name: "Pixel", kind: "phone", profileId: "hands-free", lastSeen: 2 });
  await assert.rejects(store.updateDevice("p2", { profileId: "missing" }));
  await store.renameProfile("hands-free", "Car");
  assert.equal(store.profiles().find((p) => p.id === "hands-free")?.name, "Car");
  await store.deleteProfile("hands-free");
  assert.equal(store.devices().find((d) => d.id === "p2")?.profileId, "phone");
  await store.forgetDevice("p2");
  assert.equal(store.devices().some((d) => d.id === "p2"), false);
});

test("the last profile cannot be deleted", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  await store.deleteProfile("phone");
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
