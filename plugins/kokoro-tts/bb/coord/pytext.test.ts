import { test } from "node:test";
import assert from "node:assert/strict";
import { pyCollapse, pyStrip } from "./pytext.ts";
import { extractDirective } from "./turn.ts";

test("pyStrip trims Python whitespace, U+0085 included and U+FEFF not", () => {
  assert.equal(pyStrip("\x85\x1c a b 　\n"), "a b");
  assert.equal(pyStrip("﻿a﻿"), "﻿a﻿");
  assert.equal(pyStrip(" \t\n"), "");
  assert.equal(pyStrip(""), "");
});
test("pyCollapse turns each whitespace run into one space", () => {
  assert.equal(pyCollapse(" a\x85\x85b\t\n c "), " a b c ");
  assert.equal(pyCollapse("a﻿b"), "a﻿b");
});
test("a lone \\r is not a line break for directives", () => {
  assert.deepEqual(extractDirective('x\r::kokoro-tts{weight="speech" say="a"}'), [null, null]);
});
