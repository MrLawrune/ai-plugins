import { test } from "node:test";
import assert from "node:assert/strict";
import { LruMap, LruSet } from "./lru.ts";

test("LruMap evicts the least recently used", () => {
  const m = new LruMap<string, number>(2);
  m.set("a", 1); m.set("b", 2); m.get("a"); m.set("c", 3);
  assert.equal(m.has("b"), false); assert.equal(m.get("a"), 1); assert.equal(m.size, 2);
});
test("LruSet caps size", () => {
  const s = new LruSet<number>(3);
  for (let i = 0; i < 10; i++) s.add(i);
  assert.equal(s.size, 3); assert.equal(s.has(9), true); assert.equal(s.has(0), false);
});
test("LruMap set on an existing key refreshes it", () => {
  const m = new LruMap<string, number>(2);
  m.set("a", 1); m.set("b", 2); m.set("a", 10); m.set("c", 3);
  assert.equal(m.has("b"), false); assert.equal(m.get("a"), 10); assert.equal(m.delete("c"), true); assert.equal(m.size, 1);
});
