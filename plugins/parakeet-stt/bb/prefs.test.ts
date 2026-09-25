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

test("prefs saved before profiles seed the Desktop and Touch screen profiles", async () => {
  const store = new PrefsStore(memKv({ prefs: { autoSubmit: true, customWords: ["tmux"], shortcut: "alt+space" } }));
  await store.load();
  assert.deepEqual(store.profiles().map((p) => p.id), ["desktop", "touch"]);
  for (const id of ["desktop", "touch"]) {
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

test("the earlier Phone profile and phone/tablet devices become touch screen", async () => {
  const kv = memKv({ "profiles-v1": {
    shared: {},
    profiles: { desktop: { name: "Desktop", prefs: {} }, phone: { name: "Phone", prefs: { waitForStart: true } }, tablet: { name: "Tablet", prefs: {} } },
    devices: {
      p1: { id: "p1", name: "Android phone", kind: "phone", profileId: "phone", lastSeen: 1 },
      t1: { id: "t1", name: "Android tablet", kind: "tablet", profileId: "tablet", lastSeen: 2 },
    },
  } });
  const store = new PrefsStore(kv);
  await store.load();
  assert.deepEqual(store.profiles(), [{ id: "desktop", name: "Desktop" }, { id: "tablet", name: "Tablet" }, { id: "touch", name: "Touch screen" }]);
  assert.equal(store.get("touch").waitForStart, true);
  assert.deepEqual(store.devices().map((d) => [d.id, d.kind, d.profileId]), [["t1", "touch", "tablet"], ["p1", "touch", "touch"]]);
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
