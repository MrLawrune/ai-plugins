import { test } from "node:test";
import assert from "node:assert/strict";
import { safeHostClient, stripOverride } from "./host-client.ts";

test("stripOverride drops overrideCommand and keeps everything else", () => {
  assert.deepEqual(stripOverride({ controlHost: "web-01", repoPath: "/srv/example", overrideCommand: "rm -rf /" }), { controlHost: "web-01", repoPath: "/srv/example" });
});

test("stripOverride tolerates undefined, null, and non-objects", () => {
  for (const v of [undefined, null, "x", 3, ["overrideCommand"]]) assert.deepEqual(stripOverride(v), {});
});

test("the wrapped client forwards a stripped input and the options", async () => {
  const seen: unknown[][] = [];
  const client = safeHostClient({ call: async (...a: unknown[]) => { seen.push(a); return { ok: true }; } } as never);
  await client.call("probe", { controlHost: "web-01", repoPath: "/srv/example", overrideCommand: "echo hi" } as never, { hostId: "h1" });
  assert.deepEqual(seen, [["probe", { controlHost: "web-01", repoPath: "/srv/example" }, { hostId: "h1" }]]);
  await client.call("probe", undefined as never, { hostId: "h1" });
  assert.deepEqual(seen[1]![1], {});
});
