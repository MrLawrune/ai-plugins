import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSubPath, subPathFor } from "./route.ts";

test("parses overview, env, host, and guest sub-paths", () => {
  assert.deepEqual(parseSubPath(""), { view: "overview" });
  assert.deepEqual(parseSubPath("homelab"), { view: "env", slug: "homelab" });
  assert.deepEqual(parseSubPath("homelab/pve1"), { view: "host", slug: "homelab", node: "pve1", target: "homelab/pve1" });
  assert.deepEqual(parseSubPath("homelab/pve1/201/"), { view: "guest", slug: "homelab", node: "pve1", vmid: 201, target: "homelab/pve1/201" });
});

test("invalid sub-paths fall back to the overview", () => {
  for (const p of ["Home Lab", "homelab/../x", "homelab/pve1/abc", "a/b/1/2"]) assert.deepEqual(parseSubPath(p), { view: "overview" }, p);
});

test("subPathFor round-trips targets", () => {
  assert.equal(subPathFor("homelab/pve1/201"), "homelab/pve1/201");
  assert.equal(subPathFor(null), "");
});
