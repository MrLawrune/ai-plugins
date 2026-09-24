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

test("load keeps valid stored prefs and drops invalid ones", async () => {
  const store = new PrefsStore(memKv({ prefs: { autoSubmit: true, customWords: ["tmux"] } }));
  const p = await store.load();
  assert.equal(p.autoSubmit, true);
  assert.deepEqual(p.customWords, ["tmux"]);
  const bad = new PrefsStore(memKv({ prefs: { shortcut: "f13" } }));
  assert.deepEqual(await bad.load(), DEFAULT_PREFS);
});

test("update validates, persists, notifies", async () => {
  const kv = memKv();
  const store = new PrefsStore(kv);
  await store.load();
  const seen: boolean[] = [];
  store.onChange((n) => seen.push(n.autoSubmit));
  await store.update({ autoSubmit: true });
  assert.deepEqual(seen, [true]);
  assert.equal((kv.data.prefs as { autoSubmit: boolean }).autoSubmit, true);
  await assert.rejects(store.update({ correctionThreshold: 2 }));
  assert.equal(store.get().correctionThreshold, 0.18);
});

test("custom words are trimmed and de-duplicated", async () => {
  const store = new PrefsStore(memKv());
  await store.load();
  const p = await store.update({ customWords: [" tmux ", "tmux", "", "CLAUDE.md"] });
  assert.deepEqual(p.customWords, ["tmux", "CLAUDE.md"]);
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

test("prefs saved before streaming existed load with streaming defaults", async () => {
  const store = new PrefsStore(memKv({ prefs: { shortcut: "alt+space", customWords: ["tmux"] } }));
  const p = await store.load();
  assert.equal(p.shortcut, "alt+space");
  assert.equal(p.mode, "continuous");
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
