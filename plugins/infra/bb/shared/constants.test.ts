import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLL_SECONDS } from "./constants.ts";

test("poll defaults are gentler for production and customer environments", () => {
  assert.deepEqual(DEFAULT_POLL_SECONDS, { lab: 10, dev: 10, staging: 30, prod: 60, customer: 60, other: 30 });
});
