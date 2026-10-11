import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { DictationLog } from "./dictation-log.ts";
import { HISTORY_PENDING_KEY, MIGRATION_NOTE, MIGRATION_NOTE_FAILED_IMPORT, MIGRATION_NOTE_KEY, migrate } from "./migrate.ts";
import { DEFAULT_PREFS, PrefsStore } from "./prefs.ts";
import { memKv } from "./test-kv.ts";

type Legacy = { text: string; at: number; durationMs: number };

function fakeLog() {
  const imported: Legacy[][] = [];
  return { imported, importLegacy(e: Legacy[]) { imported.push(e); } };
}
const setup = (initial: Record<string, unknown>) => {
  const kv = memKv(initial);
  const log = fakeLog();
  const warnings: string[] = [];
  return { kv, log, warnings, run: () => migrate({ kv, log, warn: (m) => warnings.push(m) }) };
};

/** The shape 0.1.0 stored: `historyLimit` in shared, a Phone profile, devices of kind phone. */
const legacyRow = () => ({
  shared: { ...DEFAULT_PREFS, historyMaxEntries: undefined, historyMaxAgeDays: undefined, historyLimit: 12, customWords: ["tmux"], sendPhrase: "ship it" },
  profiles: {
    desktop: { name: "Desktop", prefs: { autoSubmit: true, shortcut: "alt+space" } },
    phone: { name: "Phone", prefs: { floatingMic: false, pauseMs: 900 } },
    work: { name: "Work", prefs: { holdToTalk: true } },
  },
  devices: {
    d1: { id: "d1", name: "Laptop", kind: "desktop", profileId: "desktop", lastSeen: 50 },
    p1: { id: "p1", name: "Pixel", kind: "phone", profileId: "phone", lastSeen: 90 },
    t1: { id: "t1", name: "Tab", kind: "tablet", profileId: "work", lastSeen: 70 },
  },
});

test("a real profiles-v1 row becomes the settings row, old rows go, the note is set", async () => {
  const { kv, run } = setup({ "profiles-v1": legacyRow(), prefs: { autoSubmit: false }, history: [] });
  assert.deepEqual(await run(), { migrated: true, note: MIGRATION_NOTE });
  assert.equal(MIGRATION_NOTE, "Settings moved to the new layout. History now keeps 7 days.");
  assert.deepEqual(kv.deleted.sort(), ["history", "prefs", "profiles-v1"]);
  assert.equal(kv.data[HISTORY_PENDING_KEY], undefined);
  assert.equal(kv.data[MIGRATION_NOTE_KEY], MIGRATION_NOTE);
  assert.equal(MIGRATION_NOTE_KEY, "migration-note");
  const row = kv.data.settings as { v: number; shared: Record<string, unknown>; profiles: Record<string, { name: string; prefs: Record<string, unknown> }>; devices: Record<string, { kind: string; profileId: string }> };
  assert.equal(row.v, 2);
  assert.equal(row.shared.historyMaxEntries, 12);
  assert.equal(row.shared.historyMaxAgeDays, 7);
  assert.equal("historyLimit" in row.shared, false);
  assert.deepEqual(row.shared.customWords, ["tmux"]);
  assert.equal(row.shared.sendPhrase, "ship it");
  // Phone profile is the touch profile; its devices follow; unrenamed "Phone" becomes "Touch screen".
  assert.deepEqual(Object.keys(row.profiles), ["desktop", "work", "touch"]);
  assert.equal(row.profiles.touch.name, "Touch screen");
  assert.equal(row.profiles.touch.prefs.floatingMic, false);
  assert.equal(row.profiles.touch.prefs.pauseMs, 900);
  assert.equal(row.profiles.desktop.prefs.autoSubmit, true);
  assert.equal(row.profiles.desktop.prefs.shortcut, "alt+space");
  assert.equal(row.profiles.work.prefs.holdToTalk, true);
  assert.deepEqual([row.devices.p1.kind, row.devices.p1.profileId], ["touch", "touch"]);
  assert.deepEqual([row.devices.t1.kind, row.devices.t1.profileId], ["touch", "work"]);
  assert.equal(row.devices.d1.profileId, "desktop");
  assert.equal(kv.writes, 2); // settings + note
});

