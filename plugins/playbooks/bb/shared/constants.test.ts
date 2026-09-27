import { test } from "node:test";
import assert from "node:assert/strict";
import { BUDGETS, CHANNELS, ENV_KINDS, LIMITS, RETENTION_DAYS, RULES_MAX } from "./constants.ts";

test("constants match the spec", () => {
  assert.deepEqual([...ENV_KINDS], ["lab", "dev", "staging", "prod", "customer", "other"]);
  assert.equal(RULES_MAX, 4096);
  assert.equal(CHANNELS.changed, "playbooks:changed");
  assert.equal(CHANNELS.run, "playbooks:run");
  assert.equal(BUDGETS.addToChat, 4096);
  assert.equal(BUDGETS.investigate, 12288);
  assert.equal(LIMITS.readFile, 1_048_576);
  assert.equal(RETENTION_DAYS, 90);
});
