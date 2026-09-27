import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunAttrs } from "./run-attrs.ts";

test("parseRunAttrs accepts a well-formed run id", () => {
  assert.deepEqual(parseRunAttrs({ id: "run_abcdef" }), { id: "run_abcdef" });
});

test("parseRunAttrs rejects malformed or missing ids", () => {
  assert.equal(parseRunAttrs({ id: "abc" }), null);
  assert.equal(parseRunAttrs({}), null);
  assert.equal(parseRunAttrs({ id: "run_ab" }), null);
  assert.equal(parseRunAttrs({ id: "run_abc/../x1" }), null);
});
