import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryStore } from "./history.ts";
import { memKv } from "./test-kv.ts";

test("keeps newest first and trims to limit", async () => {
  let t = 0, n = 0;
  const h = new HistoryStore(memKv(), () => 2, () => ++t, () => `id${++n}`);
  await h.add("a", 10); await h.add("b", 20); await h.add("c", 30);
  assert.deepEqual((await h.list()).map((e) => e.text), ["c", "b"]);
});

test("limit 0 stores nothing; blank text is skipped; clear empties", async () => {
  const h0 = new HistoryStore(memKv(), () => 0);
  await h0.add("a", 1);
  assert.deepEqual(await h0.list(), []);
  const h = new HistoryStore(memKv(), () => 5);
  await h.add("   ", 1);
  assert.deepEqual(await h.list(), []);
  await h.add("x", 1);
  await h.clear();
  assert.deepEqual(await h.list(), []);
});