test("the migrated row loads in PrefsStore with what 0.1.0 showed", async () => {
  const { kv, run } = setup({ "profiles-v1": legacyRow() });
  await run();
  const store = new PrefsStore(kv);
  await store.load();
  assert.deepEqual(store.profiles().map((p) => p.id), ["desktop", "work", "touch"]);
  assert.deepEqual(store.devices().map((d) => d.id), ["p1", "t1", "d1"]);
  const phone = store.forDevice("p1");
  assert.equal(phone.floatingMic, false);
  assert.equal(phone.historyMaxEntries, 12);
  assert.deepEqual(phone.customWords, ["tmux"]);
  assert.equal(store.forDevice("d1").autoSubmit, true);
});

test("a profiles-v1 row that already has a touch profile keeps both", async () => {
  const row = legacyRow();
  Object.assign(row.profiles, { touch: { name: "Mine", prefs: {} } });
  const { kv, run } = setup({ "profiles-v1": row });
  await run();
  const out = kv.data.settings as { profiles: Record<string, { name: string }>; devices: Record<string, { profileId: string }> };
  assert.deepEqual(Object.keys(out.profiles), ["desktop", "phone", "work", "touch"]);
  assert.equal(out.profiles.touch.name, "Mine");
  assert.equal(out.devices.p1.profileId, "phone");
});

test("a renamed phone profile keeps its name", async () => {
  const row = legacyRow();
  row.profiles.phone.name = "Pocket";
  const { kv, run } = setup({ "profiles-v1": row });
  await run();
  assert.equal((kv.data.settings as { profiles: Record<string, { name: string }> }).profiles.touch.name, "Pocket");
});

test("only the legacy prefs row seeds both starter profiles", async () => {
  const { kv, run } = setup({ prefs: { ...DEFAULT_PREFS, historyLimit: 3, autoSubmit: true, customWords: ["a"] } });
  assert.deepEqual(await run(), { migrated: true, note: MIGRATION_NOTE });
  const row = kv.data.settings as { shared: Record<string, unknown>; profiles: Record<string, { name: string; prefs: Record<string, unknown> }>; devices: object };
  assert.deepEqual(Object.keys(row.profiles), ["desktop", "touch"]);
  assert.deepEqual([row.profiles.desktop.name, row.profiles.touch.name], ["Desktop", "Touch screen"]);
  assert.equal(row.profiles.desktop.prefs.autoSubmit, true);
  assert.equal(row.profiles.touch.prefs.autoSubmit, true);
  assert.equal(row.shared.historyMaxEntries, 3);
  assert.deepEqual(row.shared.customWords, ["a"]);
  assert.deepEqual(row.devices, {});
  assert.deepEqual(kv.deleted.sort(), ["prefs"]);
});

test("historyLimit 0 stays 0 and imports nothing", async () => {
  const { kv, log, run } = setup({
    "profiles-v1": { ...legacyRow(), shared: { historyLimit: 0 } },
    history: [{ id: "a", text: "x", at: 1, durationMs: 1 }],
  });
  await run();
  assert.equal((kv.data.settings as { shared: { historyMaxEntries: number } }).shared.historyMaxEntries, 0);
  assert.deepEqual(log.imported.flat(), []);
  assert.ok(kv.deleted.includes("history"));
});

test("nothing stored: no write, no note", async () => {
  const { kv, log, run } = setup({});
  assert.deepEqual(await run(), { migrated: false, note: null });
  assert.equal(kv.writes, 0);
  assert.deepEqual(kv.deleted, []);
  assert.deepEqual(log.imported, []);
});

test("a malformed profiles-v1 row falls back to defaults (or the legacy prefs) without throwing", async () => {
  const bad = { profiles: "x", shared: 42, devices: [] };
  const a = setup({ "profiles-v1": bad });
  assert.equal((await a.run()).migrated, true);
  const row = a.kv.data.settings as { shared: Record<string, unknown>; profiles: Record<string, unknown>; devices: object };
  assert.deepEqual(Object.keys(row.profiles), ["desktop", "touch"]);
  assert.equal(row.shared.historyMaxEntries, DEFAULT_PREFS.historyMaxEntries);
  assert.deepEqual(row.devices, {});

  // 0.1.0 used the legacy prefs row when profiles-v1 held no profiles.
  const b = setup({ "profiles-v1": bad, prefs: { autoSubmit: true } });
  await b.run();
  assert.equal((b.kv.data.settings as { profiles: Record<string, { prefs: { autoSubmit: boolean } }> }).profiles.touch.prefs.autoSubmit, true);

  for (const junk of ["junk", 7, [], null]) {
    const c = setup({ "profiles-v1": junk, prefs: junk });
    assert.deepEqual(await c.run(), { migrated: false, note: null });
  }
});

