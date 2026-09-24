import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceTail, tailRange } from "./draft-tail.ts";

test("partials replace the live tail; commit makes it solid", () => {
  let r = replaceTail("Fix the", "", "bug in");
  assert.deepEqual(r, { draft: "Fix the bug in", tail: " bug in" });
  r = replaceTail(r.draft, r.tail, "bug in parsing");
  assert.deepEqual(r, { draft: "Fix the bug in parsing", tail: " bug in parsing" });
  const committed = replaceTail(r.draft, r.tail, "bug in parsing.");
  assert.equal(committed.draft, "Fix the bug in parsing.");
});

test("empty text clears the tail", () => {
  assert.deepEqual(replaceTail("a b", " b", ""), { draft: "a", tail: "" });
});

test("tail re-anchors after user edits", () => {
  // user typed after the live tail appeared
  const r = replaceTail("Fix the bug in! (edited)", " bug in", "bug in parsing");
  assert.equal(r.draft, "Fix the bug in! (edited) bug in parsing");
});

test("empty draft gets no leading space; newline counts as whitespace", () => {
  assert.deepEqual(replaceTail("", "", "Hi"), { draft: "Hi", tail: "Hi" });
  assert.deepEqual(replaceTail("a\n", "", "Hi"), { draft: "a\nHi", tail: "Hi" });
});

test("tailRange covers the tail words only", () => {
  assert.deepEqual(tailRange("Fix the bug in", " bug in"), { from: 8, to: 14 });
  assert.equal(tailRange("Fix the", " bug"), null);
  assert.equal(tailRange("Fix", ""), null);
});
