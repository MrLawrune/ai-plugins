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

const empty: LiveState = { anchor: null, tail: "", dropSeq: null };

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

import { beginAt } from "./draft-tail.ts";

test("dictating at the caret inserts in the middle with spacing", () => {
  let b = beginAt("Fix the  bug", { start: 8, end: 8 }); // cursor between the two spaces
  let r = applyLive(b.draft, b.state, 0, "nasty", false);
  assert.equal(r.draft, "Fix the nasty bug");
  r = applyLive(r.draft, r.state, 0, "nasty.", true);
  assert.equal(r.draft, "Fix the nasty. bug");
  // next phrase continues right after the first
  r = applyLive(r.draft, r.state, 1, "Really", true);
  assert.equal(r.draft, "Fix the nasty. Really bug");
});

test("a selection is replaced by the dictation", () => {
  const b = beginAt("fix teh bug", { start: 4, end: 7 });
  assert.equal(b.draft, "fix  bug");
  const r = applyLive(b.draft, b.state, 0, "the", true);
  assert.equal(r.draft, "fix the bug");
});

test("caret glued to a word adds spaces on both sides", () => {
  const b = beginAt("abcdef", { start: 3, end: 3 });
  assert.equal(applyLive(b.draft, b.state, 0, "X", true).draft, "abc X def");
});

test("live tail in the middle is painted where it is", () => {
  const b = beginAt("one three", { start: 4, end: 4 });
  const r = applyLive(b.draft, b.state, 0, "two", false);
  assert.equal(r.draft, "one two three");
  assert.deepEqual(liveRange(r.draft, r.state), { from: 4, to: 7 });
});

test("no caret keeps the append-at-end behaviour", () => {
  const b = beginAt("Start.", null);
  assert.equal(applyLive(b.draft, b.state, 0, "Next.", true).draft, "Start. Next.");
});

test("user edits before the anchor while a tail is live: tail is found and replaced", () => {
  const b = beginAt("one three", { start: 4, end: 4 });
  let r = applyLive(b.draft, b.state, 0, "two", false);
  r = applyLive("ZERO one two three", r.state, 0, "two!", true); // user typed at the start
  assert.equal(r.draft, "ZERO one two! three");
});

import { liveRange } from "./draft-tail.ts";