test("invalid fields fall back one by one; the valid ones survive", async () => {
  const { kv, run } = setup({
    "profiles-v1": {
      shared: { historyLimit: 99, customWords: "nope", sendPhrase: "go", correctionThreshold: 9, bogus: 1 },
      profiles: {
        desktop: { name: "Desktop", prefs: { autoSubmit: true, pauseMs: 5 } },
        "bad id!": { name: "X", prefs: {} },
        nameless: { prefs: { holdToTalk: true } },
        broken: "x",
      },
      devices: {
        ok: { id: "ok", name: "A", kind: "desktop", profileId: "desktop", lastSeen: 1 },
        worse: 5,
        noId: { name: "X", kind: "desktop", profileId: "desktop", lastSeen: 1 },
      },
    },
  });
  await run();
  const row = kv.data.settings as { shared: Record<string, unknown>; profiles: Record<string, { prefs: Record<string, unknown> }>; devices: Record<string, unknown> };
  assert.equal(row.shared.historyMaxEntries, DEFAULT_PREFS.historyMaxEntries);
  assert.deepEqual(row.shared.customWords, []);
  assert.equal(row.shared.sendPhrase, "go");
  assert.equal(row.shared.correctionThreshold, DEFAULT_PREFS.correctionThreshold);
  assert.equal("bogus" in row.shared, false);
  // Unusable metadata is repaired per profile (id slug, name from the id); a non-object entry is skipped.
  assert.deepEqual(Object.keys(row.profiles), ["desktop", "bad-id", "nameless"]);
  assert.equal(row.profiles.nameless.prefs.holdToTalk, true);
  assert.equal(row.profiles.desktop.prefs.autoSubmit, true);
  assert.equal(row.profiles.desktop.prefs.pauseMs, DEFAULT_PREFS.pauseMs);
  assert.deepEqual(Object.keys(row.devices), ["ok"]);
});

test("malformed history entries are skipped, the rest imported newest first within the limit", async () => {
  const { kv, log, run } = setup({
    "profiles-v1": { ...legacyRow(), shared: { historyLimit: 3 } },
    history: [
      { id: "1", text: "newest", at: 400, durationMs: 5 },
      { id: "2", text: 7, at: 300, durationMs: 5 },
      "junk",
      null,
      { id: "3", text: "no time", durationMs: 5 },
      { id: "4", text: "second", at: 200, durationMs: 6 },
      { id: "5", text: "third", at: 100, durationMs: 7 },
      { id: "6", text: "over the limit", at: 50, durationMs: 8 },
    ],
  });
  await run();
  assert.deepEqual(log.imported, [[
    { text: "newest", at: 400, durationMs: 5 },
    { text: "second", at: 200, durationMs: 6 },
    { text: "third", at: 100, durationMs: 7 },
  ]]);
  assert.ok(kv.deleted.includes("history"));
});

test("a history row that is not an array imports nothing", async () => {
  const { log, run } = setup({ "profiles-v1": legacyRow(), history: "junk" });
  assert.equal((await run()).migrated, true);
  assert.deepEqual(log.imported.flat(), []);
});

test("imported history lands in the real log at its own times", async () => {
  const db = new Database(":memory:");
  const log = new DictationLog({
    db: () => db,
    migrate: (d, s) => { for (const sql of s) d.exec(sql); },
    limits: () => ({ maxEntries: 50, maxAgeDays: 90 }),
    now: () => 1_000_000,
  });
  log.init();
  const kv = memKv({ "profiles-v1": legacyRow(), history: [{ id: "a", text: "newer", at: 900_000, durationMs: 1 }, { id: "b", text: "older", at: 800_000, durationMs: 2 }] });
  await migrate({ kv, log, warn: () => {} });
  assert.deepEqual(log.list().map((e) => [e.text, e.at, e.source]), [["newer", 900_000, "oneshot"], ["older", 800_000, "oneshot"]]);
});

