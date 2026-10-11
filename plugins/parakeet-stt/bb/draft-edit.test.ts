import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTextEdit } from "./draft-edit.ts";

test("append with no mentions", () => {
  const cur = { text: "fix", mentions: [] as { from: number; to: number }[] };
  assert.deepEqual(applyTextEdit(cur, "fix hello"), { text: "fix hello", mentions: [] });
});

test("append after a leading mention leaves it unchanged", () => {
  const cur = { text: "@Alex please", mentions: [{ from: 0, to: 5 }] };
  assert.deepEqual(applyTextEdit(cur, "@Alex please now"), {
    text: "@Alex please now",
    mentions: [{ from: 0, to: 5 }],
  });
});

test("insertion before a mention shifts it", () => {
  const cur = { text: "hello and @Alex", mentions: [{ from: 10, to: 15 }] };
  assert.deepEqual(applyTextEdit(cur, "hello there and @Alex"), {
    text: "hello there and @Alex",
    mentions: [{ from: 16, to: 21 }],
  });
});

test("insertion exactly at a mention's start shifts it", () => {
  const cur = { text: "hi @Alex", mentions: [{ from: 3, to: 8 }] };
  assert.deepEqual(applyTextEdit(cur, "hi there @Alex"), {
    text: "hi there @Alex",
    mentions: [{ from: 9, to: 14 }],
  });
});

test("insertion exactly at a mention's end leaves it unchanged", () => {
  const cur = { text: "hi @Alex", mentions: [{ from: 3, to: 8 }] };
  assert.deepEqual(applyTextEdit(cur, "hi @Alex there"), {
    text: "hi @Alex there",
    mentions: [{ from: 3, to: 8 }],
  });
});

test("replacing text that overlaps a mention returns null", () => {
  const cur = { text: "hello @Alex", mentions: [{ from: 6, to: 11 }] };
  assert.equal(applyTextEdit(cur, "hello @Alan"), null);
  assert.equal(applyTextEdit(cur, "hello"), null);
});

test("identical text returns the same object", () => {
  const cur = { text: "hi @Alex", mentions: [{ from: 3, to: 8 }] };
  assert.equal(applyTextEdit(cur, "hi @Alex"), cur);
});

test("extra mention fields survive shifting", () => {
  const m = { from: 10, to: 15, kind: "user", label: "Alex", provider: "people" };
  const cur = { text: "hello and @Alex", mentions: [m] };
  assert.deepEqual(applyTextEdit(cur, "hello there and @Alex")?.mentions, [
    { from: 16, to: 21, kind: "user", label: "Alex", provider: "people" },
  ]);
});
