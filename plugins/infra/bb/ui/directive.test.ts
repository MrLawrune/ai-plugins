import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDirectiveAttrs } from "./directive-attrs.ts";

test("guest and host directives resolve to targets", () => {
  assert.equal(parseDirectiveAttrs("guest", { env: "homelab", id: "pve1/201" }), "homelab/pve1/201");
  assert.equal(parseDirectiveAttrs("host", { env: "homelab", node: "pve1" }), "homelab/pve1");
});

test("missing or malformed attributes yield null", () => {
  assert.equal(parseDirectiveAttrs("guest", { id: "pve1/201" }), null);
  assert.equal(parseDirectiveAttrs("guest", { env: "homelab", id: "pve1/abc" }), null);
  assert.equal(parseDirectiveAttrs("guest", { env: "homelab", id: "201" }), null);
  assert.equal(parseDirectiveAttrs("guest", { env: "../x", id: "pve1/201" }), null);
  assert.equal(parseDirectiveAttrs("host", { env: "homelab", node: "pve1/201" }), null);
  assert.equal(parseDirectiveAttrs("host", { env: "homelab", node: "<script>" }), null);
});

import { targetFromParams } from "./directive-attrs.ts";

test("thread panel params accept only a well-formed target", () => {
  assert.equal(targetFromParams({ target: "homelab/pve1/201" }), "homelab/pve1/201");
  for (const bad of [null, "homelab", [], { target: 5 }, { target: "../../etc" }, { other: "x" }]) assert.equal(targetFromParams(bad), null);
});