test("a settings row already present: nothing runs, nothing is deleted", async () => {
  const { kv, log, run } = setup({ settings: { v: 2 }, "profiles-v1": legacyRow(), prefs: {}, history: [{ id: "a", text: "x", at: 1, durationMs: 1 }] });
  assert.deepEqual(await run(), { migrated: false, note: null });
  assert.equal(kv.writes, 0);
  assert.deepEqual(kv.deleted, []);
  assert.deepEqual(log.imported, []);
  assert.ok(kv.data["profiles-v1"] && kv.data.prefs && kv.data.history);
});

test("a failing settings write leaves every old row, reports it and hands back the recovered state", async () => {
  const base = memKv({ "profiles-v1": legacyRow(), prefs: { autoSubmit: true }, history: [{ id: "a", text: "x", at: 1, durationMs: 1 }] });
  const kv = Object.assign(base, { async set() { throw new Error("disk full"); } });
  const log = fakeLog();
  const warnings: string[] = [];
  const result = await migrate({ kv, log, warn: (m) => warnings.push(m) });
  assert.deepEqual([result.migrated, result.note], [false, null]);
  assert.deepEqual(result.recovered?.shared.customWords, ["tmux"]);
  assert.deepEqual(base.deleted, []);
  assert.deepEqual(log.imported, []);
  assert.ok(base.data["profiles-v1"] && base.data.prefs && base.data.history);
  assert.equal(base.data.settings, undefined);
  assert.ok(warnings.some((w) => w.includes("disk full")), warnings.join("|"));
});

test("a failing kv read never rethrows", async () => {
  const kv = Object.assign(memKv(), { async get() { throw new Error("kv down"); } });
  const warnings: string[] = [];
  assert.deepEqual(await migrate({ kv, log: fakeLog(), warn: (m) => warnings.push(m) }), { migrated: false, note: null });
  assert.equal(warnings.length, 1);
});

test("a failing history import keeps the history row, marks it pending and says so in the note", async () => {
  const kv = memKv({ "profiles-v1": legacyRow(), prefs: {}, history: [{ id: "a", text: "x", at: 1, durationMs: 1 }] });
  const warnings: string[] = [];
  const log = { importLegacy() { throw new Error("db locked"); } };
  const result = await migrate({ kv, log, warn: (m) => warnings.push(m) });
  assert.deepEqual(result, { migrated: true, note: MIGRATION_NOTE_FAILED_IMPORT });
  assert.ok(MIGRATION_NOTE_FAILED_IMPORT.startsWith(MIGRATION_NOTE));
  assert.equal(kv.data[MIGRATION_NOTE_KEY], MIGRATION_NOTE_FAILED_IMPORT);
  assert.deepEqual(kv.deleted.sort(), ["prefs", "profiles-v1"]);
  assert.ok(kv.data.history);
  assert.ok(kv.data[HISTORY_PENDING_KEY]);
  assert.equal(HISTORY_PENDING_KEY, "history-import-pending");
  assert.ok(warnings.some((w) => w.includes("db locked")));
});

test("a pending history import is retried on the next load and cleans up", async () => {
  const history = [{ id: "a", text: "one", at: 20, durationMs: 1 }, "junk", { id: "b", text: "two", at: 10, durationMs: 2 }];
  const { kv, log, run } = setup({ "profiles-v1": legacyRow(), history });
  const first = { importLegacy() { throw new Error("db locked"); } };
  await migrate({ kv, log: first, warn: () => {} });
  assert.ok(kv.data[HISTORY_PENDING_KEY]);
  kv.deleted.length = 0;
  assert.deepEqual(await run(), { migrated: false, note: null });
  assert.deepEqual(log.imported, [[{ text: "one", at: 20, durationMs: 1 }, { text: "two", at: 10, durationMs: 2 }]]);
  assert.deepEqual(kv.deleted.sort(), ["history", HISTORY_PENDING_KEY]);
  assert.equal(kv.data.history, undefined);
  // Third load: nothing left to do.
  log.imported.length = 0;
  await run();
  assert.deepEqual(log.imported, []);
});

test("the retry respects the stored history limit", async () => {
  const kv = memKv({ settings: { v: 2, shared: { historyMaxEntries: 1 }, profiles: {} }, [HISTORY_PENDING_KEY]: true, history: [{ text: "a", at: 2, durationMs: 1 }, { text: "b", at: 1, durationMs: 1 }] });
  const log = fakeLog();
  await migrate({ kv, log, warn: () => {} });
  assert.deepEqual(log.imported, [[{ text: "a", at: 2, durationMs: 1 }]]);
});

