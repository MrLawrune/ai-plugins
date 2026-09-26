import { test } from "node:test";
import assert from "node:assert/strict";
import { dropUndefined } from "./json.ts";

test("RPC inputs drop undefined fields so they are valid JSON", () => {
  assert.deepEqual(dropUndefined({ envSlug: undefined, target: "homelab", limit: 100 }), { target: "homelab", limit: 100 });
  assert.deepEqual(dropUndefined({}), {});
});
