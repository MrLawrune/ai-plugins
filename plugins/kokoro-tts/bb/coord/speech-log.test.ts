import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SpeechLogStore } from "./speech-log.ts";

function store(limits = { maxAgeDays: 7, maxEntries: 100 }, now = { t: 1_800_000_000_000 }) {
  const db = new Database(":memory:");
  const s = new SpeechLogStore({
    db: () => db,
    migrate: (d, stmts) => { for (const sql of stmts) d.exec(sql); },
    limits: () => limits,
    now: () => now.t,
  });
  s.init();
  return { s, db, now, limits };
}

test("add normalizes text and lists oldest first per thread", () => {
  const { s } = store();
  s.add("  a \n b ", "t1", "bm_george"); s.add("c", "t2", null); s.add("d", "t1", null);
  assert.deepEqual(s.list("t1").map((e) => e.text), ["a b", "d"]);
  assert.equal(s.list("t1")[0].voice, "bm_george");
});
test("maxEntries is enforced on insert", () => {
  const { s } = store({ maxAgeDays: 7, maxEntries: 100 });
  for (let i = 0; i < 130; i++) s.add(`x${i}`, "t", null);
  assert.equal(s.count(), 100);
});
test("prune drops rows older than maxAgeDays", () => {
  const { s, now } = store();
  s.add("old", "t", null); now.t += 8 * 86_400_000; s.add("new", "t", null);
  assert.equal(s.prune(), 1); assert.deepEqual(s.list("t").map((e) => e.text), ["new"]);
});
test("lowered limits apply on the next prune", () => {
  const { s, limits } = store({ maxAgeDays: 7, maxEntries: 1000 });
  for (let i = 0; i < 300; i++) s.add(`x${i}`, "t", null);
  limits.maxEntries = 100; s.prune(); assert.equal(s.count(), 100);
});
test("setStatus never recreates a deleted row", () => {
  const { s } = store();
  const e = s.add("a", "t", null); s.deleteThread("t"); s.setStatus(e.id, "done");
  assert.equal(s.count(), 0);
});
test("ids are not reused after clear", () => {
  const { s } = store();
  const a = s.add("a", "t", null); s.clear(); const b = s.add("b", "t", null);
  assert.ok(b.id > a.id);
});
test("reconcile marks orphaned queued and playing rows older than 20 minutes interrupted", () => {
  const { s, now } = store();
  const a = s.add("a", "t", null); s.setStatus(a.id, "playing");
  s.add("b", "t", null);
  now.t += 20 * 60_000 - 1_000;
  assert.equal(s.reconcile([]), 0, "a long full-mode reply or a held one may still be live");
  now.t += 2_000;
  assert.equal(s.reconcile([]), 2);
  assert.deepEqual(s.list("t").map((e) => e.status), ["interrupted", "interrupted"]);
});
test("reconcile leaves rows the hub still holds, however old", () => {
  const { s, now } = store();
  const held = s.add("held", "t", null);
  const playing = s.add("playing", "t", null); s.setStatus(playing.id, "playing");
  const orphan = s.add("orphan", "t", null);
  now.t += 60 * 60_000;
  assert.equal(s.reconcile([held.id, playing.id]), 1);
  assert.deepEqual(s.list("t").map((e) => [e.id, e.status]), [[held.id, "queued"], [playing.id, "playing"], [orphan.id, "interrupted"]]);
});
test("init reconciles with the same 20-minute rule", () => {
  const db = new Database(":memory:");
  const now = { t: 1_800_000_000_000 };
  let migrated = false;
  const make = () => new SpeechLogStore({
    db: () => db,
    migrate: (d, stmts) => { if (!migrated) for (const sql of stmts) d.exec(sql); migrated = true; },
    limits: () => ({ maxAgeDays: 7, maxEntries: 100 }),
    now: () => now.t,
  });
  const first = make();
  first.init();
  const recent = first.add("recent", "t", null);
  now.t += 5 * 60_000; // a reload 5 minutes later: the old load may still be playing it
  make().init();
  assert.equal(first.list("t").find((e) => e.id === recent.id)?.status, "queued");
  now.t += 20 * 60_000;
  make().init();
  assert.equal(first.list("t").find((e) => e.id === recent.id)?.status, "interrupted");
  db.close();
});
test("error is cut to 200 chars and engine recorded", () => {
  const { s } = store();
  const a = s.add("a", "t", null); s.setStatus(a.id, "error", { error: "e".repeat(500), engine: "http://x" });
  const row = s.list("t")[0]; assert.equal(row.error!.length, 200); assert.equal(row.engine, "http://x");
});
test("latency is the median of recent done rows", () => {
  const { s } = store();
  for (const ms of [100, 300, 200]) { const e = s.add("a", "t", null); s.setStatus(e.id, "done", { first_audio_ms: ms }); }
  assert.deepEqual(s.latency(), { median_ms: 200, samples: 3 });
});