test("a retry that fails again warns, keeps both rows and does not throw", async () => {
  const kv = memKv({ settings: { v: 2 }, [HISTORY_PENDING_KEY]: true, history: [{ id: "a", text: "x", at: 1, durationMs: 1 }] });
  const warnings: string[] = [];
  const result = await migrate({ kv, log: { importLegacy() { throw new Error("still locked"); } }, warn: (m) => warnings.push(m) });
  assert.deepEqual(result, { migrated: false, note: null });
  assert.deepEqual(kv.deleted, []);
  assert.ok(kv.data.history && kv.data[HISTORY_PENDING_KEY]);
  assert.ok(warnings.some((w) => w.includes("still locked")));
});

test("a marker without a settings-time history row just clears itself", async () => {
  const kv = memKv({ settings: { v: 2 }, [HISTORY_PENDING_KEY]: true });
  assert.deepEqual(await migrate({ kv, log: fakeLog(), warn: () => {} }), { migrated: false, note: null });
  assert.deepEqual(kv.deleted, [HISTORY_PENDING_KEY]);
});

test("a history-only install migrates with default settings", async () => {
  const { kv, log, run } = setup({ history: [{ id: "a", text: "x", at: 5, durationMs: 1 }, "junk"] });
  assert.deepEqual(await run(), { migrated: true, note: MIGRATION_NOTE });
  const row = kv.data.settings as { v: number; shared: Record<string, unknown>; profiles: Record<string, unknown> };
  assert.equal(row.v, 2);
  assert.deepEqual(Object.keys(row.profiles), ["desktop", "touch"]);
  assert.equal(row.shared.historyMaxEntries, DEFAULT_PREFS.historyMaxEntries);
  assert.deepEqual(log.imported, [[{ text: "x", at: 5, durationMs: 1 }]]);
  assert.deepEqual(kv.deleted, ["history"]);
  assert.equal(kv.data[MIGRATION_NOTE_KEY], MIGRATION_NOTE);
});

test("devices parse like 0.1.0: odd kinds and names are coerced, only an unusable id drops one", async () => {
  const { kv, run } = setup({
    "profiles-v1": {
      shared: {},
      profiles: { desktop: { name: "Desktop", prefs: {} } },
      devices: {
        a: { id: "a", name: "", kind: "toaster", profileId: "desktop", lastSeen: 3 },
        b: { id: "b", name: "Pad", kind: "tablet", profileId: "desktop", lastSeen: 2 },
        c: { id: "c", name: "Odd", kind: "phone", profileId: "not valid!", lastSeen: "x" },
        "bad id!": { id: "bad id!", name: "N", kind: "desktop", profileId: "desktop", lastSeen: 1 },
        d: { name: "No id", kind: "desktop", profileId: "desktop", lastSeen: 1 },
      },
    },
  });
  await run();
  const devices = (kv.data.settings as { devices: Record<string, Record<string, unknown>> }).devices;
  assert.deepEqual(Object.keys(devices).sort(), ["a", "b", "c"]);
  assert.deepEqual([devices.a.name, devices.a.kind], ["Device", "desktop"]);
  assert.equal(devices.b.kind, "touch");
  assert.deepEqual([devices.c.kind, devices.c.profileId, devices.c.lastSeen], ["touch", "touch", 0]);
});

test("each old row is deleted independently", async () => {
  const kv = memKv({ "profiles-v1": legacyRow(), prefs: {}, history: [] });
  const failing = Object.assign(kv, {
    async delete(k: string) { kv.deleted.push(k); if (k === "profiles-v1") throw new Error("nope"); delete kv.data[k]; },
  });
  const warnings: string[] = [];
  const result = await migrate({ kv: failing, log: fakeLog(), warn: (m) => warnings.push(m) });
  assert.equal(result.migrated, true);
  assert.deepEqual(kv.deleted.sort(), ["history", "prefs", "profiles-v1"]);
  assert.equal(kv.data.prefs, undefined);
  assert.equal(kv.data.history, undefined);
  assert.equal(warnings.length, 1);
  assert.equal(kv.data[MIGRATION_NOTE_KEY], MIGRATION_NOTE);
});
