import { test } from "node:test";
import assert from "node:assert/strict";
import { excerpt } from "./excerpt.ts";
const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");

test("numbered lines within range", () => {
  assert.equal(excerpt(content, 3, 5, 10_000), "3 | line 3\n4 | line 4\n5 | line 5");
});
test("cuts at a line boundary and reports the remainder", () => {
  const out = excerpt(content, 1, 30, 40);
  assert.ok(out.endsWith("more lines)") && !out.includes("line 30"));
  assert.ok(Buffer.byteLength(out) <= 40 + 24);
});
