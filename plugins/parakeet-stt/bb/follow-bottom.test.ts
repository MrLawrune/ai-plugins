import { test } from "node:test";
import assert from "node:assert/strict";
import { nearBottom } from "./follow-bottom.ts";

test("at or near the bottom sticks; scrolled up does not", () => {
  assert.equal(nearBottom({ scrollTop: 92, scrollHeight: 200, clientHeight: 108 }), true);
  assert.equal(nearBottom({ scrollTop: 86, scrollHeight: 200, clientHeight: 108 }), true); // within slack
  assert.equal(nearBottom({ scrollTop: 40, scrollHeight: 200, clientHeight: 108 }), false);
  assert.equal(nearBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 108 }), true); // not scrollable
});
