// Migration recovery: malformed rows keep what is valid; a failed settings write keeps the legacy values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_PENDING_KEY, MIGRATION_NOTE, MIGRATION_NOTE_FAILED_IMPORT, MIGRATION_NOTE_KEY, migrate } from "./migrate.ts";
import { PrefsStore } from "./prefs.ts";
import { memKv } from "./test-kv.ts";

const noLog = { importLegacy() {} };
const run = (kv: ReturnType<typeof memKv>, log: { importLegacy(e: never[]): void } = noLog) => migrate({ kv, log, warn: () => {} });
type Row = { shared: Record<string, unknown>; profiles: Record<string, { name: string; prefs: Record<string, unknown> }> };

test("shared settings survive when every profile name is malformed; the source row is then deleted", async () => {
  const kv = memKv({
    "profiles-v1": {
      shared: { customWords: ["tmux"], historyLimit: 0 },
      profiles: { main: { name: 7, prefs: { autoSubmit: true } }, "bad id!": { name: null, prefs: { pauseMs: 900 } }, broken: "x" },
    },
  });
  assert.equal((await run(kv)).migrated, true);
  const row = kv.data.settings as Row;
  assert.deepEqual(row.shared.customWords, ["tmux"]);
  assert.equal(row.shared.historyMaxEntries, 0);
  assert.deepEqual(Object.keys(row.profiles), ["main", "bad-id"]);
  assert.deepEqual([row.profiles.main.name, row.profiles["bad-id"].name], ["main", "bad-id"]);
  assert.equal(row.profiles.main.prefs.autoSubmit, true);
  assert.equal(row.profiles["bad-id"].prefs.pauseMs, 900);
  assert.deepEqual(kv.deleted, ["profiles-v1"]);
});

test("a profiles row with no usable profile keeps the valid shared fields and gets starter profiles", async () => {
  const kv = memKv({ "profiles-v1": { shared: { customWords: ["tmux"], historyLimit: 0 }, profiles: "x" } });
  await run(kv);
  const row = kv.data.settings as Row;
  assert.deepEqual(row.shared.customWords, ["tmux"]);
  assert.equal(row.shared.historyMaxEntries, 0);
  assert.deepEqual(Object.keys(row.profiles), ["desktop", "touch"]);
});

test("a malformed v2 row keeps its valid shared fields and profile preferences", async () => {
  const store = new PrefsStore(memKv({ settings: { v: 2, shared: { customWords: ["tmux"], historyMaxEntries: 0 }, profiles: { a: { name: 5, prefs: { autoSubmit: true } } } } }));
  await store.load();
  assert.deepEqual(store.profiles(), [{ id: "a", name: "a" }]);
  assert.deepEqual(store.get("a").customWords, ["tmux"]);
  assert.equal(store.get("a").historyMaxEntries, 0);
  assert.equal(store.get("a").autoSubmit, true);
});

test("a failed settings write returns the validated legacy state, keeps every old row and marks the history", async () => {
  const kv = memKv({ "profiles-v1": { shared: { customWords: ["tmux"], historyLimit: 0 }, profiles: { desktop: { name: "Desktop", prefs: {} } } }, history: [{ text: "x", at: 1, durationMs: 1 }] });
  const realSet = kv.set.bind(kv);
  let fail = true;
  kv.set = async (k, v) => { if (fail && k === "settings") throw new Error("disk full"); return realSet(k, v); };
  const result = await run(kv);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.recovered?.shared.customWords, ["tmux"]);
  assert.equal(result.recovered?.shared.historyMaxEntries, 0);
  assert.deepEqual(kv.deleted, []);
  assert.ok(kv.data.history && kv.data["profiles-v1"]);
  assert.ok(kv.data[HISTORY_PENDING_KEY]);
  // load → hello → reload keeps the recovered values.
  fail = false;
  const store = new PrefsStore(kv);
  await store.load(result.recovered);
  await store.hello("d1", "Laptop", "desktop", 1000);
  const reloaded = new PrefsStore(kv);
  await reloaded.load();
  assert.deepEqual(reloaded.get().customWords, ["tmux"]);
  assert.equal(reloaded.get().historyMaxEntries, 0);
});

test("a successful history-import retry replaces the failure note with the success note, unless it was dismissed", async () => {
  const history = [{ text: "x", at: 1, durationMs: 1 }];
  const kv = memKv({ settings: { v: 2 }, [HISTORY_PENDING_KEY]: true, history, [MIGRATION_NOTE_KEY]: MIGRATION_NOTE_FAILED_IMPORT });
  await run(kv);
  assert.equal(kv.data[MIGRATION_NOTE_KEY], MIGRATION_NOTE);
  const dismissed = memKv({ settings: { v: 2 }, [HISTORY_PENDING_KEY]: true, history });
  await run(dismissed);
  assert.equal(dismissed.data[MIGRATION_NOTE_KEY], undefined);
});

function failingWrite() {
  const kv = memKv({
    "profiles-v1": { shared: { customWords: ["tmux"], historyLimit: 7 }, profiles: { desktop: { name: "Desktop", prefs: {} } } },
    prefs: { autoSubmit: true },
    history: [{ text: "x", at: 1, durationMs: 1 }],
  });
  const realSet = kv.set.bind(kv);
  const control = { fail: true };
  kv.set = async (k, v) => { if (control.fail && k === "settings") throw new Error("disk full"); return realSet(k, v); };
  return { kv, control };
}

test("the first successful write of a recovered state deletes the legacy rows, never before the settings row exists", async () => {
  const { kv, control } = failingWrite();
  const result = await migrate({ kv, log: noLog, warn: () => {} });
  const store = new PrefsStore(kv);
  await store.load(result.recovered, result.cleanup);
  // a write that fails leaves everything in place
  await assert.rejects(store.hello("d1", "Laptop", "desktop", 1000));
  assert.deepEqual(kv.deleted, []);
  control.fail = false;
  await store.hello("d1", "Laptop", "desktop", 1000);
  assert.deepEqual([...kv.deleted].sort(), ["prefs", "profiles-v1"]);
  assert.deepEqual((kv.data.settings as Row).shared.customWords, ["tmux"]);
  assert.equal((kv.data.settings as Row).shared.historyMaxEntries, 7);
  assert.ok(kv.data.history && kv.data[HISTORY_PENDING_KEY], "the history row stays for its retry");
  await store.hello("d2", "Phone", "touch", 2000);
  assert.equal(kv.deleted.length, 2, "cleanup runs once");
});

test("a failing delete of a legacy row is reported and does not fail the write", async () => {
  const { kv, control } = failingWrite();
  const warnings: string[] = [];
  const result = await migrate({ kv, log: noLog, warn: (m) => warnings.push(m) });
  control.fail = false;
  kv.delete = async () => { throw new Error("locked"); };
  const store = new PrefsStore(kv);
  await store.load(result.recovered, result.cleanup);
  await assert.doesNotReject(store.hello("d1", "Laptop", "desktop", 1000));
  assert.equal((kv.data.settings as Row).shared.historyMaxEntries, 7);
  assert.ok(warnings.some((w) => w.includes("locked")), warnings.join("|"));
});
