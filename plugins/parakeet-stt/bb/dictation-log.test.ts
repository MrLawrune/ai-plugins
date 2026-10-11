import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { DictationLog, type Limits } from "./dictation-log.ts";

function setup(limits: Limits = { maxEntries: 50, maxAgeDays: 7 }, now = { t: 1_800_000_000_000 }) {
  const db = new Database(":memory:");
  const log = new DictationLog({
    db: () => db,
    migrate: (d, stmts) => { for (const sql of stmts) d.exec(sql); },
    limits: () => limits,
    now: () => now.t,
  });
  log.init();
  return { log, db, limits, now };
}
const entry = (text: string, extra: Partial<{ durationMs: number; source: "oneshot" | "stream" | "voice"; deviceId: string | null }> = {}) =>
  ({ text, durationMs: 10, source: "oneshot" as const, deviceId: null, ...extra });
const count = (db: Database.Database) => (db.prepare("SELECT COUNT(*) AS n FROM dictation_log").get() as { n: number }).n;

test("add lists newest first with source, duration and timestamp", () => {
  const { log, now } = setup();
  log.add(entry("a", { durationMs: 5 }));
  now.t += 1000;
  log.add(entry("b", { source: "stream", deviceId: "d1" }));
  const rows = log.list();
  assert.deepEqual(rows.map((e) => e.text), ["b", "a"]);
  assert.deepEqual(rows.map((e) => e.source), ["stream", "oneshot"]);
  assert.equal(rows[1].durationMs, 5);
  assert.equal(rows[0].at, now.t);
  assert.equal(typeof rows[0].id, "number");
});

test("list honours its limit", () => {
  const { log } = setup();
  for (const t of ["a", "b", "c"]) log.add(entry(t));
  assert.deepEqual(log.list(2).map((e) => e.text), ["c", "b"]);
});

test("blank text is skipped", () => {
  const { log, db } = setup();
  log.add(entry("   \n"));
  assert.equal(count(db), 0);
});

test("maxEntries 0 records nothing", () => {
  const { log, db } = setup({ maxEntries: 0, maxAgeDays: 7 });
  log.add(entry("a"));
  assert.equal(count(db), 0);
});

test("count cap of 3 keeps the newest 3", () => {
  const { log } = setup({ maxEntries: 3, maxAgeDays: 7 });
  for (const t of ["a", "b", "c", "d", "e"]) log.add(entry(t));
  assert.deepEqual(log.list().map((e) => e.text), ["e", "d", "c"]);
});

test("prune drops rows older than maxAgeDays", () => {
  const { log, now } = setup();
  log.add(entry("old"));
  now.t += 8 * 86_400_000;
  log.add(entry("new"));
  log.prune();
  assert.deepEqual(log.list().map((e) => e.text), ["new"]);
});

test("a lowered maxEntries applies on the next prune", () => {
  const { log, limits } = setup();
  for (const t of ["a", "b", "c"]) log.add(entry(t));
  limits.maxEntries = 1;
  log.prune();
  assert.deepEqual(log.list().map((e) => e.text), ["c"]);
});

test("text is truncated to 4000 characters", () => {
  const { log } = setup();
  log.add(entry("x".repeat(5000)));
  assert.equal(log.list()[0].text.length, 4000);
});

test("clear empties the log", () => {
  const { log } = setup();
  log.add(entry("a"));
  log.clear();
  assert.deepEqual(log.list(), []);
});

test("importLegacy adds entries as oneshot at their own time, newest-first on read", () => {
  const { log } = setup({ maxEntries: 50, maxAgeDays: 7 }, { t: 1_800_000_000_000 });
  const t0 = 1_800_000_000_000;
  log.importLegacy([{ text: "newer", at: t0 - 1000, durationMs: 7 }, { text: "older", at: t0 - 5000, durationMs: 9 }, { text: " ", at: t0, durationMs: 1 }]);
  const rows = log.list();
  assert.deepEqual(rows.map((e) => [e.text, e.source, e.at, e.durationMs]), [
    ["newer", "oneshot", t0 - 1000, 7],
    ["older", "oneshot", t0 - 5000, 9],
  ]);
});

test("init is idempotent-safe: migrations run through the injected migrate", () => {
  const { log } = setup();
  assert.doesNotThrow(() => log.add(entry("a")));
});
