import { test } from "node:test";
import assert from "node:assert/strict";
import { age, bytes, pct } from "./format.ts";

test("bytes uses binary units with at most one decimal", () => {
  assert.deepEqual([bytes(0), bytes(512), bytes(1536), bytes(1024 ** 3), bytes(5.6 * 1024 ** 3), bytes(-1)], ["0 B", "512 B", "1.5 KiB", "1 GiB", "5.6 GiB", "0 B"]);
});

test("pct rounds and guards zero totals", () => {
  assert.deepEqual([pct(1, 3), pct(5, 0), pct(3, 2)], [33, 0, 100]);
});

test("age picks the largest sensible unit", () => {
  assert.deepEqual([age(42_000), age(3 * 60_000), age(3 * 3600_000), age(12 * 86400_000), age(-5)], ["42s", "3m", "3h", "12d", "0s"]);
});
