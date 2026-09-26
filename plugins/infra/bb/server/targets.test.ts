import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTarget, parseTarget } from "./targets.ts";

test("parses env, host, and guest targets", () => {
  assert.deepEqual(parseTarget("homelab"), { env: "homelab" });
  assert.deepEqual(parseTarget("homelab/pve1"), { env: "homelab", node: "pve1" });
  assert.deepEqual(parseTarget("homelab/pve1/201"), { env: "homelab", node: "pve1", vmid: 201 });
});

test("rejects malformed targets", () => {
  for (const bad of ["", "Home Lab", "homelab/", "homelab/pve1/abc", "homelab/pve1/201/x", "a/b/0", "../x", "homelab/../201"]) {
    assert.equal(parseTarget(bad), null, bad);
  }
});

test("format round-trips", () => {
  for (const s of ["homelab", "homelab/pve1", "homelab/pve1/201"]) assert.equal(formatTarget(parseTarget(s)!), s);
});
