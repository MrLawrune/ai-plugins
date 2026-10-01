import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeLogText, sentenceChunks, stripMarkdown } from "./speakable.ts";

const load = (n: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));

test("stripMarkdown matches Python for every fixture", () => {
  for (const c of load("strip")) assert.equal(stripMarkdown(c.in), c.out, JSON.stringify(c.in).slice(0, 100));
});
test("sentenceChunks matches Python for every fixture", () => {
  for (const c of load("chunks")) assert.deepEqual(sentenceChunks(c.in), c.out, JSON.stringify(c.in).slice(0, 100));
});
test("a long sentence with no punctuation stays one chunk", () => {
  const s = "word ".repeat(80).trim();
  assert.deepEqual(sentenceChunks(s), [s]);
});
test("! and ? end sentences", () => {
  assert.deepEqual(sentenceChunks("Really? Yes! Done."), ["Really? Yes! Done."]);
  const q = "Is this the question that keeps going on and on? ".repeat(3).trim();
  const e = "Yes it is the answer that keeps going on and on! ".repeat(3).trim();
  assert.deepEqual(sentenceChunks(`${q} ${e}`, 160), [q, e]);
});
test("normalizeLogText collapses whitespace and caps at 2000 code points", () => {
  assert.equal(normalizeLogText("  a \n\t b  "), "a b");
  assert.equal(Array.from(normalizeLogText("😀".repeat(2500))).length, 2000);
});
test("GFM-only syntax stays literal, as in mistune (outputs taken from Python)", () => {
  assert.equal(stripMarkdown("- [ ] task one\n- [X] task two"), "[ ] task one. [X] task two.");
  assert.equal(stripMarkdown("a ~single~ tilde and ~~struck~~"), "a ~single~ tilde and struck");
  assert.equal(stripMarkdown("a | b\n--|--\n1 | 2"), "a | b --|-- 1 | 2");
});
