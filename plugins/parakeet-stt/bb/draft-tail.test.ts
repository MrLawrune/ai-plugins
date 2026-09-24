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

import { applyLive, type LiveState } from "./draft-tail.ts";

const empty: LiveState = { tail: "", dropSeq: null };

test("partial then final for one phrase", () => {
  let s = empty;
  let r = applyLive("Fix", s, 0, "the bug", false);
  assert.equal(r.draft, "Fix the bug"); s = r.state;
  r = applyLive(r.draft, s, 0, "the bug.", true);
  assert.equal(r.draft, "Fix the bug.");
  assert.deepEqual(r.state, empty);
});

test("sent while grey: the rest of that phrase is dropped, next phrase is kept", () => {
  let r = applyLive("", empty, 3, "hello wor", false);
  assert.equal(r.draft, "hello wor");
  // user pressed send: bb cleared the composer
  r = applyLive("", r.state, 3, "hello world and", false);
  assert.equal(r.draft, "");
  r = applyLive("", r.state, 3, "Hello world and more.", true);
  assert.equal(r.draft, "", "final of the sent phrase must not land in the new message");
  r = applyLive("", r.state, 4, "Next thought", false);
  assert.equal(r.draft, "Next thought");
});

test("cleared while grey with only the final pending: final dropped", () => {
  let r = applyLive("", empty, 0, "draft words", false);
  r = applyLive("", r.state, 0, "Draft words.", true);
  assert.equal(r.draft, "");
  assert.deepEqual(r.state, empty);
});

test("edited (not emptied) while grey: tail re-anchors after the edits", () => {
  let r = applyLive("A", empty, 0, "b", false);
  r = applyLive("A b plus typing", r.state, 0, "b c", false);
  assert.equal(r.draft, "A b plus typing b c");
});
